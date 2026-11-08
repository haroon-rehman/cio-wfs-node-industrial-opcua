"use strict";

/**
 * MEM-006a — OPC UA client production disconnect lifecycle.
 *
 * Regression coverage for the dead close branch. The pre-fix source contained
 * `if (!node.disconnecting) return done();` in the Node-RED close handler while
 * `node.disconnecting` was never initialised anywhere, so the guard always
 * returned early: the session was closed but the client was never disconnected,
 * its reconnection listeners were never removed, the command queue was never
 * cleared and the liveness watchdog could resurrect a client after close.
 *
 * Every scenario here drives the real node (see helpers/opcuaClientHarness.js)
 * and fails against the pre-fix source — that is the negative control run by
 * `npm run test:lifecycle:negative`.
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const { createOpcUaClientHarness } = require("./helpers/opcuaClientHarness");

/** Registers harness cleanup so a failing assertion cannot leak timers. */
function withHarness(t, options) {
  const harness = createOpcUaClientHarness({
    // The negative control points this at a copy of the pre-fix source.
    sourcePath: process.env.CIO_OPCUA_CLIENT_SOURCE,
    ...options
  });
  t.after(() => harness.restore());
  return harness;
}

async function connectedNode(harness, config) {
  const node = harness.createNode(config);
  await harness.settleConnect();
  return node;
}

/** True when the node reported the given status text (status is an object). */
function reportedStatus(node, text) {
  return node.statusCalls.some((status) => status && String(status.text).startsWith(text));
}

test("close while connected closes the session, disconnects the client and removes reconnection listeners", async (t) => {
  const harness = withHarness(t);
  const node = await connectedNode(harness);

  assert.equal(harness.clients.length, 1, "the node must connect once");
  const client = harness.clients[0];
  const session = harness.sessions[0];
  assert.strictEqual(node.client, client);
  assert.equal(client.listenerCount("connection_reestablished"), 1);

  const result = await harness.invokeClose(node);

  assert.equal(result.doneCalls, 1, "done() must be called exactly once");
  assert.equal(session.closes, 1, "the session must be closed on node close");
  assert.equal(client.disconnects, 1, "the client must be disconnected on node close");
  assert.equal(node.client, null, "the node must release its client reference");
  assert.equal(node.session, null, "the node must release its session reference");
  assert.deepEqual(
    client.listenersAtDisconnect,
    { backoff: 0, connection_reestablished: 0, start_reconnection: 0 },
    "reconnection listeners must be removed before disconnect"
  );
});

test("close during reconnection does not create a replacement client", async (t) => {
  const harness = withHarness(t);
  const node = await connectedNode(harness);
  const client = harness.clients[0];

  client.emit("start_reconnection");
  assert.ok(
    reportedStatus(node, "reconnect"),
    `the node must report the reconnect state, saw ${JSON.stringify(node.statusCalls)}`
  );
  assert.equal(client.listenerCount("start_reconnection"), 1, "the node must still be subscribed while connected");

  const result = await harness.invokeClose(node);

  assert.equal(result.doneCalls, 1);
  assert.equal(client.disconnects, 1, "a reconnecting client must still be disconnected");
  assert.equal(harness.clients.length, 1, "close must not create another client");
});

test("close after a failed connect still completes and disconnects the failed client", async (t) => {
  const harness = withHarness(t, { connectMode: "fail" });
  const node = harness.createNode();
  await harness.settleConnect();

  assert.ok(!node.session, "a failed connect must not leave a session behind");
  const client = harness.clients[0];
  assert.strictEqual(node.client, client, "a failed endpoint connect keeps the client for the retry path");
  assert.equal(client.disconnects, 0, "the retry path must not have disconnected yet");

  const result = await harness.invokeClose(node);

  assert.equal(result.doneCalls, 1, "close must still call done() after a failed connect");
  assert.equal(client.disconnects, 1, "close must disconnect the client left by the failed connect");
  assert.equal(node.client, null, "close must release the client reference");
});

