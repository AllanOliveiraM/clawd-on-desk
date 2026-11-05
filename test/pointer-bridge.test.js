"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { createPointerBridge, defaultSocketPath, parseLine } = require("../src/pointer-bridge");

function fake(opts = {}) {
  const env = { sockets: [], timers: [], destroyed: 0 };
  const bridge = createPointerBridge({
    socketPath: "/run/x.sock",
    connect: () => {
      const s = new EventEmitter();
      s.destroy = () => { env.destroyed += 1; };
      env.sockets.push(s);
      return s;
    },
    setTimer: (fn, ms) => { const t = { fn, ms }; env.timers.push(t); return t; },
    clearTimer: (t) => { env.timers.splice(env.timers.indexOf(t), 1); },
    ...opts,
  });
  return { bridge, env };
}

test("parses only well-formed lines", () => {
  assert.deepEqual(parseLine("12 -34"), { x: 12, y: -34 });
  for (const bad of ["", "12", "12 34 56", "a b", "1.5 2"]) assert.equal(parseLine(bad), null);
});

test("the socket lives in the runtime directory, or nowhere", () => {
  assert.equal(defaultSocketPath({ XDG_RUNTIME_DIR: "/run/user/1000" }), "/run/user/1000/clawd-pointer.sock");
  assert.equal(defaultSocketPath({}), null);
});

test("inactive never connects", () => {
  const { bridge, env } = fake();
  assert.equal(bridge.getPoint(), null);
  assert.equal(env.sockets.length, 0);
});

test("no socket path means nothing to connect to", () => {
  const { bridge, env } = fake({ socketPath: null });
  bridge.setActive(true);
  assert.equal(env.sockets.length, 0);
  assert.equal(env.timers.length, 0);
});

test("keeps the newest complete position across chunks", () => {
  const { bridge, env } = fake();
  bridge.setActive(true);
  const s = env.sockets[0];
  s.emit("data", Buffer.from("10 20\n30 4"));
  assert.deepEqual(bridge.getPoint(), { x: 10, y: 20 });
  s.emit("data", Buffer.from("0\nnoise\n"));
  assert.deepEqual(bridge.getPoint(), { x: 30, y: 40 });
});

test("an endless line without a newline is dropped", () => {
  const { bridge, env } = fake();
  bridge.setActive(true);
  env.sockets[0].emit("data", "x".repeat(300));
  env.sockets[0].emit("data", "1 2\n");
  assert.deepEqual(bridge.getPoint(), { x: 1, y: 2 });
});

test("losing the connection forgets the point and retries", () => {
  const { bridge, env } = fake();
  bridge.setActive(true);
  env.sockets[0].emit("data", "1 2\n");
  env.sockets[0].emit("error", new Error("gone"));
  env.sockets[0].emit("close");
  assert.equal(bridge.getPoint(), null);
  assert.equal(env.timers.length, 1, "one retry for error + close");
  assert.equal(env.timers[0].ms, 5000);
  env.timers.shift().fn();
  assert.equal(env.sockets.length, 2);
});

test("a throwing connect retries instead of reaching the caller", () => {
  const { bridge, env } = fake({ connect: () => { throw new Error("nope"); } });
  assert.doesNotThrow(() => bridge.setActive(true));
  assert.equal(env.timers.length, 1);
});

test("turning off closes, forgets and stops retrying", () => {
  const { bridge, env } = fake();
  bridge.setActive(true);
  env.sockets[0].emit("data", "1 2\n");
  bridge.setActive(false);
  assert.equal(env.destroyed, 1);
  assert.equal(bridge.getPoint(), null);
  env.sockets[0].emit("close");
  assert.equal(env.timers.length, 0);
});

test("turning on twice keeps one connection, and dispose turns it off", () => {
  const { bridge, env } = fake();
  bridge.setActive(true);
  bridge.setActive(true);
  assert.equal(env.sockets.length, 1);
  bridge.dispose();
  assert.equal(env.destroyed, 1);
});

test("talks to a real unix socket", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-bridge-"));
  const socketPath = path.join(dir, "p.sock");
  const server = net.createServer((c) => c.write("100 200\n"));
  await new Promise((r) => server.listen(socketPath, r));
  const bridge = createPointerBridge({ socketPath });
  t.after(() => { bridge.dispose(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  bridge.setActive(true);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(bridge.getPoint(), { x: 100, y: 200 });
});
