"use strict";

const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const themeLoader = require("../src/theme-loader");
const { resolveIdleVisualChoice } = require("../src/idle-visual");
themeLoader.init(path.join(__dirname, "..", "src"));
const _defaultTheme = themeLoader.loadTheme("clawd");

function cloneTheme(theme) {
  return JSON.parse(JSON.stringify(theme));
}

function loadTickWithScreen(getCursorScreenPoint) {
  const electronPath = require.resolve("electron");
  const tickPath = require.resolve("../src/tick");
  const previousElectron = Object.prototype.hasOwnProperty.call(require.cache, electronPath)
    ? require.cache[electronPath]
    : null;
  const previousTick = Object.prototype.hasOwnProperty.call(require.cache, tickPath)
    ? require.cache[tickPath]
    : null;

  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
      screen: { getCursorScreenPoint },
    },
  };
  delete require.cache[tickPath];

  return {
    initTick: require("../src/tick"),
    restore() {
      if (previousElectron) require.cache[electronPath] = previousElectron;
      else delete require.cache[electronPath];
      if (previousTick) require.cache[tickPath] = previousTick;
      else delete require.cache[tickPath];
    },
  };
}

function makeCtx(theme, statesSeen) {
  return {
    theme,
    win: {
      setIgnoreMouseEvents() {},
      isDestroyed() { return false; },
      isVisible() { return true; },
      getBounds() { return { x: 0, y: 0, width: 120, height: 120 }; },
    },
    currentState: "idle",
    currentSvg: theme.states.idle[0],
    idlePaused: false,
    miniMode: false,
    miniTransitioning: false,
    dragLocked: false,
    menuOpen: false,
    isAnimating: false,
    mouseOverPet: false,
    miniPeeked: false,
    forceEyeResend: false,
    forceEyeResendBoostUntil: 0,
    startupRecoveryActive: false,
    sendToRenderer() {},
    sendToHitWin() {},
    getHitRectScreen() { return { left: 0, top: 0, right: 120, bottom: 120 }; },
    getObjRect() { return { x: 20, y: 20, w: 60, h: 60 }; },
    setState(state) {
      statesSeen.push(state);
      this.currentState = state;
    },
    applyState(state) {
      statesSeen.push(state);
      this.currentState = state;
    },
    miniPeekIn() {},
    miniPeekOut() {},
  };
}

describe("tick idle activity coordination", () => {
  let loader;
  let tickApi;
  let ctx;
  let calls;
  let activityTicks;
  let idleEntries;
  let cancels;
  let playing;
  let lastStateChangeAt;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    loader = loadTickWithScreen(() => ({ x: 300, y: 260 }));
    const theme = cloneTheme(_defaultTheme);
    theme.timings.mouseIdleTimeout = 100;
    theme.timings.mouseSleepTimeout = 100000;
    theme.idleAnimations = [{ file: "clawd-idle-look.svg", duration: 500 }];
    theme.idleEasterEggs = [];
    ctx = makeCtx(theme, []);
    calls = [];
    activityTicks = 0;
    idleEntries = 0;
    cancels = 0;
    playing = false;
    let generation = 0;
    ctx.sendToRenderer = (channel, state, svg, options) => {
      calls.push([channel, state, svg]);
      if (channel !== "state-change") return;
      lastStateChangeAt = Date.now();
      const request = { visualGeneration: ++generation };
      if (options && options.onLogicalSettlement) {
        options.onLogicalSettlement({ status: "committed", ...request });
      }
      return request;
    };
    ctx.isVisualGenerationCurrent = (value) => value === generation;
    ctx.idleActivity = {
      isAnimating: () => playing,
      tick: () => { activityTicks++; },
      noteIdleEntered: () => { idleEntries++; },
      cancel: () => { cancels++; },
    };
  });

  afterEach(() => {
    if (tickApi) tickApi.cleanup();
    tickApi = null;
    loader.restore();
    mock.timers.reset();
  });

  function start() {
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();
    mock.timers.tick(1);
  }

  function advance(ms) {
    for (let remaining = ms; remaining > 0; remaining -= 50) {
      mock.timers.tick(Math.min(50, remaining));
    }
  }

  function idleFiles() {
    return calls.filter(([channel]) => channel === "state-change").map(([, , svg]) => svg);
  }

  for (const activityPresent of [false, true]) {
    it(`keeps idle-look and eyes working with idle activities ${activityPresent ? "disabled" : "absent"}`, () => {
      if (!activityPresent) delete ctx.idleActivity;
      ctx.forceEyeResend = true;
      start();
      assert.ok(calls.some(([channel]) => channel === "eye-move"));
      advance(900);
      assert.deepStrictEqual(idleFiles(), ["clawd-idle-look.svg", ctx.theme.states.idle[0]]);
      if (activityPresent) assert.ok(activityTicks > 0);
    });
  }

  it("suppresses idle-look and eye messages during an idle activity while still servicing roam", () => {
    playing = true;
    ctx.forceEyeResend = true;
    let roamTicks = 0;
    ctx.roam = { tick() { roamTicks++; } };
    start();
    advance(1000);
    assert.deepStrictEqual(calls, []);
    assert.ok(activityTicks > 0);
    assert.ok(roamTicks > 0);
    playing = false;
    advance(500);
    assert.deepStrictEqual(idleFiles(), ["clawd-idle-look.svg"]);
  });

  it("does not tick idle activities while idle-look owns the visual", () => {
    start();
    advance(100);
    const ticksBeforeLook = activityTicks;
    advance(300);
    assert.deepStrictEqual(idleFiles(), ["clawd-idle-look.svg"]);
    advance(300);
    assert.equal(activityTicks, ticksBeforeLook);
    advance(300);
    assert.ok(activityTicks > ticksBeforeLook);
  });

  it("notifies each real idle entry but preserves the period after a walk", () => {
    ctx.currentState = "working";
    start();
    assert.equal(idleEntries, 0);
    function sample(state) {
      ctx.currentState = state;
      tickApi.scheduleSoon(0);
      mock.timers.tick(1);
    }
    sample("idle");
    assert.equal(idleEntries, 1);
    sample("idle");
    assert.equal(idleEntries, 1);
    sample("roam");
    sample("idle");
    assert.equal(idleEntries, 1, "automatic walks are part of the same idle period");
    sample("sleeping");
    sample("idle");
    assert.equal(idleEntries, 2);
    sample("attention");
    sample("idle");
    assert.equal(idleEntries, 3);
  });

  it("restores the selected rest visual and requests eyes again after 200ms", () => {
    ctx.getIdleVisualChoice = () => "clawd-idle-reading.svg";
    tickApi = loader.initTick(ctx);
    tickApi.restoreIdleVisual();
    assert.deepStrictEqual(calls, [["state-change", "idle", "clawd-idle-reading.svg"]]);
    assert.equal(ctx.forceEyeResend, false);
    mock.timers.tick(199);
    assert.equal(ctx.forceEyeResend, false);
    mock.timers.tick(1);
    assert.equal(ctx.forceEyeResend, true);
  });

  it("idle-look completion still restores rest and schedules the eye resend", () => {
    ctx.getIdleVisualChoice = () => "clawd-idle-reading.svg";
    start();
    while (idleFiles().length === 0) advance(50);
    const remaining = 500 - (Date.now() - lastStateChangeAt);
    // Keep the main loop from consuming the flag before it is inspected.
    ctx.win.isDestroyed = () => true;
    mock.timers.tick(remaining - 1);
    assert.deepStrictEqual(idleFiles(), ["clawd-idle-look.svg"]);
    mock.timers.tick(1);
    assert.deepStrictEqual(idleFiles(), ["clawd-idle-look.svg", "clawd-idle-reading.svg"]);
    assert.equal(ctx.forceEyeResend, false);
    mock.timers.tick(199);
    assert.equal(ctx.forceEyeResend, false);
    mock.timers.tick(1);
    assert.equal(ctx.forceEyeResend, true);
  });

  it("cleanup cancels idle activities without requesting a rest visual", () => {
    start();
    tickApi.cleanup();
    assert.equal(cancels, 1);
    assert.deepStrictEqual(idleFiles(), []);
    tickApi = null;
  });
});

describe("optional mini hover visuals", () => {
  let loader;
  let tickApi;
  let cursor;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    cursor = { x: 40, y: 40 };
    loader = loadTickWithScreen(() => ({ ...cursor }));
  });

  afterEach(() => {
    if (tickApi) tickApi.cleanup();
    loader.restore();
    mock.timers.reset();
  });

  function start(theme, state, peeked = false) {
    const states = [];
    const slides = [];
    const ctx = makeCtx(theme, states);
    ctx.miniMode = true;
    ctx.currentState = state;
    ctx.miniPeeked = peeked;
    ctx.miniSleepPeeked = peeked && state.startsWith("mini-sleep");
    ctx.miniPeekIn = (mode) => slides.push(["in", mode]);
    ctx.miniPeekOut = () => slides.push(["out"]);
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();
    mock.timers.tick(1);
    return { ctx, states, slides };
  }

  it("keeps sleep art unchanged for a theme without mini-sleep-peek", () => {
    const { ctx, states, slides } = start(cloneTheme(_defaultTheme), "mini-sleep");
    assert.deepStrictEqual(slides, [["in", "sleep"]]);
    assert.deepStrictEqual(states, []);
    cursor.x = 200;
    mock.timers.tick(60);
    assert.deepStrictEqual(slides, [["in", "sleep"], ["out"]]);
    assert.equal(ctx.currentState, "mini-sleep");
  });

  it("shows mini-sleep-peek only when declared, then restores mini-sleep", () => {
    const theme = cloneTheme(_defaultTheme);
    theme.miniMode.states["mini-sleep-peek"] = ["sleep-peek.svg"];
    const { ctx, states, slides } = start(theme, "mini-sleep");
    assert.deepStrictEqual(slides, [["in", "sleep"]]);
    assert.deepStrictEqual(states, ["mini-sleep-peek"]);
    cursor.x = 200;
    mock.timers.tick(60);
    assert.equal(ctx.currentState, "mini-sleep");
    assert.deepStrictEqual(states, ["mini-sleep-peek", "mini-sleep"]);
  });

  it("does not replay mini-peek while held, and leaves to mini-idle", () => {
    const theme = cloneTheme(_defaultTheme);
    theme.miniMode.states["mini-peek-hold"] = ["peek-hold.svg"];
    const { ctx, states, slides } = start(theme, "mini-peek-hold", true);
    assert.deepStrictEqual(slides, []);
    cursor.x = 200;
    mock.timers.tick(60);
    assert.deepStrictEqual(slides, [["out"]]);
    assert.deepStrictEqual(states, ["mini-idle"]);
    assert.equal(ctx.miniPeeked, false);
  });

  it("cancels a pending slide when menu, drag, or mini transition blocks hover", () => {
    for (const blocker of ["menuOpen", "dragLocked", "miniTransitioning"]) {
      const theme = cloneTheme(_defaultTheme);
      const { ctx, slides } = start(theme, "mini-idle");
      let cancelled = 0;
      ctx.cancelPendingMiniPeek = () => { cancelled++; };
      ctx[blocker] = true;
      mock.timers.tick(60);
      assert.equal(cancelled, 1, blocker);
      assert.deepStrictEqual(slides, [["in", "peek"]]);
      tickApi.cleanup();
      tickApi = null;
    }
  });
});

