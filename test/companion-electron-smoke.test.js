"use strict";

// Runs the real app under Xvfb and asserts what main really sent to the
// renderer. A release once shipped with every Clawd Alive animation broken by a
// wrapper in src/main.js that dropped sendToRenderer's return value, while the
// fake-based tests stayed green: only this level of test sees that wiring.
// The app is driven from test/fixtures/companion-smoke-hook.js.

const { before, describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { getDefaults } = require("../src/prefs");

const REPO = path.join(__dirname, "..");
const ELECTRON = path.join(REPO, "node_modules", "electron", "dist", "electron");
const HOOK = path.join(__dirname, "fixtures", "companion-smoke-hook.js");
const MAX_SOCKET_PATH = 100; // sun_path holds 108 bytes
const HOOK_TIMEOUT_MS = 70000; // the hook exits the app by itself by then
const WATCHDOG_MS = 90000; // the app hung past its own timeout
const LAUNCH_TIMEOUT_MS = 110000;

const REST = "clawd-idle-follow.svg";
const PETTING_IN = "clawd-alive-petting-in.svg";
const PETTING = "clawd-alive-petting.svg";
const PETTING_OUT = "clawd-alive-petting-out.svg";
const FAKE_NAP_IN = "clawd-alive-fake-nap-in.svg";
const FAKE_NAP = "clawd-alive-fake-nap.svg";

function onPath(name) {
  return String(process.env.PATH || "").split(path.delimiter)
    .some((dir) => dir && fs.existsSync(path.join(dir, name)));
}

function skipReason() {
  if (process.platform !== "linux") return "Linux only";
  if (!onPath("xvfb-run")) return "needs xvfb-run";
  if (!fs.existsSync(ELECTRON)) return "needs node_modules/electron/dist/electron";
  return false;
}

function shortTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cs-"));
  if (path.join(root, "run", "clawd-pointer.sock").length <= MAX_SOCKET_PATH) return root;
  fs.rmSync(root, { recursive: true, force: true });
  return fs.mkdtempSync("/tmp/cs-");
}

function seedPrefs(configHome, freeRoam) {
  const defaults = getDefaults();
  // No session may reach this app: the developer's real agents send their
  // events to any Clawd they can find.
  const agents = Object.fromEntries(Object.entries(defaults.agents)
    .map(([id, agent]) => [id, { ...agent, enabled: false, integrationInstalled: false }]));
  const dir = path.join(configHome, "clawd-on-desk");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "clawd-prefs.json"), JSON.stringify({
    ...defaults,
    agents,
    lang: "en",
    companionEnabled: true,
    companionPersonality: "balanced",
    companionAutonomy: true,
    companionInteractions: true,
    companionMischief: true,
    companionMemory: true,
    freeRoam,
    idleActivities: false,
  }));
}

