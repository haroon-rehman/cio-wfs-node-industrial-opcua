"use strict";

/**
 * Shared harness for the OPC UA client lifecycle tests (Wave 2 / MEM-006a).
 *
 * The real node is loaded from `opcua/102-opcuaclient.js` with `Module._load`
 * stubs for node-opcua and the Node-RED helpers, so the constructor's own
 * connect path, watchdog and close handler run unmodified. The harness records
 * the handlers registered through `node.on`, the mock clients (and their
 * sessions) that the node creates, and the intervals the node starts.
 *
 * `sourcePath` lets the negative control run the exact same tests against a
 * copy of the pre-fix source.
 */

const { EventEmitter } = require("node:events");
const Module = require("node:module");

const DEFAULT_CONFIG = {
  action: "read",
  endpoint: "endpoint",
  keepsessionalive: false,
  name: "client",
  time: 1,
  timeUnit: "s"
};

function createOpcUaClientHarness(options = {}) {
  const sourcePath = options.sourcePath ?? require.resolve("../../opcua/102-opcuaclient");
  const disconnectMode = options.disconnectMode ?? "callback";
  const connectMode = options.connectMode ?? "ok";

  const clients = [];
  const sessions = [];
  const trackedIntervals = new Set();
  let intervalCreations = 0;
  let intervalClears = 0;
  let trackingIntervals = false;

  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;

  const certificateManager = {
    async initialize() {},
    trustedFolder: "trusted",
    rejectedFolder: "rejected",
    crlFolder: "crl",
    issuersCertFolder: "issuers",
    issuersCrlFolder: "issuers-crl"
  };

  class MockSession {
    constructor() {
      this.sessionId = "active";
      this.closes = 0;
      this.closed = false;
    }

    async close() {
      this.closes += 1;
      this.closed = true;
    }

    terminate() {
      this.closed = true;
    }
  }

  class MockClient extends EventEmitter {
    constructor() {
      super();
      this.clientCertificateManager = certificateManager;
      this.disconnects = 0;
      this.disconnectCallbacks = 0;
      this.connected = false;
      /** Listener counts captured at the start of disconnect(). */
      this.listenersAtDisconnect = null;
    }

    async connect() {
      if (connectMode === "fail") {
        throw new Error("connect refused by test harness");
      }
      this.connected = true;
    }

    async createSession() {
      const session = new MockSession();
      sessions.push(session);
      return session;
    }

    /** Mirrors node-opcua's callback-style disconnect. */
    disconnect(callback) {
      this.disconnects += 1;
      this.listenersAtDisconnect = {
        backoff: this.listenerCount("backoff"),
        connection_reestablished: this.listenerCount("connection_reestablished"),
        start_reconnection: this.listenerCount("start_reconnection")
      };
      if (disconnectMode === "throw") {
        throw new Error("disconnect failed by test harness");
      }
      if (disconnectMode === "promise") {
        return Promise.resolve();
      }
      if (typeof callback === "function") {
        this.disconnectCallbacks += 1;
        callback();
      }
      return undefined;
    }
  }

  const opcua = {
    AttributeIds: {},
    DataType: { Null: 0, NodeId: 17 },
    MessageSecurityMode: { None: 1 },
    OPCUAClient: {
      create() {
        const client = new MockClient();
        clients.push(client);
        return client;
      }
    },
    SecurityPolicy: { None: "None" },
    TimestampsToReturn: {},
    UserTokenType: { Anonymous: 0, Certificate: 2, UserName: 1 }
  };

  const identity = (value) => value;
  const chalk = new Proxy(identity, { get: () => identity });
  const basics = {
    calc_milliseconds_by_time_and_unit: () => 300000,
    get_node_status: (status) => ({ fill: "green", shape: "dot", status })
  };
  const stubs = {
    "async": { queue: function () { return { push() {} }; } },
    "chalk": chalk,
    "flatted": { stringify: JSON.stringify },
    "lodash.clonedeep": (value) => value,
    "node-opcua": opcua,
    "node-opcua-client-crawler": { NodeCrawler: class {} },
    "node-opcua-crypto": {},
    "node-opcua-file-transfer": {},
    "./opcua-basics": basics,
    "./utils": { createClientCertificateManager: () => certificateManager }
  };

  const originalLoad = Module._load;
  let ClientNode = null;
  try {
    Module._load = function (request, parent, isMain) {
      if (Object.hasOwn(stubs, request)) {
        return stubs[request];
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    const registerClientNode = require(sourcePath);
    registerClientNode({
      nodes: {
        createNode(node) {
          node.statusCalls = [];
          node.__handlers = new Map();
          Object.assign(node, {
            debug() {},
            error() {},
            log() {},
            send() {},
            status(statusValue) {
              node.statusCalls.push(statusValue);
            },
            warn() {},
            /** EventEmitter-like registration so lifecycle handlers are reachable. */
            on(event, handler) {
              const registered = node.__handlers.get(event);
              if (registered) registered.push(handler);
              else node.__handlers.set(event, [handler]);
              return node;
            },
            removeListener(event, handler) {
              const registered = node.__handlers.get(event);
              if (!registered) return node;
              const index = registered.indexOf(handler);
              if (index >= 0) registered.splice(index, 1);
              return node;
            },
            emit(event, ...args) {
              for (const handler of node.__handlers.get(event) ?? []) handler(...args);
              return true;
            }
          });
          return node;
        },
        getNode() {
          return {
            endpoint: "opc.tcp://localhost:4840",
            login: false,
            none: true,
            securityMode: "None",
            securityPolicy: "None",
            usercert: false
          };
        },
        registerType(name, constructor) {
          if (name === "OpcUa-Client") ClientNode = constructor;
        }
      },
      settings: { verbose: false }
    });
  } finally {
    Module._load = originalLoad;
  }

  if (!ClientNode) {
    throw new Error("harness could not capture the OpcUa-Client constructor");
  }

  // Track only the intervals created while a node instance is being
  // constructed, so the test runner's own timers never pollute the count.
  global.setInterval = function trackedSetInterval(fn, delay, ...args) {
    const handle = realSetInterval(fn, delay, ...args);
    if (trackingIntervals) {
      trackedIntervals.add(handle);
      intervalCreations += 1;
    }
    return handle;
  };
  global.clearInterval = function trackedClearInterval(handle) {
    if (handle && trackedIntervals.delete(handle)) intervalClears += 1;
    return realClearInterval(handle);
  };

  function createNode(config = {}) {
    trackingIntervals = true;
    try {
      return new ClientNode({ ...DEFAULT_CONFIG, ...config });
    } finally {
      trackingIntervals = false;
    }
  }

  /** Waits for the constructor's asynchronous connect path to settle. */
  async function settleConnect(turns = 4) {
    // The connect path restarts the liveness watchdog, so keep interval
    // tracking on while it runs.
    trackingIntervals = true;
    try {
      for (let i = 0; i < turns; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    } finally {
      trackingIntervals = false;
    }
  }

  function closeHandler(node) {
    const registered = node.__handlers.get("close") ?? [];
    if (registered.length !== 1) {
      throw new Error(`expected exactly one close handler, found ${registered.length}`);
    }
    return registered[0];
  }

  /**
   * Invokes the node's close handler once and resolves when that invocation
   * calls its own `done`. Returns the number of done() calls it observed.
   */
  function invokeClose(node, timeoutMs = 5000) {
    const handler = closeHandler(node);
    return new Promise((resolve, reject) => {
      let doneCalls = 0;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`node close handler did not complete within ${timeoutMs} ms`));
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();

      const done = () => {
        doneCalls += 1;
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ doneCalls });
      };

      try {
        const returned = handler(done);
        if (returned && typeof returned.then === "function") {
          returned.catch((error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
          });
        }
      } catch (error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  return {
    ClientNode,
    clients,
    sessions,
    createNode,
    settleConnect,
    closeHandler,
    invokeClose,
    timerStats() {
      return {
        created: intervalCreations,
        cleared: intervalClears,
        active: trackedIntervals.size
      };
    },
    restore() {
      global.setInterval = realSetInterval;
      global.clearInterval = realClearInterval;
      for (const handle of trackedIntervals) realClearInterval(handle);
      trackedIntervals.clear();
    }
  };
}

module.exports = { createOpcUaClientHarness, DEFAULT_CONFIG };
