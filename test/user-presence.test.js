"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createUserPresence, parseIdleTime } = require("../src/user-presence");

function make(opts = {}) {
  const env = { t: 100000, calls: 0, pending: [] };
  const presence = createUserPresence({
    enabled: true,
    now: () => env.t,
    run: (done) => { env.calls += 1; env.pending.push(done); },
    ...opts,
  });
  env.reply = (err, out) => env.pending.shift()(err, out);
  return { presence, env };
}

test("parses the gdbus answer", () => {
  assert.equal(parseIdleTime("(uint64 17377,)\n"), 17377);
  assert.equal(parseIdleTime("nope"), null);
  assert.equal(parseIdleTime(""), null);
});

test("disabled never runs anything", () => {
  const { presence, env } = make({ enabled: false });
  assert.equal(presence.sample(), null);
  assert.equal(env.calls, 0);
});

test("the first read has no answer yet, the next one does and keeps ageing", () => {
  const { presence, env } = make();
  assert.equal(presence.sample(), null);
  env.reply(null, "(uint64 1500,)");
  assert.equal(presence.sample(), 1500);
  env.t += 2000;
  assert.equal(presence.sample(), 3500);
});

test("asks at most once per refresh period and never twice in flight", () => {
  const { presence, env } = make();
  presence.sample();
  presence.sample();
  assert.equal(env.calls, 1, "in flight");
  env.reply(null, "(uint64 0,)");
  env.t += 2999;
  presence.sample();
  assert.equal(env.calls, 1, "still fresh");
  env.t += 1;
  presence.sample();
  assert.equal(env.calls, 2);
});

test("a stale sample is not an answer", () => {
  const { presence, env } = make();
  presence.sample();
  env.reply(null, "(uint64 1000,)");
  env.t += 10001;
  assert.equal(presence.sample(), null);
});

test("a clock stepping back drops the sample", () => {
  const { presence, env } = make();
  presence.sample();
  env.reply(null, "(uint64 1000,)");
  env.t -= 5000;
  assert.equal(presence.sample(), null);
});

test("three failures in a row stop asking for good", () => {
  const { presence, env } = make();
  for (let i = 0; i < 3; i++) {
    presence.sample();
    env.reply(new Error("no gnome"));
    env.t += 3000;
  }
  assert.equal(env.calls, 3);
  assert.equal(presence.sample(), null);
  assert.equal(env.calls, 3);
});

test("a good answer clears the failure count, and bad output counts as a failure", () => {
  const { presence, env } = make();
  for (const out of ["garbage", "garbage", "(uint64 5,)", "garbage", "garbage", "(uint64 5,)"]) {
    presence.sample();
    env.reply(null, out);
    env.t += 3000;
  }
  assert.equal(env.calls, 6);
});

test("a runner that throws counts as a failure and never reaches the caller", () => {
  const { presence } = make({ run: () => { throw new Error("spawn failed"); } });
  assert.doesNotThrow(() => presence.sample());
  assert.equal(presence.sample(), null);
});

// The default runner, against a fake gdbus on PATH: the tests above replace it.
function withPath(t, dir) {
  const original = process.env.PATH;
  process.env.PATH = dir;
  t.after(() => { process.env.PATH = original; });
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-presence-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function waitFor(check) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = check();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
}

test("the default runner asks Mutter's idle monitor through gdbus", { skip: process.platform === "win32" }, async (t) => {
  const dir = tempDir(t);
  const argvFile = path.join(dir, "argv");
  const script = path.join(dir, "gdbus");
  fs.writeFileSync(script, [
    "#!/bin/sh",
    `for arg in "$@"; do printf '%s\\n' "$arg" >> '${argvFile}'; done`,
    "echo '(uint64 1234,)'",
    "",
  ].join("\n"), { mode: 0o755 });
  // Keeps /bin and /usr/bin for the script's own shell.
  withPath(t, `${dir}${path.delimiter}${process.env.PATH}`);

  const presence = createUserPresence({ enabled: true });
  assert.equal(presence.sample(), null, "no answer yet");
  const idle = await waitFor(() => presence.sample());

  assert.ok(idle >= 1234 && idle < 1234 + 5000, `idle ${idle}`);
  assert.deepEqual(fs.readFileSync(argvFile, "utf8").trimEnd().split("\n"), [
    "call", "--session",
    "--dest", "org.gnome.Mutter.IdleMonitor",
    "--object-path", "/org/gnome/Mutter/IdleMonitor/Core",
    "--method", "org.gnome.Mutter.IdleMonitor.GetIdletime",
  ]);
});

test("a missing gdbus is no answer and never reaches the caller", async (t) => {
  withPath(t, tempDir(t));
  const presence = createUserPresence({ enabled: true });
  assert.doesNotThrow(() => presence.sample());
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(presence.sample(), null);
});