describe("tick sleepSequence mode", () => {
  let cursor;
  let loader;
  let tickApi;
  let ctx;
  let statesSeen;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    cursor = { x: 40, y: 40 };
    loader = loadTickWithScreen(() => ({ ...cursor }));
    statesSeen = [];
  });

  afterEach(() => {
    if (tickApi) tickApi.cleanup();
    if (loader) loader.restore();
    mock.timers.reset();
    tickApi = null;
    ctx = null;
  });

  it("direct mode goes straight to sleeping after mouseSleepTimeout", () => {
    const theme = cloneTheme(_defaultTheme);
    theme.sleepSequence = { mode: "direct" };
    theme.timings.mouseIdleTimeout = 1000;
    theme.timings.mouseSleepTimeout = 60;

    ctx = makeCtx(theme, statesSeen);
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    for (const step of [50, 50, 50, 50]) mock.timers.tick(step);
    assert.deepStrictEqual(statesSeen, ["sleeping"]);
  });

  it("full mode keeps the yawning entry path", () => {
    const theme = cloneTheme(_defaultTheme);
    theme.sleepSequence = { mode: "full" };
    theme.timings.mouseIdleTimeout = 1000;
    theme.timings.mouseSleepTimeout = 60;

    ctx = makeCtx(theme, statesSeen);
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    for (const step of [50, 50, 50, 50, 50, 50, 50, 50, 50]) mock.timers.tick(step);
    assert.deepStrictEqual(statesSeen, ["yawning"]);
  });
});

describe("tick mini hover", () => {
  let cursor;
  let loader;
  let tickApi;
  let ctx;
  let statesSeen;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    cursor = { x: 40, y: 40 };
    loader = loadTickWithScreen(() => ({ ...cursor }));
    statesSeen = [];
  });

  afterEach(() => {
    if (tickApi) tickApi.cleanup();
    if (loader) loader.restore();
    mock.timers.reset();
    tickApi = null;
    ctx = null;
  });

  it("enters mini-peek from mini-idle when the cursor moves over the pet", () => {
    const theme = cloneTheme(_defaultTheme);
    let peekInCalls = 0;

    ctx = makeCtx(theme, statesSeen);
    ctx.miniMode = true;
    ctx.currentState = "mini-idle";
    ctx.miniPeekIn = () => { peekInCalls++; };

    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();
    mock.timers.tick(60);

    assert.equal(peekInCalls, 1);
    assert.deepStrictEqual(statesSeen, ["mini-peek"]);
  });

  it("does not enter mini-peek when the cursor is outside the seam-clipped hit rect", () => {
    const theme = cloneTheme(_defaultTheme);
    let peekInCalls = 0;

    cursor = { x: 130, y: 40 };
    ctx = makeCtx(theme, statesSeen);
    ctx.miniMode = true;
    ctx.currentState = "mini-idle";
    ctx.getHitRectScreen = () => ({ left: 0, top: 0, right: 100, bottom: 120 });
    ctx.miniPeekIn = () => { peekInCalls++; };

    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();
    mock.timers.tick(60);

    assert.equal(peekInCalls, 0);
    assert.equal(ctx.mouseOverPet, false);
    assert.deepStrictEqual(statesSeen, []);
  });

  it("returns to mini-idle when the cursor leaves mini-peek", () => {
    const theme = cloneTheme(_defaultTheme);
    let peekOutCalls = 0;

    cursor = { x: 400, y: 400 };
    ctx = makeCtx(theme, statesSeen);
    ctx.miniMode = true;
    ctx.currentState = "mini-peek";
    ctx.mouseOverPet = true;
    ctx.miniPeekOut = () => { peekOutCalls++; };

    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();
    mock.timers.tick(60);

    assert.equal(peekOutCalls, 1);
    assert.equal(ctx.miniPeeked, false);
    assert.deepStrictEqual(statesSeen, ["mini-idle"]);
  });
});

describe("tick Cloudling pointer bridge", () => {
  let cursor;
  let loader;
  let tickApi;
  let ctx;
  let statesSeen;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    cursor = { x: 40, y: 50 };
    loader = loadTickWithScreen(() => ({ ...cursor }));
    statesSeen = [];
  });

  afterEach(() => {
    if (tickApi) tickApi.cleanup();
    if (loader) loader.restore();
    mock.timers.reset();
    tickApi = null;
    ctx = null;
  });

  it("sends viewBox pointer payloads for idle", () => {
    const theme = cloneTheme(_defaultTheme);
    const pointers = [];

    ctx = makeCtx(theme, statesSeen);
    ctx.getAssetPointerPayload = (_bounds, point) => ({
      x: point.x / 10,
      y: point.y / 10,
      inside: true,
    });
    ctx.sendToRenderer = (channel, payload) => {
      if (channel === "cloudling-pointer") pointers.push(payload);
    };

    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();
    mock.timers.tick(1);

    assert.deepStrictEqual(pointers, [{ x: 4, y: 5, inside: true }]);
  });

  it("keeps pointer bridge active outside the asset rect", () => {
    const theme = cloneTheme(_defaultTheme);
    const pointers = [];

    ctx = makeCtx(theme, statesSeen);
    ctx.miniMode = true;
    ctx.currentState = "mini-peek";
    ctx.currentSvg = "cloudling-mini-idle.svg";
    ctx.isAnimating = true;
    ctx.getAssetPointerPayload = (_bounds, point) => ({
      x: point.x,
      y: point.y,
      inside: false,
    });
    ctx.sendToRenderer = (channel, payload) => {
      if (channel === "cloudling-pointer") pointers.push(payload);
    };

    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();
    mock.timers.tick(60);

    assert.deepStrictEqual(pointers, [{ x: 40, y: 50, inside: true }]);
  });
});

describe("tick eye tracking preference (#1276)", () => {
  let cursor;
  let loader;
  let tickApi;
  let ctx;
  let statesSeen;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    cursor = { x: 40, y: 50 };
    loader = loadTickWithScreen(() => ({ ...cursor }));
    statesSeen = [];
  });

  afterEach(() => {
    if (tickApi) tickApi.cleanup();
    if (loader) loader.restore();
    mock.timers.reset();
    tickApi = null;
    ctx = null;
  });

  function pointerAwareCtx(theme, channels) {
    ctx = makeCtx(theme, statesSeen);
    ctx.eyeTrackingEnabled = true;
    ctx.getAssetPointerPayload = (_bounds, point) => ({
      x: point.x / 10,
      y: point.y / 10,
      inside: true,
    });
    ctx.sendToRenderer = (channel, ...args) => {
      if (channel === "eye-move") channels.eyeMoves.push(args);
      if (channel === "cloudling-pointer") channels.pointers.push(args[0]);
    };
    return ctx;
  }

  it("suppresses eye-move and pointer-bridge IPC while disabled", () => {
    const theme = cloneTheme(_defaultTheme);
    const channels = { eyeMoves: [], pointers: [] };

    pointerAwareCtx(theme, channels);
    ctx.eyeTrackingEnabled = false;
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    cursor = { x: 300, y: 300 };
    mock.timers.tick(100);
    cursor = { x: 301, y: 301 };
    mock.timers.tick(100);

    assert.deepStrictEqual(channels.eyeMoves, []);
    assert.deepStrictEqual(channels.pointers, []);
  });

  it("keeps the dizzy gesture alive while eye tracking is disabled", () => {
    const theme = cloneTheme(_defaultTheme);
    theme.states.dizzy = ["clawd-dizzy.svg"];
    theme.timings.autoReturn = theme.timings.autoReturn || {};
    theme.timings.autoReturn.dizzy = 6000;
    theme.timings.mouseIdleTimeout = 100000;
    theme.timings.mouseSleepTimeout = 100000;
    const channels = { eyeMoves: [], pointers: [] };

    pointerAwareCtx(theme, channels);
    ctx.eyeTrackingEnabled = false;
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    const obj = { x: 20, y: 20, w: 60, h: 60 };
    const cx = obj.x + obj.w * theme.eyeTracking.eyeRatioX;
    const cy = obj.y + obj.h * theme.eyeTracking.eyeRatioY;
    for (let i = 0; i < 36; i++) {
      const a = i * (Math.PI / 6);
      cursor.x = cx + 40 * Math.cos(a);
      cursor.y = cy + 40 * Math.sin(a);
      mock.timers.tick(100);
    }

    assert.ok(statesSeen.includes("dizzy"), `expected dizzy, saw ${JSON.stringify(statesSeen)}`);
    assert.deepStrictEqual(channels.eyeMoves, []);
  });

  it("skips the eye math entirely on themes without dizzy while disabled", () => {
    const theme = cloneTheme(_defaultTheme);
    delete theme.states.dizzy;
    if (theme.timings.autoReturn) delete theme.timings.autoReturn.dizzy;
    let objRectCalls = 0;
    const channels = { eyeMoves: [], pointers: [] };

    pointerAwareCtx(theme, channels);
    ctx.eyeTrackingEnabled = false;
    ctx.getObjRect = (bounds) => {
      objRectCalls += 1;
      return { x: 20, y: 20, w: 60, h: 60 };
    };
    ctx.forceEyeResend = true;
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    cursor = { x: 300, y: 300 };
    mock.timers.tick(100);

    assert.equal(objRectCalls, 0);
    assert.equal(ctx.forceEyeResend, false);
    assert.deepStrictEqual(channels.eyeMoves, []);
  });

  it("handleEyeTrackingPreferenceChange(false) parks the gaze and resets the pointer bridge", () => {
    const theme = cloneTheme(_defaultTheme);
    const channels = { eyeMoves: [], pointers: [] };

    pointerAwareCtx(theme, channels);
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    mock.timers.tick(1);
    cursor = { x: 300, y: 300 };
    mock.timers.tick(100);
    assert.ok(channels.eyeMoves.length > 0, "expected follow IPC while enabled");

    ctx.eyeTrackingEnabled = false;
    tickApi.handleEyeTrackingPreferenceChange(false);
    assert.deepStrictEqual(channels.eyeMoves[channels.eyeMoves.length - 1], [0, 0]);
    assert.deepStrictEqual(channels.pointers[channels.pointers.length - 1], { x: 0, y: 0, inside: false });

    cursor = { x: 301, y: 301 };
    mock.timers.tick(100);
    const countAfterPark = channels.eyeMoves.length;
    cursor = { x: 302, y: 302 };
    mock.timers.tick(100);
    assert.equal(channels.eyeMoves.length, countAfterPark);
  });

  it("resends the Cloudling pointer after disabling and re-enabling without cursor movement", () => {
    const theme = cloneTheme(themeLoader.loadTheme("cloudling"));
    const channels = { eyeMoves: [], pointers: [] };

    pointerAwareCtx(theme, channels);
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();
    mock.timers.tick(1);
    assert.deepStrictEqual(channels.pointers, [{ x: 4, y: 5, inside: true }]);

    ctx.eyeTrackingEnabled = false;
    tickApi.handleEyeTrackingPreferenceChange(false);
    mock.timers.tick(100);
    assert.deepStrictEqual(channels.pointers, [
      { x: 4, y: 5, inside: true },
      { x: 0, y: 0, inside: false },
    ]);

    ctx.eyeTrackingEnabled = true;
    tickApi.handleEyeTrackingPreferenceChange(true);
    mock.timers.tick(100);
    assert.deepStrictEqual(channels.pointers, [
      { x: 4, y: 5, inside: true },
      { x: 0, y: 0, inside: false },
      { x: 4, y: 5, inside: true },
    ]);
  });

  it("handleEyeTrackingPreferenceChange(true) resends the live position without cursor movement", () => {
    const theme = cloneTheme(_defaultTheme);
    const channels = { eyeMoves: [], pointers: [] };

    pointerAwareCtx(theme, channels);
    ctx.eyeTrackingEnabled = false;
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    cursor = { x: 300, y: 300 };
    mock.timers.tick(100);
    assert.deepStrictEqual(channels.eyeMoves, []);

    ctx.eyeTrackingEnabled = true;
    tickApi.handleEyeTrackingPreferenceChange(true);
    mock.timers.tick(100);

    assert.equal(channels.eyeMoves.length, 1);
    assert.equal(ctx.forceEyeResend, false);
  });
});

