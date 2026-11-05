"use strict";

// Drives the GNOME Shell extension's real socket server under gjs.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const hasGjs = spawnSync("gjs", ["--version"]).status === 0;
const FIXTURE = path.join(__dirname, "fixtures", "gjs-pointer-server.js");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer(t, mode = "moving") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-pointer-"));
  const socketPath = path.join(dir, "pointer.sock");
  const report = path.join(dir, "reads");
  const child = spawn("gjs", ["-m", FIXTURE, socketPath, report, mode], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => {
    child.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    child.stdout.once("data", resolve);
    child.once("exit", (code) => reject(new Error(`gjs exited ${code}`)));
  });
  return { child, socketPath, reads: () => (fs.existsSync(report) ? Number(fs.readFileSync(report, "utf8")) : 0) };
}

function connect(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    const client = { socket, text: "" };
    socket.on("data", (d) => { client.text += d; });
    socket.once("connect", () => resolve(client));
    socket.once("error", reject);
  });
}

test("the socket is private to the user", { skip: !hasGjs }, async (t) => {
  const { socketPath } = await startServer(t);
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
});

test("nothing reads the pointer until a client connects, and reading stops when it leaves", { skip: !hasGjs }, async (t) => {
  const server = await startServer(t);
  await wait(120);
  assert.equal(server.reads(), 0);
  const client = await connect(server.socketPath);
  await wait(150);
  assert.ok(server.reads() > 2);
  client.socket.destroy();
  await wait(120);
  const after = server.reads();
  await wait(120);
  assert.equal(server.reads(), after);
});

test("positions arrive as lines, only when they change", { skip: !hasGjs }, async (t) => {
  const moving = await startServer(t);
  const a = await connect(moving.socketPath);
  await wait(150);
  a.socket.destroy();
  const lines = a.text.trim().split("\n");
  assert.ok(lines.length > 2);
  assert.ok(lines.every((l) => /^\d+ 5 0$/.test(l)));

  const still = await startServer(t, "still");
  const b = await connect(still.socketPath);
  await wait(150);
  b.socket.destroy();
  assert.equal(b.text, "7 9 1\n");
});

test("a second client gets the current position right away", { skip: !hasGjs }, async (t) => {
  const still = await startServer(t, "still");
  const a = await connect(still.socketPath);
  await wait(80);
  const b = await connect(still.socketPath);
  await wait(80);
  assert.equal(b.text, "7 9 1\n");
  a.socket.destroy();
  b.socket.destroy();
});

test("a stale socket file does not stop it, and stopping removes the socket", { skip: !hasGjs }, async (t) => {
  const first = await startServer(t);
  first.child.kill("SIGKILL");
  await wait(50);
  assert.ok(fs.existsSync(first.socketPath), "a killed server leaves its socket behind");
  const dir = path.dirname(first.socketPath);
  const child = spawn("gjs", ["-m", FIXTURE, first.socketPath, path.join(dir, "r2"), "still"], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => child.kill("SIGKILL"));
  await new Promise((resolve) => child.stdout.once("data", resolve));
  const client = await connect(first.socketPath);
  await wait(60);
  assert.equal(client.text, "7 9 1\n");
  client.socket.destroy();
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(fs.existsSync(first.socketPath), false);
});