test("a repeated close tears down once and completes every invocation", async (t) => {
  const harness = withHarness(t);
  const node = await connectedNode(harness);
  const client = harness.clients[0];

  const first = await harness.invokeClose(node);
  const second = await harness.invokeClose(node);

  assert.equal(first.doneCalls, 1);
  assert.equal(second.doneCalls, 1, "every close invocation must receive its own done()");
  assert.equal(client.disconnects, 1, "teardown must be idempotent");
});

test("concurrent close invocations share one teardown and each gets its own done", async (t) => {
  const harness = withHarness(t);
  const node = await connectedNode(harness);
  const client = harness.clients[0];

  const [first, second] = await Promise.all([
    harness.invokeClose(node),
    harness.invokeClose(node)
  ]);

  assert.equal(first.doneCalls, 1);
  assert.equal(second.doneCalls, 1);
  assert.equal(client.disconnects, 1, "concurrent closes must not disconnect twice");
});

test("a stale callback cannot recreate a client after close", async (t) => {
  const harness = withHarness(t);
  const node = await connectedNode(harness);
  const client = harness.clients[0];

  await harness.invokeClose(node);
  assert.equal(harness.clients.length, 1);

  // Anything that could previously start a new connection.
  client.emit("backoff", 1, 1000);
  client.emit("connection_reestablished");
  client.emit("start_reconnection");
  node.emit("error");
  node.emit("input", { topic: "ns=2;s=Demo", payload: [], action: "read" });
  await harness.settleConnect();

  assert.equal(harness.clients.length, 1, "no callback may create a client after close");
  assert.equal(node.client, null, "the node must stay closed");
});

test("close stops the liveness watchdog", async (t) => {
  const harness = withHarness(t);
  const node = await connectedNode(harness);

  const before = harness.timerStats();
  assert.ok(before.created >= 1, "the liveness watchdog must be started");
  assert.equal(before.active, 1, "exactly one liveness interval is expected while connected");

  await harness.invokeClose(node);

  const after = harness.timerStats();
  assert.equal(after.active, 0, "the liveness watchdog must be cleared on close");
  assert.ok(after.cleared >= 1, "close must clear the watchdog interval");
});

test("closing one node does not tear down another node's client", async (t) => {
  const harness = withHarness(t);
  const first = await connectedNode(harness, { name: "first" });
  const second = await connectedNode(harness, { name: "second" });

  assert.equal(harness.clients.length, 2, "each node owns its client");
  const [firstClient, secondClient] = harness.clients;

  await harness.invokeClose(first);

  assert.equal(firstClient.disconnects, 1, "the closed node's client is disconnected");
  assert.equal(secondClient.disconnects, 0, "the other node's client must stay connected");
  assert.strictEqual(second.client, secondClient, "the other node must keep its client");
  assert.strictEqual(first.client, null);
});

test("a redeploy creates an independent client for the new node", async (t) => {
  const harness = withHarness(t);
  const first = await connectedNode(harness, { name: "before-redeploy" });
  const firstClient = harness.clients[0];

  await harness.invokeClose(first);

  const second = await connectedNode(harness, { name: "after-redeploy" });

  assert.equal(harness.clients.length, 2, "a redeploy must create a fresh client");
  assert.equal(firstClient.disconnects, 1);
  assert.strictEqual(second.client, harness.clients[1]);
  assert.notStrictEqual(second.client, firstClient);
  assert.equal(harness.clients[1].disconnects, 0, "the replacement client must stay open");
  assert.equal(first.client, null, "the old node must stay closed");
});

test("close tolerates a disconnect implementation that throws", async (t) => {
  const harness = withHarness(t, { disconnectMode: "throw" });
  const node = await connectedNode(harness);

  const result = await harness.invokeClose(node);

  assert.equal(result.doneCalls, 1, "a throwing disconnect must not hang the redeploy");
});

test("close completes when disconnect reports through a promise", async (t) => {
  const harness = withHarness(t, { disconnectMode: "promise" });
  const node = await connectedNode(harness);

  const result = await harness.invokeClose(node);

  assert.equal(result.doneCalls, 1);
});
