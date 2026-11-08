const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const test = require("node:test");

/**
 * R-02 / MEM-006 — the fake Node-RED runtime must behave like one.
 *
 * The OpcUa-Client constructor starts the liveness watchdog
 * (`start_liveness_watchdog()` -> `setInterval(liveness_check, 15_000)`,
 * opcua/102-opcuaclient.js:234-242) and stops it only from the Node-RED
 * `close` handler (opcua/102-opcuaclient.js:2796-2797). The previous harness
 * defined `on()` as a no-op, so that handler was never captured, the interval
 * stayed referenced and `node --test` never exited.
 *
 * The harness below therefore records handlers registered through `node.on`
 * and invokes the real `close` handler in `t.after`, so the test exercises the
 * node's own lifecycle teardown instead of cancelling timers directly.
 */

const CLOSE_TIMEOUT_MS = 5_000;

test("the connected OPC UA client retains its reconnection listeners", async (t) => {
  const clients = [];
  /** Handlers registered by the node under test, keyed by event name. */
  const handlers = new Map();
  const certificateManager = {
    async initialize() {},
    trustedFolder: "trusted",
    rejectedFolder: "rejected",
    crlFolder: "crl",
    issuersCertFolder: "issuers",
    issuersCrlFolder: "issuers-crl"
  };

  class MockClient extends EventEmitter {
    constructor() {
      super();
      this.clientCertificateManager = certificateManager;
      this.disconnects = 0;
    }

    async connect() {
      this.connected = true;
    }

    async createSession() {
      return {
        sessionId: "active",
        closes: 0,
        async close() {
          this.closes += 1;
        }
      };
    }

    /** Mirrors node-opcua's callback-style disconnect. */
    disconnect(callback) {
      this.disconnects += 1;
      if (typeof callback === "function") callback();
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
  Module._load = function (request, parent, isMain) {
    if (Object.hasOwn(stubs, request)) {
      return stubs[request];
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  let ClientNode;
  try {
    const registerClientNode = require("../opcua/102-opcuaclient");
    registerClientNode({
      nodes: {
        createNode(node) {
          Object.assign(node, {
            debug() {},
            error() {},
            send() {},
            status() {},
            warn() {},
            /** EventEmitter-like registration so lifecycle handlers are reachable. */
            on(event, handler) {
              const registered = handlers.get(event);
              if (registered) registered.push(handler);
              else handlers.set(event, [handler]);
              return node;
            },
            removeListener(event, handler) {
              const registered = handlers.get(event);
              if (!registered) return node;
              const index = registered.indexOf(handler);
              if (index >= 0) registered.splice(index, 1);
              return node;
            },
            emit(event, ...args) {
              for (const handler of handlers.get(event) ?? []) handler(...args);
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

  const lifecycle = { node: null, closeInvocations: 0 };

  /**
   * Runs the node's real close handler exactly once and waits for the
   * Node-RED `done` callback (or the returned promise). Cleanup runs even when
   * an assertion in the test body fails, because `t.after` always executes.
   */
  async function runNodeClose() {
    const closeHandler = (handlers.get("close") ?? [])[0];
    assert.ok(closeHandler, "the node must register a Node-RED close handler");
    assert.equal(lifecycle.closeInvocations, 0, "the close handler must not run twice");

    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`node close handler did not complete within ${CLOSE_TIMEOUT_MS} ms`));
      }, CLOSE_TIMEOUT_MS);

      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };

      try {
        const returned = closeHandler(done);
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

    lifecycle.closeInvocations += 1;
  }

  t.after(async () => {
    // Real lifecycle path: stops the liveness watchdog, closes the session and
    // disconnects the client (MEM-006a). The node must release its own client;
    // the test must not need to disconnect it.
    if (lifecycle.node) await runNodeClose();

    assert.equal(lifecycle.closeInvocations, 1, "the node close lifecycle must run exactly once");
    assert.equal(clients[0].disconnects, 1, "close must disconnect the client exactly once");
    assert.equal(lifecycle.node?.client, null, "close must release the client reference");
    assert.equal(
      clients[0].listenerCount("connection_reestablished"),
      0,
      "close must remove the reconnection listeners"
    );
  });

  const node = new ClientNode({
    action: "read",
    endpoint: "endpoint",
    keepsessionalive: false,
    name: "client",
    time: 1,
    timeUnit: "s"
  });
  lifecycle.node = node;

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(clients.length, 1, "connect must reuse the client that owns reconnection listeners");
  assert.strictEqual(node.client, clients[0]);
  assert.equal(node.client.listenerCount("backoff"), 1);
  assert.equal(node.client.listenerCount("start_reconnection"), 1);
  assert.equal(node.client.listenerCount("connection_reestablished"), 1);

  // The watchdog is the reason this suite used to hang; a real close must exist.
  assert.ok(handlers.has("close"), "the node must register a close handler so the watchdog can be released");
});
