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
  "companionMischief",
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
  const hitSends = [];
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
      if (id === "./companion-geometry") return require("../src/companion-geometry");
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
    sendToHitWin: (...args) => hitSends.push(JSON.parse(JSON.stringify(args))),
    console: { warn() {} },
    process: { platform: process.platform },
  };
  vm.runInNewContext(`${companionSource}\nthis._companionOut = _companion;\nthis._isPetGesturesEnabled = isPetGesturesEnabled;`, ctx);
  return {
    ctx, values, subscriptions, configureCalls, hitSends, runtime, runtimeOptions, storeOptions,
    out: ctx._companionOut, isPetGesturesEnabled: ctx._isPetGesturesEnabled,
  };
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
    mischief: false,
  }]);
  assert.deepEqual([...h.subscriptions.keys()].sort(), [...COMPANION_KEYS].sort());
  for (const key of COMPANION_KEYS) {
    const snapshot = {
      companionEnabled: true,
      companionPersonality: "playful",
      companionAutonomy: false,
      companionInteractions: false,
      companionMemory: true,
      companionMischief: true,
    };
    h.subscriptions.get(key)(snapshot[key], snapshot);
    assert.deepEqual(h.configureCalls[h.configureCalls.length - 1], {
      enabled: true,
      personality: "playful",
      autonomy: false,
      interactions: false,
      memory: true,
      mischief: true,
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
  assert.ok(roamCtx.includes("pickWalkVisual: () => _companion.pickWalkVisual(),"));
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

// ── Task 9: petting / hover gestures and click / drag observation ──

it("petGesturesEnabled is companionEnabled && companionInteractions", () => {
  const cases = [
    [false, false, false],
    [false, true, false],
    [true, false, false],
    [true, true, true],
  ];
  for (const [enabled, interactions, expected] of cases) {
    const h = companionHarness({ companionEnabled: enabled, companionInteractions: interactions });
    assert.equal(h.isPetGesturesEnabled(), expected, `${enabled}/${interactions}`);
    assert.equal(h.isPetGesturesEnabled({ companionEnabled: enabled, companionInteractions: interactions }), expected);
  }
});

it("hit-state-sync carries petGesturesEnabled after load", () => {
  const sync = slice("function syncHitStateAfterLoad() {", "\n}");
  assert.ok(sync.includes("petGesturesEnabled: isPetGesturesEnabled(),"));
  // The existing fields stay.
  assert.ok(sync.includes("currentState: _state.getCurrentState(),"));
  assert.ok(sync.includes("miniMode: _mini.getMiniMode(),"));
  assert.ok(sync.includes("dndEnabled: doNotDisturb,"));
});

it("toggling either gesture pref pushes hit-state-sync, other companion keys do not", () => {
  const h = companionHarness();
  const snapshot = {
    companionEnabled: true,
    companionPersonality: "balanced",
    companionAutonomy: true,
    companionInteractions: true,
    companionMemory: true,
  };
  for (const key of ["companionPersonality", "companionAutonomy", "companionMemory"]) {
    h.subscriptions.get(key)(snapshot[key], snapshot);
  }
  assert.deepEqual(h.hitSends, []);
  h.subscriptions.get("companionEnabled")(true, snapshot);
  h.subscriptions.get("companionInteractions")(false, { ...snapshot, companionInteractions: false });
  assert.deepEqual(h.hitSends, [
    ["hit-state-sync", { petGesturesEnabled: true }],
    ["hit-state-sync", { petGesturesEnabled: false }],
  ]);
  // configure() still runs for every key.
  assert.equal(h.configureCalls.length, 1 + 5);
});

it("pet interaction IPC reaches the companion and trusts only the hit window", () => {
  const registration = slice("registerPetInteractionIpc({", "registerPermissionIpc({");
  assert.ok(registration.includes(
    'handlePetGesture: (kind) => _companion.handleGesture(kind, kind === "hover-dwell" ? companionHoverInfo() : undefined),',
  ));
  assert.ok(registration.includes("noteCompanionEvent: (kind) => _companion.noteEvent(kind),"));
  assert.ok(registration.includes("noteCompanionDragEnd: (spot) => _companion.noteDragEnd(spot),"));
  assert.ok(registration.includes("hitWebContents: () => (hitWin && !hitWin.isDestroyed() ? hitWin.webContents : null),"));
  assert.ok(registration.includes("isDragLocked: () => petWindowRuntime.isDragLocked(),"));
  assert.ok(registration.includes("getThemeReactions: () => {"));
  assert.ok(registration.includes("getDisplayNearestPoint: (point) => screen.getDisplayNearestPoint(point),"));
});

// ── Clawd Mischief (Task 4) ──

it("main wires companionMischief", () => {
  // Pref default is true; only a strict true turns it on.
  const on = companionHarness({ companionEnabled: true, companionMischief: true });
  assert.equal(on.configureCalls[0].mischief, true);
  for (const value of [false, undefined, "true", 1]) {
    const h = companionHarness({ companionEnabled: true, companionMischief: value });
    assert.equal(h.configureCalls[0].mischief, false, String(value));
  }
  // Toggling the key reconfigures without touching the hit window.
  const h = companionHarness({ companionEnabled: true, companionMischief: true });
  const snapshot = {
    companionEnabled: true,
    companionPersonality: "balanced",
    companionAutonomy: true,
    companionInteractions: true,
    companionMemory: true,
    companionMischief: false,
  };
  h.subscriptions.get("companionMischief")(false, snapshot);
  assert.equal(h.configureCalls[h.configureCalls.length - 1].mischief, false);
  assert.deepEqual(h.hitSends, []);
  // petGesturesEnabled ignores the mischief switch.
  assert.equal(h.isPetGesturesEnabled({ ...snapshot, companionMischief: false }), true);
  // The runtime gets the platform for the close-button corner.
  assert.equal(typeof h.runtimeOptions.getPlatform, "function");
  assert.equal(h.runtimeOptions.getPlatform(), process.platform);
});

// ── Polish: hover catch bucket / cursor side (Ruling P3) ──

it("companionHoverInfo reads the cursor once in viewBox units of the displayed pose", () => {
  const fnSource = slice("function companionHoverInfo() {", "\n}\n");
  const calls = [];
  const geometry = require("../src/companion-geometry");
  const ctx = {
    hoverInfoFromPointer: geometry.hoverInfoFromPointer,
    getPetWindowBounds: () => ({ x: 100, y: 200, width: 173, height: 173 }),
    screen: { getCursorScreenPoint: () => { calls.push("cursor"); return { x: 120, y: 330 }; } },
    petWindowRuntime: {
      getAssetPointerPayload: (bounds, point) => {
        calls.push(["payload", bounds.x, point.x]);
        return { x: 1, y: 10, inside: true };
      },
    },
  };
  const companionHoverInfo = vm.runInNewContext(`${fnSource}\n}\ncompanionHoverInfo;`, ctx);
  assert.deepEqual(companionHoverInfo(), { bucket: "left", side: "left" });
  assert.deepEqual(calls, ["cursor", ["payload", 100, 120]]);
  ctx.petWindowRuntime.getAssetPointerPayload = () => null;
  assert.equal(companionHoverInfo(), null);
  ctx.screen.getCursorScreenPoint = () => { throw new Error("no screen"); };
  assert.equal(companionHoverInfo(), null);
});
