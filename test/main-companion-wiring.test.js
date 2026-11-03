"use strict";

// Clawd Alive: source-slice checks for how main.js wires the companion arbiter
// into the existing idle machinery (same style as main-idle-activity-wiring).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { it } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8").replace(/\r\n/g, "\n");

function slice(startMarker, endMarker, from = 0) {
  const start = source.indexOf(startMarker, from);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `missing source between ${startMarker} and ${endMarker}`);
  return source.slice(start, end);
}

const COMPANION_KEYS = [
  "companionEnabled",
  "companionPersonality",
  "companionAutonomy",
  "companionInteractions",
  "companionMemory",
];

function gateHarness() {
  const gateSource = slice("function canPlayIdleActivity() {", '\nconst _idleActivity = require("./idle-activity")');
  const ctx = {
    win: { isDestroyed: () => false, isVisible: () => true },
    doNotDisturb: false,
    lowPowerIdlePaused: false,
    idlePaused: false,
    menuOpen: false,
    petWindowRuntime: {
      isDragLocked: () => false,
      isSettingsSizePreviewActive: () => false,
      isPetEffectivelyHidden: () => false,
    },
    _mini: { getMiniMode: () => false, getMiniTransitioning: () => false },
    anySessionInProgress: () => false,
    _perm: { hasVisiblePermissionBubbles: () => false },
    _state: { isSettingsPreviewVisual: () => false },
    pendingPermissions: [],
    getActiveTheme: () => ({ timings: { mouseSleepTimeout: 60000 } }),
    _tick: { _mouseStillSince: 1000 },
    Date: { now: () => 1000 },
  };
  const fns = vm.runInNewContext(`${gateSource}\n({ canPlayIdleActivity, isPetFreeForIdle });`, ctx);
  return { ctx, ...fns, gateSource };
}

it("canPlayIdleActivity delegates to isPetFreeForIdle", () => {
  const { ctx, canPlayIdleActivity, isPetFreeForIdle, gateSource } = gateHarness();
  assert.match(gateSource, /function canPlayIdleActivity\(\) \{\n\s+return isPetFreeForIdle\(\);\n\}/);
  assert.equal(canPlayIdleActivity(), true);
  assert.equal(isPetFreeForIdle(), true);
  for (const close of [
    (c) => { c.doNotDisturb = true; },
    (c) => { c._mini.getMiniTransitioning = () => true; },
    (c) => { c.anySessionInProgress = () => true; },
    (c) => { c.Date.now = () => 61000; },
  ]) {
    const h = gateHarness();
    close(h.ctx);
    assert.equal(h.isPetFreeForIdle(), false);
    assert.equal(h.canPlayIdleActivity(), false);
  }
  assert.ok(ctx);
});

const companionSource = slice("// ── Clawd Alive companion", "// Convenience getters for mini state");

function companionHarness(prefs = {}) {
  const values = {
    freeRoam: false,
    idleActivities: false,
    companionEnabled: false,
    companionPersonality: "balanced",
    companionAutonomy: true,
    companionInteractions: true,
    companionMemory: true,
    ...prefs,
  };
  const subscriptions = new Map();
  const configureCalls = [];
  let runtimeOptions = null;
  let storeOptions = null;
  const runtime = {
    // JSON round-trip: objects built inside the vm context have a foreign prototype.
    configure: (config) => configureCalls.push(JSON.parse(JSON.stringify(config))),
    isAnimating: () => false,
  };
  const ctx = {
    require: (id) => {
      if (id === "./companion-runtime") {
        return { createCompanionRuntime: (options) => { runtimeOptions = options; return runtime; } };
      }
      if (id === "./companion-store") {
        return { createCompanionStore: (options) => { storeOptions = options; return { kind: "store" }; } };
      }
      throw new Error(`unexpected require ${id}`);
    },
    path,
    app: { getPath: (name) => (name === "userData" ? "/user-data" : null) },
    screen: {
      getAllDisplays: () => [
        { id: 1, workArea: { x: 0, y: 0, width: 100, height: 100 } },
        { id: 2, workArea: { x: 100, y: 0, width: 50, height: 50 } },
      ],
    },
    _settingsController: {
      get: (key) => values[key],
      subscribeKey: (key, fn) => {
        assert.ok(!subscriptions.has(key), `duplicate subscription for ${key}`);
        subscriptions.set(key, fn);
      },
    },
    _roam: { isRoamAnimating: () => "roam-animating" },
    _state: { getCurrentState: () => "idle" },
    _tick: { restoreIdleVisual: () => "restored" },
    getActiveTheme: () => ({ name: "theme" }),
    isPetFreeForIdle: () => "free",
    isVisualGenerationCurrent: () => true,
    sendToRenderer: () => null,
    console: { warn() {} },
  };
  vm.runInNewContext(`${companionSource}\nthis._companionOut = _companion;`, ctx);
  return { ctx, values, subscriptions, configureCalls, runtime, runtimeOptions, storeOptions, out: ctx._companionOut };
}