describe("tick adaptive polling", () => {
  let cursor;
  let cursorCalls;
  let loader;
  let tickApi;
  let ctx;
  let statesSeen;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    cursor = { x: 40, y: 40 };
    cursorCalls = 0;
    loader = loadTickWithScreen(() => {
      cursorCalls++;
      return { ...cursor };
    });
    statesSeen = [];
  });

  afterEach(() => {
    if (tickApi) tickApi.cleanup();
    if (loader) loader.restore();
    mock.timers.reset();
    tickApi = null;
    ctx = null;
  });

  it("backs off idle cursor polling below the old fixed 20Hz rate", () => {
    const theme = cloneTheme(_defaultTheme);

    ctx = makeCtx(theme, statesSeen);
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    mock.timers.tick(3000);

    assert.ok(cursorCalls > 0);
    assert.ok(cursorCalls < 45, `expected fewer than 45 polls, got ${cursorCalls}`);
  });

  it("uses a bounded one-second cursor probe while normal idle is low-power paused", () => {
    const theme = cloneTheme(_defaultTheme);

    ctx = makeCtx(theme, statesSeen);
    ctx.lowPowerIdleMode = true;
    ctx.lowPowerIdlePaused = true;
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    for (let elapsed = 0; elapsed < 10000; elapsed += 100) mock.timers.tick(100);

    assert.ok(cursorCalls >= 9, `expected at least 9 polls in 10s while paused, got ${cursorCalls}`);
    assert.ok(cursorCalls <= 11, `expected at most 11 polls in 10s while paused, got ${cursorCalls}`);
  });

  it("keeps non-paused idle polling materially above the low-power paused rate", () => {
    const theme = cloneTheme(_defaultTheme);

    ctx = makeCtx(theme, statesSeen);
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    for (let elapsed = 0; elapsed < 10000; elapsed += 100) mock.timers.tick(100);

    assert.ok(cursorCalls > 30, `expected more than 30 polls in 10s while not paused, got ${cursorCalls}`);
  });

  it("uses a bounded low-power polling rate for mini-idle", () => {
    const theme = cloneTheme(_defaultTheme);

    ctx = makeCtx(theme, statesSeen);
    ctx.currentState = "mini-idle";
    ctx.currentSvg = "clawd-mini-idle.svg";
    ctx.miniMode = true;
    ctx.lowPowerIdlePaused = true;
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    mock.timers.tick(10000);

    assert.ok(cursorCalls > 0);
    assert.ok(cursorCalls <= 6, `expected at most 6 polls in 10s while mini-idle paused, got ${cursorCalls}`);
  });

  it("does not throttle mini-peek with the low-power paused idle delay", () => {
    const theme = cloneTheme(_defaultTheme);

    ctx = makeCtx(theme, statesSeen);
    ctx.currentState = "mini-peek";
    ctx.currentSvg = "clawd-mini-idle.svg";
    ctx.miniMode = true;
    ctx.lowPowerIdlePaused = true;
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    for (let elapsed = 0; elapsed < 500; elapsed += 50) mock.timers.tick(50);

    assert.ok(cursorCalls >= 8, `expected fast mini-peek polling, got ${cursorCalls}`);
  });

  it("does not throttle drag, menu-open, or mini-transition paths while low-power paused", () => {
    const theme = cloneTheme(_defaultTheme);
    const cases = [
      ["drag", { dragLocked: true }],
      ["menu", { menuOpen: true }],
      ["transition", { miniTransitioning: true }],
    ];

    for (const [name, patch] of cases) {
      if (tickApi) tickApi.cleanup();
      cursorCalls = 0;
      ctx = makeCtx(theme, statesSeen);
      Object.assign(ctx, patch);
      ctx.lowPowerIdlePaused = true;
      tickApi = loader.initTick(ctx);
      tickApi.startMainTick();

      for (let elapsed = 0; elapsed < 500; elapsed += 50) mock.timers.tick(50);

      assert.ok(cursorCalls >= 8, `expected fast polling for ${name}, got ${cursorCalls}`);
    }
  });

  it("forwards new mouse movement within one second while low-power paused", () => {
    const theme = cloneTheme(_defaultTheme);
    const eyeMoves = [];

    ctx = makeCtx(theme, statesSeen);
    ctx.lowPowerIdleMode = true;
    ctx.lowPowerIdlePaused = true;
    ctx.sendToRenderer = (channel, ...args) => {
      if (channel === "eye-move") eyeMoves.push(args);
    };
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    mock.timers.tick(1);
    cursor = { x: 95, y: 70 };
    mock.timers.tick(1000);

    assert.equal(eyeMoves.length, 1);
  });

  it("keeps eye-position dedup active before low-power pause engages", () => {
    const theme = cloneTheme(_defaultTheme);
    const eyeMoves = [];

    ctx = makeCtx(theme, statesSeen);
    ctx.lowPowerIdleMode = true;
    ctx.lowPowerIdlePaused = false;
    ctx.sendToRenderer = (channel, ...args) => {
      if (channel === "eye-move") eyeMoves.push(args);
    };
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    mock.timers.tick(1);
    cursor = { x: 1000, y: 1000 };
    mock.timers.tick(100);
    cursor = { x: 1001, y: 1001 };
    mock.timers.tick(100);

    assert.equal(eyeMoves.length, 1);
  });

  it("keeps eye-move IPC suppressed while the mouse remains still in low-power pause", () => {
    const theme = cloneTheme(_defaultTheme);
    const eyeMoves = [];

    ctx = makeCtx(theme, statesSeen);
    ctx.lowPowerIdleMode = true;
    ctx.lowPowerIdlePaused = true;
    ctx.sendToRenderer = (channel, ...args) => {
      if (channel === "eye-move") eyeMoves.push(args);
    };
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    for (let elapsed = 0; elapsed < 5000; elapsed += 100) mock.timers.tick(100);

    assert.deepStrictEqual(eyeMoves, []);
  });

  it("suppresses passive Cloudling pointer IPC while low-power paused", () => {
    const theme = cloneTheme(_defaultTheme);
    const pointers = [];

    ctx = makeCtx(theme, statesSeen);
    ctx.lowPowerIdlePaused = true;
    ctx.getAssetPointerPayload = (_bounds, point) => ({
      x: point.x,
      y: point.y,
      inside: true,
    });
    ctx.sendToRenderer = (channel, payload) => {
      if (channel === "cloudling-pointer") pointers.push(payload);
    };
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    mock.timers.tick(1);
    cursor = { x: 95, y: 70 };
    mock.timers.tick(5000);

    assert.deepStrictEqual(pointers, []);
  });

  it("cleanup clears the pending adaptive tick", () => {
    const theme = cloneTheme(_defaultTheme);

    ctx = makeCtx(theme, statesSeen);
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();
    tickApi.cleanup();

    mock.timers.tick(1000);

    assert.equal(cursorCalls, 0);
  });

  it("still enters direct sleep near mouseSleepTimeout under adaptive scheduling", () => {
    const theme = cloneTheme(_defaultTheme);
    theme.sleepSequence = { mode: "direct" };
    theme.timings.mouseIdleTimeout = 5000;
    theme.timings.mouseSleepTimeout = 500;

    ctx = makeCtx(theme, statesSeen);
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    for (const step of [100, 100, 100, 100, 100, 100, 100]) mock.timers.tick(step);
    assert.deepStrictEqual(statesSeen, ["sleeping"]);
  });

  it("uses the ctx setter path to pull a pending tick forward for force eye resend boost", () => {
    const theme = cloneTheme(_defaultTheme);
    const eyeMoves = [];
    let forceEyeResend = false;
    let forceEyeResendBoostUntil = 0;

    ctx = makeCtx(theme, statesSeen);
    Object.defineProperty(ctx, "forceEyeResend", {
      get() { return forceEyeResend; },
      set(value) {
        forceEyeResend = !!value;
        if (forceEyeResend) {
          forceEyeResendBoostUntil = Math.max(forceEyeResendBoostUntil, Date.now() + 2000);
          if (tickApi) tickApi.scheduleSoon(100);
        }
      },
      configurable: true,
    });
    Object.defineProperty(ctx, "forceEyeResendBoostUntil", {
      get() { return forceEyeResendBoostUntil; },
      configurable: true,
    });
    ctx.sendToRenderer = (channel, ...args) => {
      if (channel === "eye-move") eyeMoves.push(args);
    };
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    mock.timers.tick(2200);
    eyeMoves.length = 0;

    ctx.forceEyeResend = true;

    mock.timers.tick(99);
    assert.equal(eyeMoves.length, 0);

    mock.timers.tick(1);
    assert.equal(eyeMoves.length, 1);
    assert.equal(ctx.forceEyeResend, false);
  });

  it("preserves ticks scheduled while the current tick is running", () => {
    const theme = cloneTheme(_defaultTheme);
    theme.timings.mouseIdleTimeout = 60000;
    theme.timings.mouseSleepTimeout = 120000;
    theme.idleAnimations = [];
    let eyeMoveCount = 0;

    ctx = makeCtx(theme, statesSeen);
    ctx.sendToRenderer = (channel) => {
      if (channel === "eye-move") {
        eyeMoveCount++;
        tickApi.scheduleSoon(100);
      }
    };
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    mock.timers.tick(2200);
    ctx.forceEyeResend = true;

    for (let elapsed = 0; eyeMoveCount === 0 && elapsed < 1000; elapsed++) {
      mock.timers.tick(1);
    }
    assert.equal(eyeMoveCount, 1);
    const callsAfterEyeMove = cursorCalls;

    mock.timers.tick(99);
    assert.equal(cursorCalls, callsAfterEyeMove);

    mock.timers.tick(1);
    assert.equal(cursorCalls, callsAfterEyeMove + 1);
  });
});