function childEnv(root, plan) {
  const home = path.join(root, "home");
  const runtimeDir = path.join(root, "run");
  fs.mkdirSync(runtimeDir, { mode: 0o700 });
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_RUNTIME_DIR: runtimeDir,
    // Counts as XWayland together with --ozone-platform=x11, with no relaunch.
    XDG_SESSION_TYPE: "wayland",
    // Keeps the tray and notifications off the developer's real desktop.
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(runtimeDir, "no-bus")}`,
    CLAWD_SMOKE_OUT: path.join(root, "records.jsonl"),
    CLAWD_SMOKE_PLAN: plan,
    CLAWD_SMOKE_HARD_TIMEOUT_MS: String(HOOK_TIMEOUT_MS),
  };
  for (const name of ["ELECTRON_RUN_AS_NODE", "WAYLAND_DISPLAY", "DISPLAY", "XAUTHORITY", "NODE_TEST_CONTEXT"]) {
    delete env[name];
  }
  return env;
}

function readRecords(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

// Resolves with everything the hook recorded, even when the app failed: each
// test then says what it was missing.
function launch({ plan, freeRoam }) {
  const root = shortTempRoot();
  const env = childEnv(root, plan);
  seedPrefs(env.XDG_CONFIG_HOME, freeRoam);
  const startedAt = Date.now();
  return new Promise((resolve) => {
    // Its own process group, so the watchdog also reaches Xvfb and Electron.
    const child = spawn("xvfb-run", [
      "-a", "-s", "-screen 0 1920x1080x24",
      ELECTRON, "-r", HOOK, ".",
      "--no-sandbox", "--disable-gpu", "--ozone-platform=x11",
    ], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let log = "";
    const keepLog = (chunk) => { log = (log + chunk).slice(-4000); };
    child.stdout.on("data", keepLog);
    child.stderr.on("data", keepLog);
    const watchdog = setTimeout(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }, WATCHDOG_MS);
    const done = (code, signal, error) => {
      clearTimeout(watchdog);
      const records = readRecords(env.CLAWD_SMOKE_OUT);
      fs.rmSync(root, { recursive: true, force: true });
      resolve({ code, signal, error, log, records, ms: Date.now() - startedAt });
    };
    child.once("error", (err) => done(null, null, err));
    child.once("close", (code, signal) => done(code, signal, null));
  });
}

function describeRun(run) {
  const trace = run.records.filter((r) => r.type !== "tick")
    .map((r) => `${r.t} ${r.phase} ${r.type} ${r.file || r.kind || r.label || r.message || ""}`);
  return `exit ${run.code} signal ${run.signal} error ${run.error}\n${trace.join("\n")}\n--- app log\n${run.log}`;
}

function assertFinished(run) {
  assert.equal(run.code, 0, describeRun(run));
  assert.deepEqual(run.records.filter((r) => r.type === "failure" || r.type === "hard-timeout"), [], describeRun(run));
}

function recordsOf(run, phase) {
  const records = run.records.filter((r) => r.phase === phase);
  assert.ok(records.some((r) => r.type === "phase"), `phase ${phase} never ran\n${describeRun(run)}`);
  assert.deepEqual(records.filter((r) => r.type === "wait-timeout"), [], describeRun(run));
  return records;
}

const visualsOf = (records) => records.filter((r) => r.type === "visual").map((r) => r.file);
const gesturesOf = (records) => records.filter((r) => r.type === "gesture").map((r) => r.kind);
const count = (list, item) => list.filter((entry) => entry === item).length;

// expected appears in list in this order; anything may sit between.
function assertInOrder(list, expected, run) {
  let at = 0;
  for (const item of list) if (item === expected[at]) at += 1;
  assert.equal(at, expected.length,
    `expected ${expected.join(" -> ")} in ${list.join(" -> ")}\n${describeRun(run)}`);
}

function assertEndsAtRest(list, run) {
  assert.equal(list[list.length - 1], REST, `${list.join(" -> ")}\n${describeRun(run)}`);
}

function assertOneSessionEndingAfterStrokes(records, run) {
  const visuals = visualsOf(records);
  const gestures = gesturesOf(records);
  const stopped = records.findIndex((r) => r.type === "strokes-stopped");
  const firstOut = records.findIndex((r) => r.file === PETTING_OUT);
  const firstEnd = records.findIndex((r) => r.kind === "pet-end");
  assert.equal(count(gestures, "pet-start"), 1, describeRun(run));
  assert.equal(count(gestures, "pet-end"), 1, describeRun(run));
  assert.equal(count(visuals, PETTING_IN), 1, describeRun(run));
  assert.equal(count(visuals, PETTING_OUT), 1, describeRun(run));
  assert.ok(stopped >= 0, describeRun(run));
  assert.ok(firstEnd > stopped, `pet-end before the strokes stopped\n${describeRun(run)}`);
  assert.ok(firstOut > stopped, `petting-out before the strokes stopped\n${describeRun(run)}`);
}

const skip = skipReason();

describe("Clawd Alive visuals in the real app", { skip }, () => {
  let run;

  // One launch: the app's start is most of the cost.
  before(async () => {
    run = await launch({ plan: "petting,overshoot,fakeNap,mood", freeRoam: false });
  }, { timeout: LAUNCH_TIMEOUT_MS });

  test("the launch ran to the end", (t) => {
    t.diagnostic(`launch took ${run.ms} ms`);
    assertFinished(run);
  });

  test("petting eases in, loops, eases out and rests", () => {
    const records = recordsOf(run, "petting");
    const visuals = visualsOf(records);
    // The regression: without the send's result the runtime dropped the play,
    // so petting-in was sent again on every stroke and the loop never came.
    assertInOrder(visuals, [PETTING_IN, PETTING, PETTING_OUT, REST], run);
    assertEndsAtRest(visuals, run);
    assertOneSessionEndingAfterStrokes(records, run);
    assert.ok(visuals.indexOf(PETTING) > visuals.lastIndexOf(PETTING_IN), describeRun(run));
  });

  test("strokes overshooting the hit window stay a single session", () => {
    const records = recordsOf(run, "overshoot");
    const visuals = visualsOf(records);
    const gestures = gesturesOf(records);
    assert.ok(count(gestures, "pointer-leave") > 3, `the pointer never left the window\n${describeRun(run)}`);
    assertInOrder(visuals, [PETTING_IN, PETTING, PETTING_OUT, REST], run);
    assertEndsAtRest(visuals, run);
    assertOneSessionEndingAfterStrokes(records, run);
  });

  test("a scene advances from its intro to its next part", () => {
    const records = recordsOf(run, "fakeNap");
    assert.deepEqual(records.find((r) => r.type === "debug-play").result, { ok: true }, describeRun(run));
    assertInOrder(visualsOf(records), [FAKE_NAP_IN, FAKE_NAP], run);
  });

  test("a mood plays and returns to rest by itself", () => {
    const records = recordsOf(run, "mood");
    const visuals = visualsOf(records);
    assert.deepEqual(records.find((r) => r.type === "debug-play").result, { ok: true }, describeRun(run));
    assert.ok(visuals.some((file) => file !== REST), `no mood visual\n${describeRun(run)}`);
    assertEndsAtRest(visuals, run);
  });
});

describe("the pointer bridge in the real app", { skip }, () => {
  let run;

  before(async () => {
    run = await launch({ plan: "bridge", freeRoam: true });
  }, { timeout: LAUNCH_TIMEOUT_MS });

  test("the launch ran to the end", (t) => {
    t.diagnostic(`launch took ${run.ms} ms`);
    assertFinished(run);
  });

  test("the app connects to the extension's socket", () => {
    assert.ok(run.records.some((r) => r.type === "bridge-connected"), describeRun(run));
  });

  test("the runtime sees the streamed cursor, trusted", () => {
    const records = recordsOf(run, "bridge");
    const done = records.find((r) => r.type === "bridge-done");
    assert.ok(done, describeRun(run));
    const sent = new Set(done.streamed.map((p) => `${p.x},${p.y}`));
    const ticks = records.filter((r) => r.type === "tick");
    const first = ticks.findIndex((r) => sent.has(`${r.x},${r.y}`));
    assert.ok(first >= 0, `no tick had a streamed point\n${JSON.stringify(ticks.slice(0, 5))}`);
    const afterFirst = ticks.slice(first);
    assert.ok(afterFirst.length >= 5, `only ${afterFirst.length} ticks saw the stream`);
    assert.deepEqual(afterFirst.filter((r) => !r.cursorTrusted || !sent.has(`${r.x},${r.y}`)), []);
  });

  test("his eyes follow the stream", () => {
    const done = recordsOf(run, "bridge").find((r) => r.type === "bridge-done");
    assert.ok(done, describeRun(run));
    assert.ok(done.eyeMoves >= 5, `only ${done.eyeMoves} eye moves\n${describeRun(run)}`);
  });

  test("the streamed moves cancel no walk", (t) => {
    const records = recordsOf(run, "bridge");
    // Walks are random, but nothing else cancels one here: the desktop cursor
    // never moves and a cancelled pause would keep any walk from starting.
    if (!records.some((r) => r.type === "walk-seen")) t.diagnostic("no walk started during the stream");
    assert.deepEqual(records.filter((r) => r.type === "roam-cancelled"), [], describeRun(run));
  });
});
