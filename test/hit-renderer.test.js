"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const HIT_RENDERER = path.join(__dirname, "..", "src", "hit-renderer.js");
const SOURCE = fs.readFileSync(HIT_RENDERER, "utf8").replace(/\r\n/g, "\n");
const PET_STROKE_DETECTOR = require("../src/pet-stroke-detector");

class FakeArea {
  constructor() {
    this.style = {};
    this.classList = {
      _set: new Set(),
      add: (c) => this.classList._set.add(c),
      remove: (c) => this.classList._set.delete(c),
    };
    this.offsetWidth = 200;
    this.listeners = new Map();
  }
  addEventListener(event, cb) { this.listeners.set(event, cb); }
  setPointerCapture() {}
}

function createHarness({ isMac = false, sendState = {}, detector = false } = {}) {
  const apiCalls = [];
  const apiHandlers = {};
  const area = new FakeArea();
  const windowListeners = new Map();
  // Clawd Alive: the real petting detector, loaded from its file, driven by a
  // fake clock so stroke timing is deterministic. Absent by default, exactly
  // like hit windows built before the <script> tag existed.
  const clock = { now: 1000 };
  const petStrokeDetector = detector ? {
    PET_STROKE: PET_STROKE_DETECTOR.PET_STROKE,
    createPetStrokeDetector: () => PET_STROKE_DETECTOR.createPetStrokeDetector({ now: () => clock.now }),
  } : undefined;

  const fakeDocument = {
    getElementById(id) { return id === "hit-area" ? area : null; },
    addEventListener(event, cb) {
      if (!fakeDocument._listeners) fakeDocument._listeners = new Map();
      fakeDocument._listeners.set(event, cb);
    },
    _dispatch(event, payload) {
      const cb = fakeDocument._listeners && fakeDocument._listeners.get(event);
      if (cb) cb(payload);
    },
  };

  const timers = [];
  let timerId = 0;
  const context = {
    document: fakeDocument,
    window: {
      hitPlatform: { isMac, platform: isMac ? "darwin" : "win32" },
      hitThemeConfig: { reactions: {
        double: { file: "flail.svg", duration: 3500 },
        annoyed: { file: "annoyed.svg", duration: 3500 },
        clickLeft: { file: "left.svg", duration: 2500 },
        clickRight: { file: "right.svg", duration: 2500 },
      } },
      hitAPI: {
        onThemeConfig: (cb) => { apiHandlers.themeConfig = cb; },
        dragLock: (v) => apiCalls.push(["dragLock", v]),
        dragMove: () => apiCalls.push(["dragMove"]),
        dragEnd: () => apiCalls.push(["dragEnd"]),
        showContextMenu: () => apiCalls.push(["showContextMenu"]),
        focusTerminal: () => apiCalls.push(["focusTerminal"]),
        exitMiniMode: () => apiCalls.push(["exitMiniMode"]),
        showDashboard: () => apiCalls.push(["showDashboard"]),
        revealSessionHud: () => apiCalls.push(["revealSessionHud"]),
        startDragReaction: (direction) => apiCalls.push(["startDragReaction", direction]),
        endDragReaction: () => apiCalls.push(["endDragReaction"]),
        playClickReaction: (svg, d) => apiCalls.push(["playClickReaction", svg, d]),
        onStateSync: (cb) => { apiHandlers.stateSync = cb; },
        onCancelReaction: (cb) => { apiHandlers.cancelReaction = cb; },
        onForceDragRelease: (cb) => { apiHandlers.forceDragRelease = cb; },
        // Drop bridge (#459): fake files carry .path; "" mimics webUtils
        // returning nothing for non-filesystem Files.
        getPathForFile: (file) => (file && file.path) || "",
        dropPaths: (paths) => apiCalls.push(["dropPaths", paths]),
        onDropAccepted: (cb) => { apiHandlers.dropAccepted = cb; },
        petGesture: (kind) => apiCalls.push(["petGesture", kind]),
      },
      ClawdPetStrokeDetector: petStrokeDetector,
      addEventListener: (event, cb) => {
        if (!windowListeners.has(event)) windowListeners.set(event, []);
        windowListeners.get(event).push(cb);
      },
    },
    setTimeout: (cb, ms) => {
      const t = { id: ++timerId, cb, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimeout: (t) => { if (t) t.cleared = true; },
    requestAnimationFrame: (cb) => context.setTimeout(cb, 16),
    cancelAnimationFrame: (t) => context.clearTimeout(t),
    console: { warn() {} },
  };
  context.globalThis = context;

  vm.runInNewContext(SOURCE, context);

  // Apply initial state if provided
  if (apiHandlers.stateSync && Object.keys(sendState).length) {
    apiHandlers.stateSync(sendState);
  } else if (apiHandlers.stateSync) {
    // Default: idle, non-mini, non-DND
    apiHandlers.stateSync({ currentState: "idle", miniMode: false, dndEnabled: false });
  }

  function pointerup({ button = 0, ctrlKey = false, metaKey = false, clientX = 100 } = {}) {
    fakeDocument._dispatch("pointerup", { button, ctrlKey, metaKey, clientX });
  }

  function pointerdown({ button = 0, pointerId = 1, clientX = 100, clientY = 100 } = {}) {
    const cb = area.listeners.get("pointerdown");
    if (cb) cb({ button, pointerId, clientX, clientY });
  }

  function pointermove({ clientX = 100, clientY = 100, buttons = 1 } = {}) {
    fakeDocument._dispatch("pointermove", { clientX, clientY, buttons });
  }

  function pointerenter({ clientX = 100, clientY = 100 } = {}) {
    const cb = area.listeners.get("pointerenter");
    if (cb) cb({ clientX, clientY, buttons: 0 });
  }

  function pointerleave() {
    const cb = area.listeners.get("pointerleave");
    if (cb) cb({ buttons: 0 });
  }

  function windowEvent(event) {
    for (const cb of windowListeners.get(event) || []) cb({});
  }

  function fireTimer(predicate) {
    const t = timers.find((x) => !x.cleared && predicate(x));
    if (!t) return false;
    t.cleared = true;
    t.cb();
    return true;
  }

  return {
    apiCalls, apiHandlers, pointerdown, pointermove, pointerup, pointerenter, pointerleave,
    windowEvent, fireTimer, timers, area, context, clock,
  };
}

describe("hit-renderer input layer", () => {
  it("plain single click reveals HUD, does NOT call focusTerminal", () => {
    const h = createHarness();
    h.pointerup({});
    const names = h.apiCalls.map((c) => c[0]);
    assert.ok(names.includes("revealSessionHud"), "should call revealSessionHud");
    assert.ok(!names.includes("focusTerminal"), "must not call focusTerminal");
  });

  it("Ctrl+click on non-mac opens Dashboard, does NOT call reveal", () => {
    const h = createHarness({ isMac: false });
    h.pointerup({ ctrlKey: true });
    const names = h.apiCalls.map((c) => c[0]);
    assert.ok(names.includes("showDashboard"), "should open Dashboard");
    assert.ok(!names.includes("revealSessionHud"), "must not reveal HUD on Ctrl+click");
  });

  it("Cmd+click on mac opens Dashboard", () => {
    const h = createHarness({ isMac: true });
    h.pointerup({ metaKey: true });
    const names = h.apiCalls.map((c) => c[0]);
    assert.ok(names.includes("showDashboard"));
    assert.ok(!names.includes("revealSessionHud"));
  });

  it("Ctrl+click on mac does NOT open Dashboard and does NOT reveal (system right-click)", () => {
    const h = createHarness({ isMac: true });
    h.pointerup({ ctrlKey: true });
    const names = h.apiCalls.map((c) => c[0]);
    assert.ok(!names.includes("showDashboard"), "mac Ctrl+click must not trigger Dashboard");
    assert.ok(!names.includes("revealSessionHud"), "mac Ctrl+click must not reveal HUD");
  });

  it("miniMode + plain click calls exitMiniMode (not reveal)", () => {
    const h = createHarness();
    h.apiHandlers.stateSync({ miniMode: true });
    h.pointerup({});
    const names = h.apiCalls.map((c) => c[0]);
    assert.ok(names.includes("exitMiniMode"), "miniMode plain click should exit mini");
    assert.ok(!names.includes("revealSessionHud"), "miniMode plain click should not reveal HUD");
  });

  it("miniMode + Ctrl+click goes to Dashboard, does NOT exit mini (preserves pre-v5 behavior)", () => {
    const h = createHarness({ isMac: false });
    h.apiHandlers.stateSync({ miniMode: true });
    h.pointerup({ ctrlKey: true });
    const names = h.apiCalls.map((c) => c[0]);
    assert.ok(names.includes("showDashboard"), "Ctrl+click in mini should still open Dashboard");
    assert.ok(!names.includes("exitMiniMode"), "Ctrl+click in mini must NOT exit mini");
  });

  it("does not trigger reveal in working state but still reveals HUD on click (gating is for reactions only)", () => {
    const h = createHarness();
    h.apiHandlers.stateSync({ currentState: "working" });
    h.pointerup({});
    const names = h.apiCalls.map((c) => c[0]);
    // v5 change: reveal HUD even in non-idle states (so user can peek progress)
    assert.ok(names.includes("revealSessionHud"));
    assert.ok(!names.includes("focusTerminal"));
  });

  it("DND + double click does NOT play reaction (canPlayReactionNow fresh-read)", () => {
    const h = createHarness();
    h.apiHandlers.stateSync({ dndEnabled: true });
    h.pointerup({});
    h.pointerup({});
    // Fire the reaction timer
    h.fireTimer((t) => t.ms === 400);
    const names = h.apiCalls.map((c) => c[0]);
    assert.ok(!names.includes("playClickReaction"), "DND must gate reaction playback");
  });

  it("Ctrl+click resets click accumulator (no stale double-click)", () => {
    const h = createHarness({ isMac: false });
    h.pointerup({});            // plain click 1 — accumulates
    h.pointerup({ ctrlKey: true }); // Ctrl+click should reset
    h.pointerup({});            // plain click 2 — must be a fresh first click
    // Fire the reset timer (single-click path schedules 400ms reset)
    h.fireTimer((t) => t.ms === 400);
    const names = h.apiCalls.map((c) => c[0]);
    // No double-click reaction should fire from "1 + reset + 1"
    assert.ok(!names.includes("playClickReaction"),
      "Ctrl+click between plain clicks should not produce a double-click reaction");
  });

  it("cancel-reaction clears reactionTimer + accumulator", () => {
    const h = createHarness();
    h.pointerup({});
    h.pointerup({});  // clickCount=2, sets reactionTimer
    h.apiHandlers.cancelReaction();
    // Subsequent timer fire should be no-op (cleared)
    const before = h.apiCalls.length;
    h.fireTimer((t) => t.ms === 400);
    assert.strictEqual(h.apiCalls.length, before,
      "after cancelReaction, no new reaction should fire");
  });

  it("updates the drag reaction when horizontal direction changes", () => {
    const h = createHarness();
    h.pointerdown({ clientX: 100, clientY: 100 });
    h.pointermove({ clientX: 90, clientY: 100 });
    h.pointermove({ clientX: 80, clientY: 100 });
    h.pointermove({ clientX: 95, clientY: 100 });

    assert.deepStrictEqual(
      h.apiCalls.filter((call) => call[0] === "startDragReaction"),
      [
        ["startDragReaction", "left"],
        ["startDragReaction", "right"],
      ]
    );
  });

  for (const [terminalEvent, finishDrag] of [
    ["pointerup", (h) => h.pointerup({ clientX: 90 })],
    ["pointercancel", (h) => h.area.listeners.get("pointercancel")()],
    ["lostpointercapture", (h) => h.area.listeners.get("lostpointercapture")()],
  ]) {
    it(`ends an actual drag on ${terminalEvent} after a late cancel cleared the local reaction flag`, () => {
      const h = createHarness();
      h.pointerdown({ clientX: 100, clientY: 100 });
      h.pointermove({ clientX: 90, clientY: 100 });

      h.apiHandlers.cancelReaction();
      finishDrag(h);

      assert.deepStrictEqual(
        h.apiCalls.filter((call) => call[0] === "endDragReaction"),
        [["endDragReaction"]]
      );
    });
  }

  it("does not send a drag-reaction end for a click below the drag threshold", () => {
    const h = createHarness();
    h.pointerdown({ clientX: 100, clientY: 100 });
    h.pointerup({ clientX: 100 });

    assert.deepStrictEqual(
      h.apiCalls.filter((call) => call[0] === "endDragReaction"),
      []
    );
  });
});

describe("hit-renderer OS file drop (#459)", () => {
  function makeDragEvent({ types = ["Files"], files = [] } = {}) {
    return {
      prevented: false,
      preventDefault() { this.prevented = true; },
      dataTransfer: { types, files, dropEffect: "" },
    };
  }

  it("macOS registers no drop machinery at all: no listeners, no affordance, no accept handler", () => {
    const h = createHarness({ isMac: true });
    assert.strictEqual(h.area.listeners.get("dragover"), undefined);
    assert.strictEqual(h.area.listeners.get("drop"), undefined);
    assert.strictEqual(h.apiHandlers.dropAccepted, undefined);
  });

  it("dragover with files shows the copy affordance outside mini mode", () => {
    const h = createHarness();
    const evt = makeDragEvent();
    h.area.listeners.get("dragover")(evt);
    assert.strictEqual(evt.prevented, true);
    assert.strictEqual(evt.dataTransfer.dropEffect, "copy");
  });

  it("dragover gives no affordance in mini mode or for non-file drags", () => {
    const mini = createHarness({ sendState: { currentState: "idle", miniMode: true, dndEnabled: false } });
    const miniEvt = makeDragEvent();
    mini.area.listeners.get("dragover")(miniEvt);
    assert.strictEqual(miniEvt.prevented, false);
    assert.strictEqual(miniEvt.dataTransfer.dropEffect, "");

    const h = createHarness();
    const textEvt = makeDragEvent({ types: ["text/plain"] });
    h.area.listeners.get("dragover")(textEvt);
    assert.strictEqual(textEvt.prevented, false);
  });

  it("drop resolves paths through the preload bridge, filtering non-filesystem Files", () => {
    const h = createHarness();
    const evt = makeDragEvent({ files: [{ path: "" }, { path: "/proj/dir" }, { path: "/other" }] });
    h.area.listeners.get("drop")(evt);
    assert.strictEqual(evt.prevented, true);
    // Array.from: the paths array is born in the vm realm — copy it into the
    // host realm so deepStrictEqual's prototype check passes.
    const dropCalls = h.apiCalls
      .filter((c) => c[0] === "dropPaths")
      .map((c) => [c[0], Array.from(c[1])]);
    assert.deepStrictEqual(dropCalls, [["dropPaths", ["/proj/dir", "/other"]]]);
  });

  it("drop sends nothing when every File lacks a filesystem path", () => {
    const h = createHarness();
    const evt = makeDragEvent({ files: [{ path: "" }] });
    h.area.listeners.get("drop")(evt);
    assert.deepStrictEqual(h.apiCalls.filter((c) => c[0] === "dropPaths"), []);
  });

  it("drop is inert in mini mode even if the event slips through", () => {
    const h = createHarness({ sendState: { currentState: "idle", miniMode: true, dndEnabled: false } });
    const evt = makeDragEvent({ files: [{ path: "/proj" }] });
    h.area.listeners.get("drop")(evt);
    assert.deepStrictEqual(h.apiCalls.filter((c) => c[0] === "dropPaths"), []);
  });

  it("accepted drop plays the double reaction through the local isReacting gate", () => {
    const h = createHarness();
    h.apiHandlers.dropAccepted();
    assert.deepStrictEqual(
      h.apiCalls.filter((c) => c[0] === "playClickReaction"),
      [["playClickReaction", "flail.svg", 3500]]
    );
    // While reacting, a second accept must not stack another animation.
    h.apiHandlers.dropAccepted();
    assert.strictEqual(h.apiCalls.filter((c) => c[0] === "playClickReaction").length, 1);
  });

  it("accepted drop falls back to the click poke for double-less themes (Calico)", () => {
    const h = createHarness();
    h.apiHandlers.themeConfig({ reactions: {
      clickLeft: { file: "left.svg", duration: 2500 },
      clickRight: { file: "right.svg", duration: 2500 },
      drag: { file: "drag.svg" },
    } });
    h.apiHandlers.dropAccepted();
    const plays = h.apiCalls.filter((c) => c[0] === "playClickReaction");
    assert.strictEqual(plays.length, 1);
    assert.ok(["left.svg", "right.svg"].includes(plays[0][1]), plays[0][1]);
    assert.strictEqual(plays[0][2], 2500);
  });

  it("accepted drop stays silent for drag-only themes (Cloudling) or a busy pet", () => {
    const noReact = createHarness();
    noReact.apiHandlers.themeConfig({ reactions: { drag: { file: "drag.svg" } } });
    noReact.apiHandlers.dropAccepted();
    assert.deepStrictEqual(noReact.apiCalls.filter((c) => c[0] === "playClickReaction"), []);

    const busy = createHarness({ sendState: { currentState: "working", miniMode: false, dndEnabled: false } });
    busy.apiHandlers.dropAccepted();
    assert.deepStrictEqual(busy.apiCalls.filter((c) => c[0] === "playClickReaction"), []);
  });
});

describe("hit-renderer stranded drag release", () => {
  it("releases a stranded drag on the first buttons=0 move (swallowed pointerup)", () => {
    const h = createHarness();
    h.pointerdown({});
    h.pointermove({ clientX: 120, clientY: 120, buttons: 1 });
    assert.deepStrictEqual(
      h.apiCalls.filter((c) => c[0] === "dragLock").map((c) => c[1]),
      [true],
      "a held move must keep the lock",
    );

    // The physical button is up but pointerup was swallowed; the hover move
    // is the only surviving signal that the gesture ended.
    h.pointermove({ clientX: 140, clientY: 140, buttons: 0 });

    assert.deepStrictEqual(
      h.apiCalls.filter((c) => c[0] === "dragLock").map((c) => c[1]),
      [true, false],
      "buttons=0 during a drag must release the lock",
    );
  });

  it("a held-still drag emits no moves and is never cut short by the buttons check", () => {
    const h = createHarness();
    h.pointerdown({});
    // No pointermove at all while the button is held: nothing can look like a
    // release. Only an explicit end signal or a forced release unwinds it.
    assert.deepStrictEqual(
      h.apiCalls.filter((c) => c[0] === "dragLock").map((c) => c[1]),
      [true],
      "a still long press must stay locked",
    );
    h.pointerup({});
    assert.deepStrictEqual(
      h.apiCalls.filter((c) => c[0] === "dragLock").map((c) => c[1]),
      [true, false],
    );
  });

  it("a released lock after a buttons=0 move still reports the drag end once", () => {
    const h = createHarness();
    h.pointerdown({});
    h.pointermove({ clientX: 130, clientY: 130, buttons: 1 });
    h.pointermove({ clientX: 150, clientY: 150, buttons: 0 });

    assert.strictEqual(
      h.apiCalls.filter((c) => c[0] === "dragEnd").length,
      1,
      "a real move followed by a lost pointerup must still close the drag",
    );
    // The later real pointerup must not double-report.
    h.pointerup({ clientX: 150 });
    assert.strictEqual(
      h.apiCalls.filter((c) => c[0] === "dragEnd").length,
      1,
      "drag end must not be reported twice",
    );
  });

  it("drops a phantom drag on force-drag-release and stays idempotent", () => {
    const h = createHarness();
    h.pointerdown({});
    h.apiHandlers.forceDragRelease();

    assert.deepStrictEqual(
      h.apiCalls.filter((c) => c[0] === "dragLock").map((c) => c[1]),
      [true, false],
      "force release should run the normal stop path",
    );
    // A later pointerup must not re-send drag-lock(false): isDragging was
    // already dropped, so the next real gesture starts clean.
    h.pointerup({});
    assert.deepStrictEqual(
      h.apiCalls.filter((c) => c[0] === "dragLock").map((c) => c[1]),
      [true, false],
    );
  });

  it("does not start a drag in mini mode, so buttons=0 has nothing to release", () => {
    const h = createHarness({ sendState: { currentState: "idle", miniMode: true, dndEnabled: false } });
    h.pointerdown({});
    h.pointermove({ clientX: 140, clientY: 140, buttons: 0 });
    assert.deepStrictEqual(h.apiCalls.filter((c) => c[0] === "dragLock"), []);
  });
});

describe("hit-renderer context menu during drag (#1260)", () => {
  function contextmenu(h) {
    h.context.document._dispatch("contextmenu", { preventDefault() {} });
  }

  it("ends an active drag through the normal stop path BEFORE showing the menu", () => {
    const h = createHarness();
    h.pointerdown({});
    h.pointermove({ clientX: 120, clientY: 120, buttons: 1 });
    contextmenu(h);

    const names = h.apiCalls.map((c) => c[0]);
    const menuAt = names.indexOf("showContextMenu");
    assert.ok(menuAt >= 0, "the context menu request must still go out");
    assert.ok(
      menuAt > names.lastIndexOf("dragLock") && menuAt > names.lastIndexOf("dragEnd"),
      "release + drag end must precede the menu request",
    );
    assert.deepStrictEqual(
      h.apiCalls.filter((c) => c[0] === "dragLock").map((c) => c[1]),
      [true, false],
    );
    assert.strictEqual(names.filter((n) => n === "dragEnd").length, 1);

    // The menu's modal loop may additionally swallow everything; the gesture
    // state is already clean, so no later stray event may double-report.
    h.pointermove({ clientX: 140, clientY: 140, buttons: 0 });
    h.pointerup({ clientX: 140 });
    assert.deepStrictEqual(
      h.apiCalls.filter((c) => c[0] === "dragLock").map((c) => c[1]),
      [true, false],
      "the strand must not reappear after the menu",
    );
    assert.strictEqual(
      h.apiCalls.filter((c) => c[0] === "dragEnd").length,
      1,
      "drag end must not be reported twice",
    );
  });

  it("releases a held-still grab on right-click without inventing a drag end", () => {
    const h = createHarness();
    h.pointerdown({});
    contextmenu(h);

    assert.deepStrictEqual(
      h.apiCalls.filter((c) => c[0] === "dragLock").map((c) => c[1]),
      [true, false],
    );
    const names = h.apiCalls.map((c) => c[0]);
    assert.ok(!names.includes("dragEnd"), "no movement means no drag end");
    assert.ok(names.includes("showContextMenu"));
  });

  it("plain right-click without a drag shows the menu with no lock traffic", () => {
    const h = createHarness();
    contextmenu(h);
    assert.deepStrictEqual(h.apiCalls, [["showContextMenu"]]);
  });
});

// ── Clawd Alive: petting and hover gestures (Task 9) ──
describe("hit-renderer pet gestures", () => {
  const GESTURES_ON = { currentState: "idle", miniMode: false, dndEnabled: false, petGesturesEnabled: true };

  function gestureHarness(opts = {}) {
    return createHarness({ detector: true, sendState: GESTURES_ON, ...opts });
  }

  function gestures(h) {
    return h.apiCalls.filter((c) => c[0] === "petGesture").map((c) => c[1]);
  }

  // Hover strokes: x swings by 20 px with no button pressed, 100 ms apart.
  function stroke(h, xs = [100, 120, 100, 120]) {
    for (const x of xs) {
      h.clock.now += 100;
      h.pointermove({ clientX: x, clientY: 100, buttons: 0 });
    }
  }

  function startPetting(h) {
    h.pointerenter({ clientX: 100, clientY: 100 });
    stroke(h);
    assert.deepStrictEqual(gestures(h), ["pet-start"]);
  }

  function liveTimers(h, ms) {
    return h.timers.filter((t) => !t.cleared && t.ms === ms);
  }

  it("gestures disabled by default send nothing", () => {
    // Detector loaded but the flag never arrived: identical to today.
    const h = createHarness({ detector: true });
    h.pointerenter({ clientX: 100, clientY: 100 });
    stroke(h, [100, 120, 100, 120, 100, 120, 100]);
    h.pointerleave();
    assert.deepStrictEqual(h.apiCalls, []);
    assert.deepStrictEqual(h.timers.filter((t) => !t.cleared), []);

    // Flag on but no detector script (old hit.html / other harnesses): inert.
    const bare = createHarness({ sendState: GESTURES_ON });
    bare.pointerenter({ clientX: 100, clientY: 100 });
    stroke(bare, [100, 120, 100, 120, 100, 120, 100]);
    assert.deepStrictEqual(bare.apiCalls, []);
    assert.deepStrictEqual(bare.timers.filter((t) => !t.cleared), []);
  });

  it("hover strokes send pet-start", () => {
    const h = gestureHarness();
    startPetting(h);
    // Nothing else is sent: no lock, no drag, no reaction.
    assert.deepStrictEqual(h.apiCalls.map((c) => c[0]), ["petGesture"]);
    // The 500 ms poll exists only while the detector is active.
    assert.strictEqual(liveTimers(h, 500).length, 1);
    h.fireTimer((t) => t.ms === 500); // 400 ms after the last stroke: still active
    assert.strictEqual(liveTimers(h, 500).length, 1);
    h.clock.now += 1000;
    h.fireTimer((t) => t.ms === 500);
    assert.deepStrictEqual(gestures(h), ["pet-start", "pet-end"]);
    assert.strictEqual(liveTimers(h, 500).length, 0, "poll stops once petting ends");
  });

  it("stationary hover sends nothing", () => {
    const h = gestureHarness();
    h.pointerenter({ clientX: 100, clientY: 100 });
    for (let i = 0; i < 10; i++) {
      h.clock.now += 100;
      h.pointermove({ clientX: 100 + (i % 2), clientY: 100, buttons: 0 });
    }
    assert.deepStrictEqual(gestures(h), []);
    assert.strictEqual(liveTimers(h, 500).length, 0);
  });

  it("hover dwell fires once per entry", () => {
    const h = gestureHarness();
    h.pointerenter({ clientX: 100, clientY: 100 });
    assert.strictEqual(liveTimers(h, 1200).length, 1);
    h.pointermove({ clientX: 102, clientY: 101, buttons: 0 }); // within 3 px
    assert.ok(h.fireTimer((t) => t.ms === 1200));
    assert.deepStrictEqual(gestures(h), ["hover-dwell"]);
    // Staying inside does not re-arm it.
    h.pointermove({ clientX: 101, clientY: 100, buttons: 0 });
    assert.strictEqual(liveTimers(h, 1200).length, 0);

    // Leaving cancels; a fresh entry arms again; moving > 3 px cancels.
    h.pointerleave();
    h.pointerenter({ clientX: 50, clientY: 50 });
    assert.strictEqual(liveTimers(h, 1200).length, 1);
    h.pointerleave();
    assert.strictEqual(liveTimers(h, 1200).length, 0);
    h.pointerenter({ clientX: 50, clientY: 50 });
    h.pointermove({ clientX: 55, clientY: 50, buttons: 0 });
    // Drift restarts the countdown from the new spot (it no longer dies).
    assert.strictEqual(liveTimers(h, 1200).length, 1);
    h.pointerenter({ clientX: 50, clientY: 50 });
    h.fireTimer((t) => t.ms === 1200);
    // The leave after the first dwell reports one hover-move (mischief catch).
    assert.deepStrictEqual(gestures(h), ["hover-dwell", "hover-move", "hover-dwell"]);
  });

  it("dwell fires after the cursor settles even if it drifted after entering", () => {
    const h = gestureHarness();
    h.pointerenter({ clientX: 100, clientY: 100 });
    h.pointermove({ clientX: 110, clientY: 100, buttons: 0 });
    assert.strictEqual(liveTimers(h, 1200).length, 1);
    assert.ok(h.fireTimer((t) => t.ms === 1200));
    assert.deepStrictEqual(gestures(h), ["hover-dwell"]);
  });

  it("continuous small drifts under the slop still fire", () => {
    const h = gestureHarness();
    h.pointerenter({ clientX: 100, clientY: 100 });
    for (const x of [101, 102, 101, 103, 102]) h.pointermove({ clientX: x, clientY: 100, buttons: 0 });
    assert.strictEqual(liveTimers(h, 1200).length, 1);
    assert.ok(h.fireTimer((t) => t.ms === 1200));
    assert.deepStrictEqual(gestures(h), ["hover-dwell"]);
  });

  it("moving keeps postponing the dwell", () => {
    const h = gestureHarness();
    h.pointerenter({ clientX: 100, clientY: 100 });
    for (let i = 1; i <= 6; i++) {
      h.clock.now += 500;
      h.pointermove({ clientX: 100 + i * 10, clientY: 100, buttons: 0 });
      assert.strictEqual(liveTimers(h, 1200).length, 1, "exactly one live countdown");
    }
    assert.deepStrictEqual(gestures(h), []);
    assert.ok(h.fireTimer((t) => t.ms === 1200));
    assert.deepStrictEqual(gestures(h), ["hover-dwell"]);
  });

  it("only one dwell per entry", () => {
    const h = gestureHarness();
    h.pointerenter({ clientX: 100, clientY: 100 });
    h.fireTimer((t) => t.ms === 1200);
    h.pointermove({ clientX: 101, clientY: 100, buttons: 0 });
    assert.strictEqual(liveTimers(h, 1200).length, 0);
    h.pointermove({ clientX: 140, clientY: 100, buttons: 0 });
    assert.strictEqual(liveTimers(h, 1200).length, 0);
    assert.deepStrictEqual(gestures(h), ["hover-dwell", "hover-move"]);
  });

  it("no dwell while petting is active", () => {
    const h = gestureHarness();
    startPetting(h);
    assert.strictEqual(liveTimers(h, 1200).length, 0);
    h.pointermove({ clientX: 100, clientY: 100, buttons: 0 });
    assert.strictEqual(liveTimers(h, 1200).length, 0);
    assert.deepStrictEqual(gestures(h), ["pet-start"]);
  });

  it("hover-move is sent once after a dwell", () => {
    const h = gestureHarness();
    // No dwell yet: moving or leaving sends nothing.
    h.pointerenter({ clientX: 100, clientY: 100 });
    h.pointerleave();
    assert.deepStrictEqual(gestures(h), []);

    h.pointerenter({ clientX: 100, clientY: 100 });
    h.pointermove({ clientX: 101, clientY: 100, buttons: 0 });
    h.fireTimer((t) => t.ms === 1200);
    // Within 3 px of where the dwell fired: still nothing.
    h.pointermove({ clientX: 103, clientY: 101, buttons: 0 });
    assert.deepStrictEqual(gestures(h), ["hover-dwell"]);
    h.pointermove({ clientX: 110, clientY: 100, buttons: 0 });
    assert.deepStrictEqual(gestures(h), ["hover-dwell", "hover-move"]);
    // Once per dwell: more moves and the leave send nothing else.
    h.pointermove({ clientX: 130, clientY: 100, buttons: 0 });
    h.pointerleave();
    assert.deepStrictEqual(gestures(h), ["hover-dwell", "hover-move"]);

    // Next entry: dwell then leave sends it.
    h.pointerenter({ clientX: 50, clientY: 50 });
    h.fireTimer((t) => t.ms === 1200);
    h.pointerleave();
    assert.deepStrictEqual(gestures(h), ["hover-dwell", "hover-move", "hover-dwell", "hover-move"]);

    // The flag clears on the next entry even when the dwell was never resolved.
    h.pointerenter({ clientX: 50, clientY: 50 });
    h.fireTimer((t) => t.ms === 1200);
    h.pointerenter({ clientX: 50, clientY: 50 });
    h.pointerleave();
    assert.deepStrictEqual(gestures(h).slice(4), ["hover-dwell"]);

    // Gestures off: nothing at all.
    const off = createHarness({ detector: true });
    off.pointerenter({ clientX: 100, clientY: 100 });
    off.fireTimer((t) => t.ms === 1200);
    off.pointermove({ clientX: 130, clientY: 100, buttons: 0 });
    off.pointerleave();
    assert.deepStrictEqual(off.apiCalls, []);
  });

  it("pointerdown during petting ends petting and still starts drag lock", () => {
    const h = gestureHarness();
    startPetting(h);
    h.pointerdown({ clientX: 120, clientY: 100 });
    assert.deepStrictEqual(
      h.apiCalls.map((c) => c.slice(0, 2)),
      [["petGesture", "pet-start"], ["petGesture", "pet-end"], ["dragLock", true]],
    );
    assert.strictEqual(liveTimers(h, 500).length, 0);
    assert.strictEqual(liveTimers(h, 1200).length, 0);
    // The drag itself is the existing one.
    h.pointermove({ clientX: 140, clientY: 100, buttons: 1 });
    h.pointerup({ clientX: 140 });
    assert.deepStrictEqual(
      h.apiCalls.filter((c) => c[0] === "dragLock").map((c) => c[1]),
      [true, false],
    );
    assert.strictEqual(h.apiCalls.filter((c) => c[0] === "dragEnd").length, 1);
    assert.deepStrictEqual(gestures(h), ["pet-start", "pet-end"]);
  });

  it("double and four click reactions unchanged with gestures enabled", () => {
    for (const harness of [createHarness, gestureHarness]) {
      const h = harness();
      vm.runInContext("Math.random = () => 0.9;", h.context); // skip annoyed → poke by first-click side
      h.pointerup({ clientX: 50 });
      h.pointerup({ clientX: 50 });
      h.fireTimer((t) => t.ms === 400);
      assert.deepStrictEqual(
        h.apiCalls.filter((c) => c[0] === "playClickReaction"),
        [["playClickReaction", "left.svg", 2500]],
      );

      const four = harness();
      vm.runInContext("Math.random = () => 0;", four.context);
      for (let i = 0; i < 4; i++) four.pointerup({ clientX: 150 });
      assert.deepStrictEqual(
        four.apiCalls.filter((c) => c[0] === "playClickReaction"),
        [["playClickReaction", "flail.svg", 3500]],
      );
      assert.deepStrictEqual(gestures(four), []);
    }
  });

  it("mac ctrl-click and dashboard modifier click unchanged", () => {
    for (const isMac of [true, false]) {
      const base = createHarness({ isMac });
      const live = gestureHarness({ isMac });
      for (const h of [base, live]) {
        h.pointerup({ ctrlKey: true });
        h.pointerup({ metaKey: true });
      }
      assert.deepStrictEqual(live.apiCalls, base.apiCalls, `isMac=${isMac}`);
    }
  });

  it("contextmenu, lostpointercapture and cancel-reaction end petting", () => {
    const enders = [
      ["contextmenu", (h) => h.context.document._dispatch("contextmenu", { preventDefault() {} })],
      ["lostpointercapture", (h) => h.area.listeners.get("lostpointercapture")()],
      ["cancel-reaction", (h) => h.apiHandlers.cancelReaction()],
      ["pointerleave", (h) => h.pointerleave()],
      ["blur", (h) => h.windowEvent("blur")],
    ];
    for (const [name, end] of enders) {
      const h = gestureHarness();
      startPetting(h);
      end(h);
      assert.deepStrictEqual(gestures(h), ["pet-start", "pet-end"], name);
      assert.strictEqual(liveTimers(h, 500).length, 0, `${name}: poll cleared`);
      assert.strictEqual(liveTimers(h, 1200).length, 0, `${name}: hover cleared`);
      // Ending twice never double-reports.
      end(h);
      assert.deepStrictEqual(gestures(h), ["pet-start", "pet-end"], `${name} twice`);
    }
    // The menu request still goes out, after the petting end.
    const m = gestureHarness();
    startPetting(m);
    m.context.document._dispatch("contextmenu", { preventDefault() {} });
    assert.deepStrictEqual(m.apiCalls.map((c) => c[0]).slice(-2), ["petGesture", "showContextMenu"]);
  });

  it("disabling mid-gesture ends petting", () => {
    const h = gestureHarness();
    startPetting(h);
    h.apiHandlers.stateSync({ petGesturesEnabled: false });
    assert.deepStrictEqual(gestures(h), ["pet-start", "pet-end"]);
    assert.strictEqual(liveTimers(h, 500).length, 0);
    stroke(h, [100, 120, 100, 120, 100]);
    h.pointerenter({ clientX: 100, clientY: 100 });
    assert.deepStrictEqual(gestures(h), ["pet-start", "pet-end"]);
    assert.strictEqual(liveTimers(h, 1200).length, 0);

    // A sync that omits the field leaves it alone.
    const keep = gestureHarness();
    keep.apiHandlers.stateSync({ currentState: "working" });
    startPetting(keep);
  });

  it("mini mode suppresses gestures", () => {
    const h = gestureHarness();
    startPetting(h);
    h.apiHandlers.stateSync({ miniMode: true });
    assert.deepStrictEqual(gestures(h), ["pet-start", "pet-end"]);
    h.pointerenter({ clientX: 100, clientY: 100 });
    stroke(h, [100, 120, 100, 120, 100, 120]);
    assert.deepStrictEqual(gestures(h), ["pet-start", "pet-end"]);
    assert.strictEqual(liveTimers(h, 1200).length, 0);
    assert.strictEqual(liveTimers(h, 500).length, 0);
    // The mini click still exits mini as before.
    h.pointerup({});
    assert.ok(h.apiCalls.some((c) => c[0] === "exitMiniMode"));
  });

  it("dnd suppresses petting strokes", () => {
    const h = gestureHarness({ sendState: { ...GESTURES_ON, dndEnabled: true } });
    h.pointerenter({ clientX: 100, clientY: 100 });
    stroke(h, [100, 120, 100, 120, 100, 120]);
    assert.ok(!gestures(h).includes("pet-start"));
  });

  it("the stranded-drag self-heal is untouched with gestures enabled", () => {
    const h = gestureHarness();
    h.pointerdown({});
    h.pointermove({ clientX: 120, clientY: 120, buttons: 1 });
    h.pointermove({ clientX: 140, clientY: 140, buttons: 0 });
    assert.deepStrictEqual(
      h.apiCalls.filter((c) => c[0] === "dragLock").map((c) => c[1]),
      [true, false],
    );
    assert.strictEqual(h.apiCalls.filter((c) => c[0] === "dragEnd").length, 1);
    assert.deepStrictEqual(gestures(h), []);
  });
});