describe("tick spin detection (dizzy gesture)", () => {
  let cursor;
  let loader;
  let tickApi;
  let ctx;
  let statesSeen;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    cursor = { x: 40, y: 40 };
    loader = loadTickWithScreen(() => ({ ...cursor }));
    statesSeen = [];
  });

  afterEach(() => {
    if (tickApi) tickApi.cleanup();
    if (loader) loader.restore();
    mock.timers.reset();
    tickApi = null;
    ctx = null;
  });

  // A theme that supports dizzy, with idle-anim / sleep pushed far out of the way
  // so they never fire during a multi-second gesture.
  function dizzyTheme() {
    const theme = cloneTheme(_defaultTheme);
    theme.states.dizzy = ["clawd-dizzy.svg"];
    theme.timings.autoReturn = theme.timings.autoReturn || {};
    theme.timings.autoReturn.dizzy = 6000;
    theme.timings.mouseIdleTimeout = 100000;
    theme.timings.mouseSleepTimeout = 100000;
    return theme;
  }

  // Eye-tracking origin for the fixed getObjRect() { x:20, y:20, w:60, h:60 }.
  function eyeCenter(theme) {
    const obj = { x: 20, y: 20, w: 60, h: 60 };
    return {
      cx: obj.x + obj.w * theme.eyeTracking.eyeRatioX,
      cy: obj.y + obj.h * theme.eyeTracking.eyeRatioY,
    };
  }

  // Drive `steps` circling samples at radius R, dTheta per step — one 100ms tick each.
  function circle(cx, cy, R, startAngle, dTheta, steps) {
    for (let i = 0; i < steps; i++) {
      const a = startAngle + i * dTheta;
      cursor.x = cx + R * Math.cos(a);
      cursor.y = cy + R * Math.sin(a);
      mock.timers.tick(100);
    }
  }

  it("triggers dizzy after 2+ full circles around the pet", () => {
    const theme = dizzyTheme();
    ctx = makeCtx(theme, statesSeen);
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    const { cx, cy } = eyeCenter(theme);
    circle(cx, cy, 40, 0, Math.PI / 6, 36); // 3 turns worth of samples

    assert.ok(statesSeen.includes("dizzy"), `expected dizzy, saw ${JSON.stringify(statesSeen)}`);
  });

  it("does NOT trigger on back-and-forth wiggling (signed cancellation)", () => {
    const theme = dizzyTheme();
    ctx = makeCtx(theme, statesSeen);
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    const { cx, cy } = eyeCenter(theme);
    const R = 40;
    const a = 0.3;
    const b = 2.3; // ~2 rad swing, well under PI so nothing wraps
    for (let i = 0; i < 40; i++) {
      const angle = (i % 2 === 0) ? a : b;
      cursor.x = cx + R * Math.cos(angle);
      cursor.y = cy + R * Math.sin(angle);
      mock.timers.tick(100);
    }

    assert.ok(!statesSeen.includes("dizzy"), `expected no dizzy, saw ${JSON.stringify(statesSeen)}`);
  });

  it("does NOT trigger from sub-pixel jitter near the center", () => {
    const theme = dizzyTheme();
    ctx = makeCtx(theme, statesSeen);
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    const { cx, cy } = eyeCenter(theme);
    const jitter = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1]];
    for (let i = 0; i < 40; i++) {
      const [dx, dy] = jitter[i % jitter.length];
      cursor.x = cx + dx;
      cursor.y = cy + dy;
      mock.timers.tick(100);
    }

    assert.ok(!statesSeen.includes("dizzy"), `expected no dizzy from jitter, saw ${JSON.stringify(statesSeen)}`);
  });

  it("does NOT trigger on themes without a dizzy state (Calico / Cloudling)", () => {
    const theme = dizzyTheme();
    delete theme.states.dizzy;
    delete theme.timings.autoReturn.dizzy;
    ctx = makeCtx(theme, statesSeen);
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    const { cx, cy } = eyeCenter(theme);
    circle(cx, cy, 40, 0, Math.PI / 6, 36);

    assert.ok(!statesSeen.includes("dizzy"), `unsupported theme should stay idle, saw ${JSON.stringify(statesSeen)}`);
  });

  it("resets the meter after a pause so a broken-up gesture doesn't accumulate", () => {
    const theme = dizzyTheme();
    ctx = makeCtx(theme, statesSeen);
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    const { cx, cy } = eyeCenter(theme);
    circle(cx, cy, 40, 0, Math.PI / 6, 18); // ~1.5 turns
    assert.ok(!statesSeen.includes("dizzy"), "1.5 turns alone should not trigger");

    for (let i = 0; i < 8; i++) mock.timers.tick(100); // 800ms pause, cursor held still

    circle(cx, cy, 40, 0, Math.PI / 6, 18); // another ~1.5 turns after the reset
    assert.ok(!statesSeen.includes("dizzy"), `pause should reset the meter, saw ${JSON.stringify(statesSeen)}`);
  });
});

describe("tick free roam cancellation (#569)", () => {
  let cursor;
  let loader;
  let tickApi;
  let ctx;
  let statesSeen;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    cursor = { x: 40, y: 40 };
    loader = loadTickWithScreen(() => ({ ...cursor }));
    statesSeen = [];
  });

  afterEach(() => {
    if (tickApi) tickApi.cleanup();
    if (loader) loader.restore();
    mock.timers.reset();
    tickApi = null;
    ctx = null;
  });

  function makeRoamCtx() {
    const theme = cloneTheme(_defaultTheme);
    const c = makeCtx(theme, statesSeen);
    // Pet is mid-walk: roam.js switched the visual state to "roam".
    c.currentState = "roam";
    c.roamCancels = 0;
    c.roam = {
      enabled: true,
      cancelRoam() { c.roamCancels += 1; },
      tick() {},
    };
    return c;
  }

  it("cancels an active walk when the mouse moves during state 'roam'", () => {
    ctx = makeRoamCtx();
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    // Baseline ticks with a still cursor — records lastCursor, must not cancel.
    mock.timers.tick(800);
    assert.equal(ctx.roamCancels, 0, "no cancel while the mouse is still");

    // Mouse moves mid-walk — the next tick must cancel the walk. Before the
    // #569 follow-up, state "roam" was excluded from the cursor poll gate and
    // this cancel block was unreachable during a walk.
    cursor = { x: 300, y: 260 };
    mock.timers.tick(800);
    assert.ok(ctx.roamCancels >= 1, "mouse move during an active walk must cancel roam");
  });

  it("does not cancel while the mouse stays still for the whole walk", () => {
    ctx = makeRoamCtx();
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    for (let i = 0; i < 6; i++) mock.timers.tick(800);
    assert.equal(ctx.roamCancels, 0, "a still mouse must never cancel the walk");
  });

  it("defers a queued walk when the mouse moves during state 'idle'", () => {
    ctx = makeRoamCtx();
    ctx.currentState = "idle";
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    mock.timers.tick(800);
    assert.equal(ctx.roamCancels, 0, "no cancel while the mouse is still");

    cursor = { x: 300, y: 260 };
    mock.timers.tick(800);
    assert.ok(ctx.roamCancels >= 1, "mouse move during idle must defer the queued walk");
  });

  it("does not cancel a queued walk while the mouse stays still during state 'idle'", () => {
    ctx = makeRoamCtx();
    ctx.currentState = "idle";
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    for (let i = 0; i < 6; i++) mock.timers.tick(800);
    assert.equal(ctx.roamCancels, 0, "a still mouse during idle must leave the queued walk intact");
  });

  it("does not cancel a walk while idlePaused (e.g. menu open)", () => {
    ctx = makeRoamCtx();
    ctx.idlePaused = true;
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    mock.timers.tick(800);
    cursor = { x: 300, y: 260 };
    mock.timers.tick(800);
    assert.equal(ctx.roamCancels, 0, "idlePaused suppresses roam cursor cancellation");
  });
});