it("companion is created with the shared gate, lazy mode and its own state file", () => {
  const h = companionHarness();
  assert.equal(h.out, h.runtime);
  assert.equal(h.runtimeOptions.canPlay, h.ctx.isPetFreeForIdle);
  assert.equal(h.runtimeOptions.store.kind, "store");
  assert.equal(h.storeOptions.filePath, path.join("/user-data", "companion-state.json"));
  assert.equal(h.runtimeOptions.isRoamAnimating(), "roam-animating");
  assert.equal(h.runtimeOptions.getCurrentState(), "idle");
  assert.equal(h.runtimeOptions.restoreIdleVisual(), "restored");
  assert.deepEqual(h.runtimeOptions.getTheme(), { name: "theme" });

  // Mode is read at call time from the committed prefs, roam first.
  const mode = h.runtimeOptions.getIdleMode;
  assert.equal(mode(), "none");
  h.values.idleActivities = true;
  assert.equal(mode(), "activities");
  h.values.freeRoam = true;
  assert.equal(mode(), "roam");

  const workArea = h.runtimeOptions.getDisplayWorkArea;
  assert.deepEqual(workArea(2), { x: 100, y: 0, width: 50, height: 50 });
  assert.equal(workArea(99), null);
  h.ctx.screen.getAllDisplays = () => { throw new Error("not ready"); };
  assert.equal(workArea(1), null);
});

it("companion subscribes to all companion keys", () => {
  const h = companionHarness({ companionEnabled: true, companionPersonality: "shy", companionMemory: false });
  assert.deepEqual(h.configureCalls, [{
    enabled: true,
    personality: "shy",
    autonomy: true,
    interactions: true,
    memory: false,
  }]);
  assert.deepEqual([...h.subscriptions.keys()].sort(), [...COMPANION_KEYS].sort());
  for (const key of COMPANION_KEYS) {
    const snapshot = {
      companionEnabled: true,
      companionPersonality: "playful",
      companionAutonomy: false,
      companionInteractions: false,
      companionMemory: true,
    };
    h.subscriptions.get(key)(snapshot[key], snapshot);
    assert.deepEqual(h.configureCalls[h.configureCalls.length - 1], {
      enabled: true,
      personality: "playful",
      autonomy: false,
      interactions: false,
      memory: true,
    }, key);
  }
});

it("before-quit disposes companion", () => {
  const quit = slice('app.on("before-quit", (event) => {', "\n  });");
  const dispose = quit.indexOf("_companion.dispose();");
  const flush = quit.indexOf("flushRuntimeStateToPrefs();");
  assert.ok(dispose > 0, "missing _companion.dispose()");
  assert.ok(flush > dispose, "dispose must run before flushRuntimeStateToPrefs()");
  assert.ok(quit.indexOf("quitCleanupStarted = true;") < dispose, "dispose runs once, inside the cleanup guard");
});

it("roam ctx isIdleActivityPlaying includes companion", () => {
  const roamCtx = slice("const _roamCtx = {", 'const _roam = require("./roam")');
  // The idle-activity line stays byte-identical; the companion beat gets its
  // own gate right next to it (both hold walks).
  assert.ok(roamCtx.includes("isIdleActivityPlaying: () => _idleActivity.isAnimating(),"));
  assert.ok(roamCtx.includes("isCompanionPlaying: () => _companion.isAnimating(),"));
  assert.ok(roamCtx.includes("getRoamDelayMs: (isFirst, baseMs) => _companion.getRoamDelayMs(isFirst, baseMs),"));
  assert.ok(roamCtx.includes("pickPreferredTarget: (args) => _companion.pickRoamTarget(args),"));
  assert.ok(roamCtx.includes("onWalkFinished: (info) => _companion.noteWalkFinished(info),"));
});

it("idle activities, tick and settings IPC reach the companion", () => {
  const controller = slice('const _idleActivity = require("./idle-activity")', "\n});");
  assert.ok(controller.includes("chooser: (args) => _companion.chooseIdleActivity(args),"));
  const tickCtx = slice("const _tickCtx = {", 'const _tick = require("./tick")');
  assert.ok(tickCtx.includes("get companion() { return _companion; }"));
  const settingsIpc = slice("const settingsIpcRuntime = registerSettingsIpc({", "\n});");
  // A getter: registerSettingsIpc runs before the companion is constructed,
  // and the reset handler reads options.companionRuntime at call time.
  assert.ok(settingsIpc.includes("get companionRuntime() { return _companion; },"));
});

it("does not reuse the telegram companion name", () => {
  assert.ok(!companionSource.includes("telegramCompanion"));
});