describe("tick unattended roam sleep (#1202)", () => {
  let cursor;
  let loader;
  let tickApi;
  let ctx;
  let statesSeen;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    cursor = { x: 40, y: 40 };
    loader = loadTickWithScreen(() => ({ ...cursor }));
    statesSeen = [];
  });

  afterEach(() => {
    if (tickApi) tickApi.cleanup();
    if (loader) loader.restore();
    mock.timers.reset();
    tickApi = null;
    ctx = null;
  });

  it("keeps the unattended period across an automatic roam-to-idle edge", () => {
    const theme = cloneTheme(_defaultTheme);
    theme.idleAnimations = [];
    theme.timings.mouseSleepTimeout = 1000;
    ctx = makeCtx(theme, statesSeen);
    ctx.roam = { enabled: true, cancelRoam() {}, tick() {} };
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();
    mock.timers.tick(100);

    const stillSince = tickApi._mouseStillSince;
    ctx.currentState = "roam";
    mock.timers.tick(800);
    ctx.currentState = "idle";
    mock.timers.tick(800);

    assert.equal(tickApi._mouseStillSince, stillSince);

    // Keeping the cursor baseline across the edge means movement between the
    // last roam sample and the first idle sample is still real activity.
    cursor = { x: 300, y: 260 };
    mock.timers.tick(800);
    assert.equal(tickApi._mouseStillSince, Date.now());
    assert.equal(statesSeen.includes("yawning"), false);
  });

  it("restores eye tracking after roam interrupts an idle animation without restarting the unattended period", () => {
    const theme = cloneTheme(_defaultTheme);
    theme.idleAnimations = [{ file: "clawd-idle-look.svg", duration: 5000 }];
    theme.timings.mouseIdleTimeout = 60;
    theme.timings.mouseSleepTimeout = 100000;
    ctx = makeCtx(theme, statesSeen);
    ctx.roam = { enabled: true, cancelRoam() {}, tick() {} };
    let visualGeneration = 0;
    ctx.sendToRenderer = (channel, state, svg, options) => {
      if (channel !== "state-change") return;
      ctx.currentSvg = svg;
      const request = { visualGeneration: ++visualGeneration };
      if (state === "idle" && svg === "clawd-idle-look.svg") {
        statesSeen.push("idle-animation");
      }
      if (options && typeof options.onLogicalSettlement === "function") {
        options.onLogicalSettlement({ status: "committed", visualGeneration: request.visualGeneration });
      }
      return request;
    };
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();
    mock.timers.tick(1);
    const stillSince = tickApi._mouseStillSince;

    for (let i = 0; i < 20 && statesSeen.length === 0; i++) mock.timers.tick(50);
    assert.deepStrictEqual(statesSeen, ["idle-animation"], "the idle animation must start before roam interrupts it");

    ctx.currentState = "roam";
    tickApi.scheduleSoon(0);
    mock.timers.tick(1);
    ctx.currentState = "idle";
    tickApi.scheduleSoon(0);
    mock.timers.tick(1);
    assert.equal(tickApi._mouseStillSince, stillSince, "the automatic walk must preserve the unattended period");

    ctx.forceEyeResend = true;
    ctx.currentSvg = theme.states.idle[0];
    tickApi.scheduleSoon(0);
    mock.timers.tick(1);
    assert.equal(ctx.forceEyeResend, false, "eye tracking must resume after the interrupted idle animation");

    for (let i = 0; i < 20; i++) mock.timers.tick(50);
    assert.deepStrictEqual(statesSeen, ["idle-animation"], "the idle animation must stay consumed for this unattended period");
  });

  it("starts a fresh unattended period when another state returns to idle", () => {
    const theme = cloneTheme(_defaultTheme);
    ctx = makeCtx(theme, statesSeen);
    ctx.currentState = "working";
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();
    mock.timers.tick(800);
    const previousStillSince = tickApi._mouseStillSince;

    ctx.currentState = "idle";
    mock.timers.tick(800);

    assert.ok(tickApi._mouseStillSince > previousStillSince);
  });

  it("resets the unattended period when the mouse moves during roam", () => {
    const theme = cloneTheme(_defaultTheme);
    ctx = makeCtx(theme, statesSeen);
    ctx.currentState = "roam";
    ctx.roam = { enabled: true, cancelRoam() {}, tick() {} };
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();
    mock.timers.tick(800);
    const beforeMovement = tickApi._mouseStillSince;

    cursor = { x: 300, y: 260 };
    mock.timers.tick(800);

    assert.ok(tickApi._mouseStillSince > beforeMovement);
  });

  it("finishes an expired walk and then enters yawning without another roam", () => {
    const theme = cloneTheme(_defaultTheme);
    theme.idleAnimations = [];
    theme.timings.mouseSleepTimeout = 1000;
    theme.timings.autoReturn.yawning = 3000;
    let roamTicks = 0;
    const roamCancels = [];
    ctx = makeCtx(theme, statesSeen);
    ctx.currentState = "roam";
    ctx.roam = {
      enabled: true,
      cancelRoam() { roamCancels.push(ctx.currentState); },
      tick() { roamTicks++; },
    };
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();
    mock.timers.tick(100);

    ctx.currentState = "idle";
    mock.timers.tick(1000);
    assert.equal(statesSeen.includes("yawning"), false, "the yawn still has its delayed entry");
    mock.timers.tick(250);
    assert.deepStrictEqual(statesSeen, ["yawning"]);
    assert.ok(roamTicks > 0, "the idle tick must still service roam while the delayed yawn is pending");

    // The next tick is outside idle, so no new roam may be started. The
    // actual roam module's queued callback is separately guarded by A3.
    mock.timers.tick(250);
    assert.equal(statesSeen.filter((state) => state === "roam").length, 0);
    assert.deepStrictEqual(roamCancels, []);
  });

  it("enters sleeping directly when an expired walk reaches the direct sleep threshold", () => {
    const theme = cloneTheme(_defaultTheme);
    theme.sleepSequence = { mode: "direct" };
    theme.timings.mouseSleepTimeout = 1000;
    const roam = { enabled: true, cancelRoam() {}, tick() {} };
    ctx = makeCtx(theme, statesSeen);
    ctx.currentState = "roam";
    ctx.roam = roam;
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();
    mock.timers.tick(100);

    ctx.currentState = "idle";
    mock.timers.tick(1000);

    assert.deepStrictEqual(statesSeen, ["sleeping"]);
  });
});

// #509: user-selected default idle visual as the tick resting sprite.
describe("tick default idle visual", () => {
  let cursor;
  let loader;
  let tickApi;
  let ctx;
  let statesSeen;
  let rendererCalls;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    cursor = { x: 40, y: 40 };
    loader = loadTickWithScreen(() => ({ ...cursor }));
    statesSeen = [];
    rendererCalls = [];
  });

  afterEach(() => {
    if (tickApi) tickApi.cleanup();
    if (loader) loader.restore();
    mock.timers.reset();
    tickApi = null;
    ctx = null;
  });

  function makeIdleVisualCtx(theme, choice) {
    const c = makeCtx(theme, statesSeen);
    let visualGeneration = 0;
    c.sendToRenderer = (channel, ...args) => {
      rendererCalls.push([channel, ...args]);
      if (channel === "state-change") {
        const request = { visualGeneration: ++visualGeneration };
        const options = args[2];
        if (options && typeof options.onLogicalSettlement === "function") {
          options.onLogicalSettlement({
            status: "committed",
            visualGeneration: request.visualGeneration,
          });
        }
        return request;
      }
    };
    if (choice !== undefined) c.getIdleVisualChoice = () => choice;
    return c;
  }

  function idleStateChanges() {
    return rendererCalls.filter(([ch, state]) => ch === "state-change" && state === "idle");
  }

  function makeIdleTheme(idleAnimations) {
    const theme = cloneTheme(_defaultTheme);
    theme.timings.mouseIdleTimeout = 60;
    theme.timings.mouseSleepTimeout = 100000;
    theme.idleAnimations = idleAnimations;
    return theme;
  }

  for (const roll of [0, 0.49, 0.99]) {
    it(`never randomly plays a selectable-only visual at roll ${roll}`, () => {
      const theme = makeIdleTheme([
        { file: "clawd-idle-look.svg", duration: 500 },
        { file: "clawd-idle-bubble.svg", duration: 500 },
      ]);
      theme.idleVisualOptions = [{ file: "pool.apng" }];
      ctx = makeIdleVisualCtx(theme, resolveIdleVisualChoice(theme, { clawd: "pool.apng" }));
      ctx.random = () => roll;
      tickApi = loader.initTick(ctx);
      tickApi.startMainTick();

      for (let i = 0; i < 20 && idleStateChanges().length === 0; i++) mock.timers.tick(50);
      assert.ok(idleStateChanges().length > 0);
      assert.ok(["clawd-idle-look.svg", "clawd-idle-bubble.svg"].includes(idleStateChanges()[0][2]));
      mock.timers.tick(500);
      assert.strictEqual(idleStateChanges().at(-1)[2], "pool.apng");
    });
  }

  it("excludes a selected option even when its file also occurs in idleAnimations", () => {
    const theme = makeIdleTheme([
      { file: "pool.apng", duration: 500 },
      { file: "clawd-idle-look.svg", duration: 500 },
    ]);
    theme.idleVisualOptions = [{ file: "pool.apng" }];
    ctx = makeIdleVisualCtx(theme, resolveIdleVisualChoice(theme, { clawd: "pool.apng" }));
    ctx.random = () => 0;
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    for (let i = 0; i < 20 && idleStateChanges().length === 0; i++) mock.timers.tick(50);
    assert.strictEqual(idleStateChanges()[0][2], "clawd-idle-look.svg");
    mock.timers.tick(500);
    assert.strictEqual(idleStateChanges().at(-1)[2], "pool.apng");
  });

  it("pool play returns to the user-selected idle visual", () => {
    const theme = makeIdleTheme([{ file: "clawd-idle-look.svg", duration: 500 }]);
    ctx = makeIdleVisualCtx(theme, "clawd-idle-reading.svg");
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    for (let i = 0; i < 20 && idleStateChanges().length === 0; i++) mock.timers.tick(50);
    mock.timers.tick(500);                              // duration starts at committed display

    const changes = idleStateChanges();
    assert.deepStrictEqual(
      changes.map(([, , svg]) => svg),
      ["clawd-idle-look.svg", "clawd-idle-reading.svg"]
    );
  });

  it("unset choice keeps returning to the theme follow sprite", () => {
    const theme = makeIdleTheme([{ file: "clawd-idle-look.svg", duration: 500 }]);
    ctx = makeIdleVisualCtx(theme);
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    for (let i = 0; i < 20 && idleStateChanges().length === 0; i++) mock.timers.tick(50);
    mock.timers.tick(500);

    const changes = idleStateChanges();
    assert.deepStrictEqual(
      changes.map(([, , svg]) => svg),
      ["clawd-idle-look.svg", "clawd-idle-follow.svg"]
    );
  });

  it("unset choice leaves the pool untouched (follow sprite stays a valid pool entry)", () => {
    const theme = makeIdleTheme([{ file: "clawd-idle-follow.svg", duration: 500 }]);
    ctx = makeIdleVisualCtx(theme);
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    for (let i = 0; i < 20 && idleStateChanges().length === 0; i++) mock.timers.tick(50);
    mock.timers.tick(500);

    const changes = idleStateChanges();
    assert.deepStrictEqual(
      changes.map(([, , svg]) => svg),
      ["clawd-idle-follow.svg", "clawd-idle-follow.svg"],
      "with no choice set a theme may play its follow sprite from the pool"
    );
  });

  it("consumes forceEyeResend while resting on a non-follow visual", () => {
    const theme = makeIdleTheme([{ file: "clawd-idle-look.svg", duration: 500 }]);
    theme.timings.mouseIdleTimeout = 100000; // keep the pool out of this test
    ctx = makeIdleVisualCtx(theme, "clawd-idle-reading.svg");
    ctx.currentSvg = "clawd-idle-reading.svg";
    // Production always exposes this; without it the pointer-bridge key is
    // never recorded and bounds get polled every tick for that reason instead.
    ctx.getAssetPointerPayload = () => ({ x: 0.5, y: 0.5, inside: true });
    let boundsReads = 0;
    ctx.getPetWindowBounds = () => { boundsReads++; return { x: 0, y: 0, width: 120, height: 120 }; };
    ctx.forceEyeResend = true;
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    mock.timers.tick(50);
    assert.strictEqual(ctx.forceEyeResend, false, "flag must be consumed on the first idle tick");
    const readsAfterFirstTick = boundsReads;
    for (let i = 0; i < 5; i++) mock.timers.tick(50);
    assert.strictEqual(boundsReads, readsAfterFirstTick, "no per-tick bounds polling while resting still");
  });

  it("never picks the chosen file from the pool; skips when it is the only entry", () => {
    const theme = makeIdleTheme([{ file: "clawd-idle-reading.svg", duration: 500 }]);
    ctx = makeIdleVisualCtx(theme, "clawd-idle-reading.svg");
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    for (let i = 0; i < 10; i++) mock.timers.tick(100);
    assert.deepStrictEqual(idleStateChanges(), [], "resting sprite must not be re-played as a pool pick");
  });

  it("mouse movement during a pool play reverts to the chosen visual", () => {
    const theme = makeIdleTheme([{ file: "clawd-idle-look.svg", duration: 5000 }]);
    ctx = makeIdleVisualCtx(theme, "clawd-idle-reading.svg");
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    for (let i = 0; i < 8; i++) mock.timers.tick(50);   // trigger + play (long duration, no revert yet)
    cursor = { x: 300, y: 260 };                        // wake mid-play
    for (let i = 0; i < 4; i++) mock.timers.tick(50);

    const changes = idleStateChanges();
    assert.ok(changes.length >= 2, "expected play + mouse-move revert");
    assert.strictEqual(changes[changes.length - 1][2], "clawd-idle-reading.svg");
  });

  it("does not let a stale idle return timer replace a superseding visual generation", () => {
    const theme = makeIdleTheme([{ file: "clawd-idle-look.svg", duration: 500 }]);
    ctx = makeIdleVisualCtx(theme, "clawd-idle-reading.svg");
    ctx.isVisualGenerationCurrent = () => false;
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    for (let i = 0; i < 20 && idleStateChanges().length === 0; i++) mock.timers.tick(50);
    mock.timers.tick(500);

    assert.deepStrictEqual(
      idleStateChanges().map(([, , svg]) => svg),
      ["clawd-idle-look.svg"],
      "a superseded idle beat must not fire its old return request"
    );
  });

  it("does not eye-track while resting on a non-follow visual", () => {
    const theme = makeIdleTheme([{ file: "clawd-idle-look.svg", duration: 500 }]);
    ctx = makeIdleVisualCtx(theme, "clawd-idle-reading.svg");
    ctx.currentSvg = "clawd-idle-reading.svg";
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    for (let i = 0; i < 5; i++) {
      cursor = { x: cursor.x + 15, y: cursor.y + 10 };
      mock.timers.tick(50);
    }
    const eyeMoves = rendererCalls.filter(([ch]) => ch === "eye-move");
    assert.deepStrictEqual(eyeMoves, [], "eye tracking must stay off on a non-follow resting sprite");
  });

  it("still eye-tracks when the choice is unset (follow sprite)", () => {
    const theme = makeIdleTheme([{ file: "clawd-idle-look.svg", duration: 500 }]);
    ctx = makeIdleVisualCtx(theme);
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    for (let i = 0; i < 5; i++) {
      cursor = { x: cursor.x + 15, y: cursor.y + 10 };
      mock.timers.tick(50);
    }
    const eyeMoves = rendererCalls.filter(([ch]) => ch === "eye-move");
    assert.ok(eyeMoves.length > 0, "follow sprite must keep eye tracking");
  });
});

describe("tick conditional idle easter eggs", () => {
  let cursor;
  let loader;
  let tickApi;
  let ctx;
  let rendererCalls;
  let randomValues;
  let randomCalls;
  let accessoryIds;

  const BENDER = {
    file: "clawd-outlaw-bender.svg",
    duration: 15000,
    chance: 0.5,
    cooldownMs: 1800000,
    requiresAccessories: { head: "western-cowboy-hat", mouth: "cigarette" },
  };

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    cursor = { x: 40, y: 40 };
    loader = loadTickWithScreen(() => ({ ...cursor }));
    rendererCalls = [];
    randomValues = [];
    randomCalls = 0;
    accessoryIds = { head: "western-cowboy-hat", mouth: "cigarette" };
  });

  afterEach(() => {
    if (tickApi) tickApi.cleanup();
    if (loader) loader.restore();
    mock.timers.reset();
    tickApi = null;
    ctx = null;
  });

  function makeEggTheme({ eggs = [BENDER], idleAnimations = [] } = {}) {
    const theme = cloneTheme(_defaultTheme);
    theme.timings.mouseIdleTimeout = 60;
    theme.timings.mouseSleepTimeout = 100000000;
    theme.idleAnimations = idleAnimations;
    theme.idleEasterEggs = eggs;
    return theme;
  }

  function start(theme = makeEggTheme(), configure = () => {}) {
    ctx = makeCtx(theme, []);
    let visualGeneration = 0;
    ctx.autoSettleVisualRequests = true;
    ctx.pendingVisualSettlements = [];
    ctx.getEffectiveAccessoryIds = () => ({ ...accessoryIds });
    ctx.random = () => {
      randomCalls++;
      return randomValues.length > 0 ? randomValues.shift() : 0;
    };
    ctx.now = () => Date.now();
    ctx.sendToRenderer = (channel, ...args) => {
      rendererCalls.push([channel, ...args]);
      if (channel === "state-change") {
        const request = { visualGeneration: ++visualGeneration };
        const options = args[2];
        if (options && typeof options.onLogicalSettlement === "function") {
          ctx.pendingVisualSettlements.push(options.onLogicalSettlement);
          if (ctx.autoSettleVisualRequests) {
            options.onLogicalSettlement({
              status: "committed",
              visualGeneration: request.visualGeneration,
            });
          }
        }
        return request;
      }
      return undefined;
    };
    configure(ctx);
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();
  }

  function idleFiles() {
    return rendererCalls
      .filter(([channel, state]) => channel === "state-change" && state === "idle")
      .map(([, , file]) => file);
  }

  function advanceUntil(predicate, { step = 25, limit = 2000 } = {}) {
    for (let elapsed = 0; elapsed < limit && !predicate(); elapsed += step) {
      mock.timers.tick(step);
    }
    assert.ok(predicate(), `condition was not reached within ${limit} ms`);
  }

  it("uses the reviewed 50% interval before the ordinary idle pool and returns naturally", () => {
    randomValues.push(0.499);
    start(makeEggTheme({
      idleAnimations: [{ file: "clawd-idle-look.svg", duration: 500 }],
    }));

    advanceUntil(() => idleFiles().length === 1);
    assert.deepStrictEqual(idleFiles(), ["clawd-outlaw-bender.svg"]);
    assert.strictEqual(randomCalls, 1, "an egg hit must not also draw from the ordinary pool");

    mock.timers.tick(15000);
    assert.deepStrictEqual(idleFiles(), [
      "clawd-outlaw-bender.svg",
      "clawd-idle-follow.svg",
    ]);
  });

  it("falls through to the ordinary pool on an egg miss", () => {
    randomValues.push(0.5, 0);
    start(makeEggTheme({
      idleAnimations: [{ file: "clawd-idle-look.svg", duration: 500 }],
    }));

    advanceUntil(() => idleFiles().length === 1);
    assert.deepStrictEqual(idleFiles(), ["clawd-idle-look.svg"]);
    assert.strictEqual(randomCalls, 2, "miss and ordinary pool selection use separate draws");
  });

  it("uses declaration-order cumulative probability intervals", () => {
    randomValues.push(0.5);
    start(makeEggTheme({ eggs: [
      { ...BENDER, chance: 0.5 },
      { ...BENDER, file: "second-egg.svg", chance: 0.1 },
    ] }));

    advanceUntil(() => idleFiles().length === 1);
    assert.deepStrictEqual(idleFiles(), ["second-egg.svg"]);
  });

  it("rechecks canonical accessories during the 250 ms swap delay", () => {
    randomValues.push(0);
    start();
    advanceUntil(() => randomCalls === 1);
    accessoryIds = { head: "none", mouth: "cigarette" };
    mock.timers.tick(350);

    assert.deepStrictEqual(idleFiles(), []);
    assert.strictEqual(randomCalls, 1);
  });

  it("starts cooldown only after playback begins and permits another play after expiry", () => {
    const egg = { ...BENDER, duration: 5000, cooldownMs: 10000 };
    randomValues.push(0, 0);
    start(makeEggTheme({ eggs: [egg] }));
    advanceUntil(() => idleFiles().length === 1);
    assert.deepStrictEqual(idleFiles(), ["clawd-outlaw-bender.svg"]);

    cursor = { x: 80, y: 80 };
    mock.timers.tick(2000);
    assert.strictEqual(randomCalls, 1, "cooldown eligibility must be checked before drawing probability");

    mock.timers.tick(9000);
    cursor = { x: 90, y: 90 };
    advanceUntil(
      () => idleFiles().filter((file) => file === "clawd-outlaw-bender.svg").length === 2,
      { limit: 2000 }
    );
    assert.strictEqual(
      idleFiles().filter((file) => file === "clawd-outlaw-bender.svg").length,
      2
    );
    assert.strictEqual(randomCalls, 2);
  });

  it("starts duration and cooldown from the recovery generation that actually commits", () => {
    const egg = { ...BENDER, duration: 1000, cooldownMs: 10000 };
    randomValues.push(0);
    start(makeEggTheme({ eggs: [egg] }), (c) => {
      c.autoSettleVisualRequests = false;
      c.isVisualGenerationCurrent = (generation) => generation === 2;
    });

    advanceUntil(() => idleFiles().length === 1);
    mock.timers.tick(4000);
    assert.deepStrictEqual(idleFiles(), ["clawd-outlaw-bender.svg"]);

    ctx.pendingVisualSettlements[0]({ status: "committed", visualGeneration: 2 });
    mock.timers.tick(999);
    assert.deepStrictEqual(idleFiles(), ["clawd-outlaw-bender.svg"]);
    mock.timers.tick(1);
    assert.deepStrictEqual(idleFiles(), [
      "clawd-outlaw-bender.svg",
      "clawd-idle-follow.svg",
    ]);
  });

  it("does not consume cooldown when the requested easter egg fails before display", () => {
    randomValues.push(0, 0);
    start(makeEggTheme(), (c) => {
      c.autoSettleVisualRequests = false;
    });

    advanceUntil(() => idleFiles().length === 1);
    ctx.pendingVisualSettlements[0]({ status: "failed", visualGeneration: 1 });

    cursor = { x: 80, y: 80 };
    mock.timers.tick(100);
    ctx.autoSettleVisualRequests = true;
    advanceUntil(
      () => idleFiles().filter((file) => file === "clawd-outlaw-bender.svg").length === 2,
      { limit: 2000 }
    );
    assert.strictEqual(randomCalls, 2);
  });

  for (const [label, configure] of [
    ["renderer hidden", (c) => { c.win.isVisible = () => false; }],
    ["low-power idle pause", (c) => { c.lowPowerIdlePaused = true; }],
    ["drag lock", (c) => { c.dragLocked = true; }],
    ["menu transition", (c) => { c.menuOpen = true; }],
    ["mini mode", (c) => { c.miniMode = true; c.currentState = "mini-idle"; }],
    ["roam", (c) => { c.currentState = "roam"; }],
  ]) {
    it(`does not consume probability while ${label}`, () => {
      randomValues.push(0);
      start(makeEggTheme(), configure);
      mock.timers.tick(1000);
      assert.deepStrictEqual(idleFiles(), []);
      assert.strictEqual(randomCalls, 0);
    });
  }

  it("does not trigger for a holiday replacement or any other accessory mismatch", () => {
    accessoryIds = { head: "santa-hat", mouth: "cigarette" };
    randomValues.push(0);
    start();
    mock.timers.tick(1000);
    assert.deepStrictEqual(idleFiles(), []);
    assert.strictEqual(randomCalls, 0);
  });

  it("does not let the return timer overwrite a higher-priority state", () => {
    randomValues.push(0);
    start();
    advanceUntil(() => idleFiles().length === 1);
    assert.deepStrictEqual(idleFiles(), ["clawd-outlaw-bender.svg"]);

    ctx.currentState = "working";
    mock.timers.tick(16000);
    assert.deepStrictEqual(idleFiles(), ["clawd-outlaw-bender.svg"]);
  });
});

describe("tick companion coordination", () => {
  let loader;
  let tickApi;
  let ctx;
  let calls;
  let companionTicks;
  let companionPlaying;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    loader = loadTickWithScreen(() => ({ x: 300, y: 260 }));
    const theme = cloneTheme(_defaultTheme);
    theme.timings.mouseIdleTimeout = 100;
    theme.timings.mouseSleepTimeout = 100000;
    theme.idleAnimations = [{ file: "clawd-idle-look.svg", duration: 500 }];
    theme.idleEasterEggs = [];
    ctx = makeCtx(theme, []);
    calls = [];
    companionTicks = 0;
    companionPlaying = false;
    let generation = 0;
    ctx.sendToRenderer = (channel, state, svg, options) => {
      calls.push([channel, state, svg]);
      if (channel !== "state-change") return;
      const request = { visualGeneration: ++generation };
      if (options && options.onLogicalSettlement) {
        options.onLogicalSettlement({ status: "committed", ...request });
      }
      return request;
    };
    ctx.isVisualGenerationCurrent = (value) => value === generation;
    ctx.companion = {
      tick: () => { companionTicks++; },
      isAnimating: () => companionPlaying,
    };
  });

  afterEach(() => {
    if (tickApi) tickApi.cleanup();
    tickApi = null;
    loader.restore();
    mock.timers.reset();
  });

  function start() {
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();
    mock.timers.tick(1);
  }

  function advance(ms) {
    for (let remaining = ms; remaining > 0; remaining -= 50) {
      mock.timers.tick(Math.min(50, remaining));
    }
  }

  function idleFiles() {
    return calls.filter(([channel]) => channel === "state-change").map(([, , svg]) => svg);
  }

  it("the companion's sleep clock decides when the yawn starts", () => {
    ctx.theme.timings.mouseSleepTimeout = 1000;
    let clock = 0;
    const asked = [];
    ctx.companion.sleepClockMs = (elapsed, base) => { asked.push(base); return clock; };
    ctx.companion.sleepTimeoutMs = () => 5000;
    const states = [];
    ctx.setState = function (state) { states.push(state); this.currentState = state; };
    start();
    advance(3000);
    assert.deepEqual(states, [], "the mouse clock passed the theme timeout, the sleep clock did not");
    assert.ok(asked.length > 0 && asked.every((base) => base === 1000));
    clock = 4999;
    advance(1000);
    assert.deepEqual(states, []);
    clock = 5000;
    advance(1500);
    assert.deepEqual(states, ["yawning"]);
  });

  it("a throwing sleep clock falls back to the original timeout and keeps the loop alive", () => {
    ctx.theme.timings.mouseSleepTimeout = 1000;
    ctx.companion.sleepClockMs = () => { throw new Error("boom"); };
    ctx.companion.sleepTimeoutMs = () => { throw new Error("boom"); };
    const states = [];
    ctx.setState = function (state) { states.push(state); this.currentState = state; };
    start();
    advance(2500);
    assert.deepEqual(states, ["yawning"]);
  });

  it("companion tick runs only in idle branch and not during idle-look", () => {
    ctx.currentState = "working";
    start();
    advance(300);
    assert.equal(companionTicks, 0, "never ticks outside idle");

    ctx.currentState = "idle";
    tickApi.scheduleSoon(0);
    mock.timers.tick(1);
    assert.ok(companionTicks > 0, "ticks in the idle branch");
    // Idle-look starts after mouseIdleTimeout and owns the visual for 500ms.
    while (idleFiles().length === 0) advance(50);
    const ticksBeforeLook = companionTicks;
    advance(300);
    assert.equal(companionTicks, ticksBeforeLook, "paused while idle-look plays");
    advance(500);
    assert.ok(companionTicks > ticksBeforeLook, "resumes after idle-look");
  });

  it("a companion beat suppresses idle-look and eye messages like an idle activity", () => {
    companionPlaying = true;
    ctx.forceEyeResend = true;
    start();
    advance(1000);
    assert.deepStrictEqual(calls, []);
    assert.ok(companionTicks > 0);
    companionPlaying = false;
    advance(500);
    assert.deepStrictEqual(idleFiles(), ["clawd-idle-look.svg"]);
  });

  it("notifies the companion of each real idle entry but not after a walk", () => {
    let entries = 0;
    ctx.companion.noteIdleEntered = () => { entries++; };
    ctx.currentState = "working";
    start();
    function sample(state) {
      ctx.currentState = state;
      tickApi.scheduleSoon(0);
      mock.timers.tick(1);
    }
    sample("idle");
    assert.equal(entries, 1);
    sample("idle");
    assert.equal(entries, 1);
    sample("roam");
    sample("idle");
    assert.equal(entries, 1, "automatic walks are part of the same idle period");
    sample("sleeping");
    sample("idle");
    assert.equal(entries, 2);
  });

  it("tick passes the cursor sample it already read", () => {
    let cursor = { x: 300, y: 260 };
    // Same idle period with and without a companion: identical native traffic.
    function run(withCompanion, eyeResend, eyeTrackingEnabled = true) {
      let cursorCalls = 0;
      let boundsCalls = 0;
      const samples = [];
      const local = loadTickWithScreen(() => { cursorCalls++; return { ...cursor }; });
      const theme = cloneTheme(ctx.theme);
      theme.timings.mouseIdleTimeout = 1e9;
      const c = makeCtx(theme, []);
      const getBounds = c.win.getBounds;
      c.win.getBounds = () => { boundsCalls++; return getBounds(); };
      c.sendToRenderer = () => null;
      c.forceEyeResend = eyeResend;
      c.eyeTrackingEnabled = eyeTrackingEnabled;
      if (withCompanion) c.companion = { tick: (s) => samples.push(s), isAnimating: () => false };
      const api = local.initTick(c);
      api.startMainTick();
      const step = (ms) => { for (let r = ms; r > 0; r -= 50) mock.timers.tick(Math.min(50, r)); };
      const setState = (state) => { c.currentState = state; api.scheduleSoon(0); mock.timers.tick(1); };
      cursor = { x: 300, y: 260 };
      step(1000);
      const still = samples.length;
      cursor = { x: 50, y: 60 };
      step(500);
      const overStart = samples.length;
      setState("roam");
      // The walk moved the pet.
      c.getHitRectScreen = () => ({ left: 500, top: 400, right: 620, bottom: 520 });
      setState("idle");
      const afterWalk = samples.length;
      step(500);
      api.cleanup();
      local.restore();
      return { cursorCalls, boundsCalls, samples, still, overStart, afterWalk };
    }
    const withCompanion = run(true, true);
    const without = run(false, true);
    assert.equal(withCompanion.cursorCalls, without.cursorCalls, "no extra getCursorScreenPoint");
    assert.equal(withCompanion.boundsCalls, without.boundsCalls, "no extra bounds read");

    const s = withCompanion.samples;
    const petRect = { x: 0, y: 0, width: 120, height: 120 };
    // The window bounds read with that hit rect (strike reach geometry).
    const petBounds = { x: 0, y: 0, width: 120, height: 120 };
    assert.ok(withCompanion.still > 2);
    for (const sample of s.slice(0, withCompanion.still)) {
      assert.deepStrictEqual(sample, { x: 300, y: 260, petRect, overPet: false, petBounds });
    }
    assert.deepStrictEqual(s[withCompanion.overStart - 1], { x: 50, y: 60, petRect, overPet: true, petBounds });
    // The pet moved during the walk: never the stale rect.
    const moved = { x: 500, y: 400, width: 120, height: 120 };
    for (const sample of s.slice(withCompanion.afterWalk - 1)) {
      assert.ok(sample === null || JSON.stringify(sample.petRect) === JSON.stringify(moved), JSON.stringify(sample));
    }
    assert.deepStrictEqual(s[s.length - 1], { x: 50, y: 60, petRect: moved, overPet: false, petBounds });

    // No bounds read yet in this idle period (eye tracking off, cursor still):
    // the sample is null.
    const cold = run(true, false, false);
    assert.equal(cold.samples[0], null);
  });

  it("an untrusted cursor (XWayland outside the app windows) reaches the companion as null", () => {
    const seen = [];
    let trusted = true;
    const points = [];
    ctx.isCursorTrusted = (point) => { points.push({ ...point }); return trusted; };
    ctx.forceEyeResend = true;
    ctx.companion.tick = (sample, info) => seen.push([sample, info]);
    start();
    advance(1000);
    assert.ok(seen.length > 0);
    const [sample, info] = seen[seen.length - 1];
    assert.equal(sample && sample.x, 300);
    assert.deepStrictEqual(info, { cursorTrusted: true });
    assert.deepStrictEqual(points[points.length - 1], { x: 300, y: 260 });
    trusted = false;
    const before = seen.length;
    advance(1000);
    assert.ok(seen.length > before);
    for (const [s, i] of seen.slice(before)) {
      assert.equal(s, null);
      assert.deepStrictEqual(i, { cursorTrusted: false });
    }
  });

  it("without a trust hook every cursor read is trusted", () => {
    const seen = [];
    ctx.forceEyeResend = true;
    ctx.companion.tick = (sample, info) => seen.push(info);
    start();
    advance(1000);
    assert.ok(seen.length > 0);
    assert.ok(seen.every((info) => info && info.cursorTrusted === true));
  });

  it("tick reports sleep and work origins", () => {
    const entries = [];
    ctx.companion.noteIdleEntered = (info) => entries.push(info);
    function sample(state, ms = 0) {
      ctx.currentState = state;
      tickApi.scheduleSoon(0);
      mock.timers.tick(1);
      for (let r = ms; r > 0; r -= 1000) mock.timers.tick(Math.min(1000, r));
    }
    start();
    assert.deepStrictEqual(entries, [{ from: "other", awayMs: 0 }]);

    sample("working", 700000);
    sample("idle");
    assert.equal(entries.length, 2);
    assert.equal(entries[1].from, "work");
    assert.ok(entries[1].awayMs >= 700000 && entries[1].awayMs < 702000, String(entries[1].awayMs));

    sample("attention", 3000);
    sample("yawning", 1000);
    sample("sleeping", 5000);
    sample("waking", 1000);
    sample("idle");
    assert.equal(entries[2].from, "sleep");
    assert.ok(entries[2].awayMs >= 10000 && entries[2].awayMs < 12000, String(entries[2].awayMs));

    // A short non-idle blip is not a work stretch.
    sample("thinking", 500);
    sample("idle");
    assert.equal(entries[3].from, "other");

    // Mini mode is the user parking the pet, not work.
    sample("mini-idle", 5000);
    sample("idle");
    assert.equal(entries[4].from, "other");

    // Walks stay part of the idle period (no entry); a walk cut by work counts
    // from the moment idle was left.
    sample("roam", 1000);
    sample("idle");
    assert.equal(entries.length, 5);
    sample("roam", 1000);
    sample("working", 3000);
    sample("idle");
    assert.equal(entries[5].from, "work");
    assert.ok(entries[5].awayMs >= 4000 && entries[5].awayMs < 5000, String(entries[5].awayMs));
  });

  it("without a companion the idle-look and eyes behave as today", () => {
    delete ctx.companion;
    ctx.forceEyeResend = true;
    start();
    assert.ok(calls.some(([channel]) => channel === "eye-move"));
    advance(900);
    assert.deepStrictEqual(idleFiles(), ["clawd-idle-look.svg", ctx.theme.states.idle[0]]);
  });
  // ── gap-hunting: hook isolation, rect freshness, origin classification ──
  function sampleState(state) {
    ctx.currentState = state;
    tickApi.scheduleSoon(0);
    mock.timers.tick(1);
  }

  function kick() {
    tickApi.scheduleSoon(0);
    mock.timers.tick(1);
  }

  it("a throwing companion.tick does not stop the main tick loop", () => {
    let throws = true;
    let later = 0;
    ctx.companion.tick = () => { later++; if (throws) throw new Error("boom"); };
    start();
    const before = later;
    throws = false;
    advance(2000);
    assert.ok(later > before + 1, `loop kept running (later=${later}, before=${before})`);
  });

  it("a throwing hook warns once per label; a throwing roam.tick keeps the loop alive", () => {
    const warns = [];
    const realWarn = console.warn;
    console.warn = (...args) => warns.push(args);
    try {
      let roamTicks = 0;
      let ticks = 0;
      ctx.companion.tick = () => { ticks++; throw new Error("boom"); };
      ctx.roam = { tick() { roamTicks++; throw new Error("roam boom"); } };
      start();
      advance(2000);
      assert.ok(ticks > 1 && roamTicks > 1, `loop kept running (ticks=${ticks}, roam=${roamTicks})`);
    } finally {
      console.warn = realWarn;
    }
    const labels = warns.filter((w) => w[0] === "[tick] companion hook threw:").map((w) => w[1]);
    assert.deepStrictEqual(labels.sort(), ["companion.tick", "roam.tick"]);
    assert.ok(warns.every((w) => w[0] !== "[tick] companion hook threw:" || w[2] instanceof Error));
  });

  it("a throwing companion.noteIdleEntered neither fires twice nor starves the companion", () => {
    let entries = 0;
    let ticks = 0;
    ctx.companion.noteIdleEntered = () => { entries++; throw new Error("boom"); };
    ctx.companion.tick = () => { ticks++; };
    start();
    advance(2000);
    assert.equal(entries, 1, "one idle entry, not one per tick");
    assert.ok(ticks > 1, `companion kept ticking (ticks=${ticks})`);
  });

  it("a throwing idleActivity.noteIdleEntered does not skip the companion entry", () => {
    const entries = [];
    ctx.idleActivity = {
      noteIdleEntered() { throw new Error("boom"); },
      tick() {},
      isAnimating: () => false,
      cancel() {},
    };
    ctx.companion.noteIdleEntered = (info) => entries.push(info);
    start();
    advance(500);
    assert.deepStrictEqual(entries, [{ from: "other", awayMs: 0 }]);
  });

  it("throwing isCursorTrusted counts as trusted; throwing isAnimating counts as not animating", () => {
    const seen = [];
    ctx.isCursorTrusted = () => { throw new Error("boom"); };
    ctx.companion.tick = (sample, info) => seen.push([sample, info]);
    ctx.companion.isAnimating = () => { throw new Error("boom"); };
    ctx.forceEyeResend = true;
    start();
    advance(1000);
    assert.ok(seen.length > 0);
    assert.ok(seen.every(([, info]) => info.cursorTrusted === true));
    // isAnimating failing reads as "no beat": the idle-look is not blocked.
    advance(500);
    assert.ok(idleFiles().includes("clawd-idle-look.svg"));
  });

  it("isCursorTrusted result mapping: only false is untrusted", () => {
    for (const [value, expected] of [[undefined, true], [null, true], [0, true], [true, true], [false, false]]) {
      const seen = [];
      const local = loadTickWithScreen(() => ({ x: 300, y: 260 }));
      const c = makeCtx(cloneTheme(ctx.theme), []);
      c.sendToRenderer = () => null;
      c.forceEyeResend = true;
      c.isCursorTrusted = () => value;
      c.companion = { tick: (s, info) => seen.push([s, info]), isAnimating: () => false };
      const api = local.initTick(c);
      api.startMainTick();
      advance(300);
      api.cleanup();
      local.restore();
      assert.ok(seen.length > 0);
      const [s, info] = seen[seen.length - 1];
      assert.deepStrictEqual(info, { cursorTrusted: expected }, String(value));
      assert.equal(s === null, !expected, `sample null only when untrusted (${value})`);
    }
  });

  it("drag lock gives the companion a null sample and resume reads a fresh rect", () => {
    const seen = [];
    ctx.companion.tick = (sample) => seen.push(sample);
    ctx.forceEyeResend = true;
    start();
    kick();
    assert.ok(seen.length > 0 && seen[seen.length - 1] !== null);

    ctx.dragLocked = true;
    const at = seen.length;
    kick();
    assert.ok(seen.length > at);
    assert.ok(seen.slice(at).every((s) => s === null), "no stale rect while dragging");

    // Released: never the pre-drag rect; either no sample yet or a fresh read.
    ctx.dragLocked = false;
    ctx.getHitRectScreen = () => ({ left: 200, top: 200, right: 400, bottom: 400 });
    const at2 = seen.length;
    kick();
    assert.ok(seen.length > at2);
    for (const s of seen.slice(at2)) {
      assert.ok(s === null || s.petRect.x === 200, JSON.stringify(s));
    }

    ctx.forceEyeResend = true;
    kick();
    const last = seen[seen.length - 1];
    assert.deepStrictEqual(last.petRect, { x: 200, y: 200, width: 200, height: 200 });
    assert.equal(last.overPet, true);
  });

  it("an idle pause drops the rect; resuming re-reads it", () => {
    const seen = [];
    ctx.companion.tick = (sample) => seen.push(sample);
    ctx.forceEyeResend = true;
    start();
    kick();
    ctx.idlePaused = true;
    const at = seen.length;
    kick();
    assert.equal(seen.length, at, "no companion tick while paused");
    ctx.idlePaused = false;
    ctx.getHitRectScreen = () => ({ left: 10, top: 10, right: 50, bottom: 50 });
    ctx.forceEyeResend = true;
    kick();
    const fresh = seen.slice(at).filter((s) => s !== null);
    assert.ok(fresh.length > 0);
    assert.deepStrictEqual(fresh[fresh.length - 1].petRect, { x: 10, y: 10, width: 40, height: 40 });
  });

  it("a size change with a still cursor refreshes the rect and bounds when forceEyeResend is set", () => {
    const seen = [];
    ctx.companion.tick = (sample) => seen.push(sample);
    ctx.forceEyeResend = true;
    start();
    kick();
    assert.deepStrictEqual(seen[seen.length - 1].petRect, { x: 0, y: 0, width: 120, height: 120 });
    ctx.win.getBounds = () => ({ x: 0, y: 0, width: 240, height: 240 });
    ctx.getHitRectScreen = () => ({ left: 0, top: 0, right: 240, bottom: 240 });
    ctx.forceEyeResend = true;
    kick();
    const last = seen[seen.length - 1];
    assert.deepStrictEqual(last.petRect, { x: 0, y: 0, width: 240, height: 240 });
    assert.deepStrictEqual(last.petBounds, { x: 0, y: 0, width: 240, height: 240 });
  });

  it("overPet is inclusive on every edge, including negative multi-display coordinates", () => {
    const cases = [
      [{ x: 120, y: 120 }, true],
      [{ x: 0, y: 0 }, true],
      [{ x: 121, y: 60 }, false],
      [{ x: 60, y: 121 }, false],
      [{ x: -1, y: 60 }, false],
    ];
    for (const [cursor, expected] of cases) {
      const seen = [];
      const local = loadTickWithScreen(() => ({ ...cursor }));
      const c = makeCtx(cloneTheme(ctx.theme), []);
      c.sendToRenderer = () => null;
      c.forceEyeResend = true;
      c.companion = { tick: (s) => seen.push(s), isAnimating: () => false };
      const api = local.initTick(c);
      api.startMainTick();
      advance(200);
      api.cleanup();
      local.restore();
      assert.equal(seen[seen.length - 1].overPet, expected, JSON.stringify(cursor));
    }
    // Pet on a display left of the primary one.
    const seen = [];
    const local = loadTickWithScreen(() => ({ x: -1920, y: -50 }));
    const c = makeCtx(cloneTheme(ctx.theme), []);
    c.sendToRenderer = () => null;
    c.forceEyeResend = true;
    c.getHitRectScreen = () => ({ left: -1920, top: -50, right: -1800, bottom: 70 });
    c.companion = { tick: (s) => seen.push(s), isAnimating: () => false };
    const api = local.initTick(c);
    api.startMainTick();
    advance(200);
    api.cleanup();
    local.restore();
    assert.equal(seen[seen.length - 1].overPet, true);
    assert.deepStrictEqual(seen[seen.length - 1].petRect, { x: -1920, y: -50, width: 120, height: 120 });
  });

  describe("idle origin classification with an injected clock", () => {
    let clock;
    let entries;

    function originCtx() {
      clock = { t: 1_000_000 };
      entries = [];
      ctx.now = () => clock.t;
      ctx.companion.noteIdleEntered = (info) => entries.push(info);
      ctx.currentState = "working";
      start();
    }

    it("a clock that went back 10 minutes reports awayMs 0 and origin other", () => {
      originCtx();
      clock.t -= 600_000;
      sampleState("idle");
      assert.deepStrictEqual(entries, [{ from: "other", awayMs: 0 }]);
    });

    it("a clock that jumped 8 hours forward is a work stretch", () => {
      originCtx();
      clock.t += 8 * 3600_000;
      sampleState("idle");
      assert.equal(entries[0].from, "work");
      assert.equal(entries[0].awayMs, 8 * 3600_000);
    });

    it("an idle pause is not work", () => {
      originCtx();
      ctx.currentState = "idle";
      ctx.idlePaused = true;
      clock.t += 60_000;
      tickApi.scheduleSoon(0);
      mock.timers.tick(1);
      ctx.idlePaused = false;
      tickApi.scheduleSoon(0);
      mock.timers.tick(1);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].from, "work", "the preceding working stretch still counts");
      entries.length = 0;
      sampleState("working");
      clock.t += 60_000;
      ctx.currentState = "idle";
      ctx.idlePaused = true;
      tickApi.scheduleSoon(0);
      mock.timers.tick(1);
      assert.deepStrictEqual(entries, []);
    });

    it("MIN_WORK_AWAY_MS is inclusive at 2000 and excluded at 1999", () => {
      originCtx();
      clock.t += 1999;
      sampleState("idle");
      assert.equal(entries[0].from, "other");
      assert.equal(entries[0].awayMs, 1999);
      sampleState("working");
      clock.t += 2000;
      sampleState("idle");
      assert.equal(entries[1].from, "work");
      assert.equal(entries[1].awayMs, 2000);
    });

    it("sleep wins over work regardless of duration", () => {
      originCtx();
      clock.t += 10_000;
      sampleState("sleeping");
      clock.t += 10;
      sampleState("working");
      clock.t += 100_000;
      sampleState("idle");
      assert.equal(entries[0].from, "sleep");
    });
  });
});
