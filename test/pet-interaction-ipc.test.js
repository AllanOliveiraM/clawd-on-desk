"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  isTrustedMainFrameEvent,
  registerPetInteractionIpc,
} = require("../src/pet-interaction-ipc");

class FakeIpcMain {
  constructor() {
    this.listeners = new Map();
  }

  on(channel, listener) {
    this.listeners.set(channel, listener);
  }

  removeListener(channel, listener) {
    if (this.listeners.get(channel) === listener) this.listeners.delete(channel);
  }

  send(channel, ...args) {
    const listener = this.listeners.get(channel);
    assert.strictEqual(typeof listener, "function", `missing IPC listener ${channel}`);
    return listener({ sender: "sender-web-contents" }, ...args);
  }
}

function createHarness(overrides = {}) {
  const calls = [];
  const state = {
    miniMode: false,
    miniTransitioning: false,
    disableMiniMode: false,
    hasPetWindow: true,
    keepSizeAcrossDisplays: false,
    currentState: "idle",
    currentSvg: "idle.svg",
    petWindowBounds: { x: 10, y: 20, width: 120, height: 80 },
    currentPixelSize: { width: 90, height: 60 },
    effectivePixelSize: { width: 200, height: 200 },
    clampedBounds: { x: 12, y: 24, width: 90, height: 60 },
    focusableIds: [],
    statDirs: new Set(),
    statFiles: new Set(),
    openTerminalResult: { ok: true, terminal: "fake-term" },
    ...overrides.state,
  };
  const ipcMain = new FakeIpcMain();
  const runtime = registerPetInteractionIpc({
    ipcMain,
    showContextMenu: (event) => calls.push(["showContextMenu", event.sender]),
    moveWindowForDrag: () => calls.push(["moveWindowForDrag"]),
    setIdlePaused: (value) => calls.push(["setIdlePaused", value]),
    isMiniTransitioning: () => state.miniTransitioning,
    getCurrentState: () => state.currentState,
    getCurrentSvg: () => state.currentSvg,
    sendToRenderer: (...args) => calls.push(["sendToRenderer", ...args]),
    refreshIdleVisualAfterDrag: overrides.refreshIdleVisualAfterDrag,
    settleVisual: (event, payload) => calls.push(["settleVisual", event.sender, payload]),
    recoverVisiblePetAfterRendererLoad: (event) => calls.push(["recoverVisiblePetAfterRendererLoad", event.sender]),
    setDragLocked: (value) => calls.push(["setDragLocked", value]),
    setMouseOverPet: (value) => calls.push(["setMouseOverPet", value]),
    cancelRoam: Object.prototype.hasOwnProperty.call(overrides, "cancelRoam")
      ? overrides.cancelRoam
      : (() => calls.push(["cancelRoam"])),
    beginDragSnapshot: () => calls.push(["beginDragSnapshot"]),
    clearDragSnapshot: () => calls.push(["clearDragSnapshot"]),
    syncHitWin: () => calls.push(["syncHitWin"]),
    syncDisplayedVisualGeometry: () => calls.push(["syncDisplayedVisualGeometry"]),
    setAccessoryMirror: overrides.setAccessoryMirror
      || ((value) => calls.push(["setAccessoryMirror", value])),
    syncImeEditingPetDodge: () => calls.push(["syncImeEditingPetDodge"]),
    isMiniMode: () => state.miniMode,
    checkMiniModeSnap: overrides.checkMiniModeSnap
      ? () => overrides.checkMiniModeSnap({ calls, state })
      : (() => calls.push(["checkMiniModeSnap"])),
    hasPetWindow: () => state.hasPetWindow,
    getPetWindowBounds: () => state.petWindowBounds,
    getKeepSizeAcrossDisplays: () => state.keepSizeAcrossDisplays,
    getCurrentPixelSize: () => state.currentPixelSize,
    getEffectiveCurrentPixelSize: () =>
      state.keepSizeAcrossDisplays ? state.effectivePixelSize : state.currentPixelSize,
    computeDragEndBounds: (bounds, size) => {
      calls.push(["computeDragEndBounds", bounds, size]);
      return state.clampedBounds;
    },
    applyPetWindowBounds: (bounds) => calls.push(["applyPetWindowBounds", bounds]),
    flushRuntimeStateToPrefs: () => calls.push(["flushRuntimeStateToPrefs"]),
    reassertWinTopmost: () => calls.push(["reassertWinTopmost"]),
    scheduleHwndRecovery: () => calls.push(["scheduleHwndRecovery"]),
    repositionFloatingBubbles: () => calls.push(["repositionFloatingBubbles"]),
    exitMiniMode: () => calls.push(["exitMiniMode"]),
    getDisableMiniMode: () => state.disableMiniMode,
    getFocusableLocalHudSessionIds: () => state.focusableIds,
    focusLog: (message) => calls.push(["focusLog", message]),
    showDashboard: () => calls.push(["showDashboard"]),
    focusSession: (sessionId, options) => calls.push(["focusSession", sessionId, options]),
    setLowPowerIdlePaused: (value) => calls.push(["setLowPowerIdlePaused", value]),
    revealSessionHud: () => calls.push(["revealSessionHud"]),
    statPath: async (p) => {
      calls.push(["statPath", p]);
      if (state.statDirs.has(p)) return { isDirectory: () => true };
      if (state.statFiles.has(p)) return { isDirectory: () => false };
      throw new Error(`ENOENT: ${p}`);
    },
    openTerminalAt: async (dir) => {
      calls.push(["openTerminalAt", dir]);
      return state.openTerminalResult;
    },
    dropLog: (message) => calls.push(["dropLog", message]),
    // Default to the enabled platforms so the suite behaves the same on a
    // macOS dev machine; the macOS-disabled path has its own explicit test.
    isMacPlatform: overrides.isMacPlatform != null ? overrides.isMacPlatform : false,
    ...(overrides.extra || {}),
  });
  return { ipcMain, runtime, calls, state };
}

function makeDropSender() {
  return { sent: [], send(channel) { this.sent.push(channel); } };
}

function sendDrop(ipcMain, paths, sender) {
  const listener = ipcMain.listeners.get("pet-drop-paths");
  assert.strictEqual(typeof listener, "function", "missing IPC listener pet-drop-paths");
  return listener({ sender }, paths);
}

test("accessory-mirror hands main the facing the renderer reported", () => {
  const seen = [];
  const { ipcMain } = createHarness({ setAccessoryMirror: (value) => seen.push(value) });
  const listener = ipcMain.listeners.get("accessory-mirror");
  assert.strictEqual(typeof listener, "function", "missing IPC listener accessory-mirror");

  // Registering the channel is not the contract — forwarding the payload is.
  listener({}, true);
  listener({}, false);
  listener({}, 1);
  assert.deepStrictEqual(seen, [true, false, true]);
});

test("pet interaction IPC registers owned channels and disposes them", () => {
  const { ipcMain, runtime } = createHarness();

  assert.deepStrictEqual([...ipcMain.listeners.keys()].sort(), [
    "accessory-mirror",
    "drag-end",
    "drag-lock",
    "drag-move",
    "end-drag-reaction",
    "exit-mini-mode",
    "focus-terminal",
    "low-power-idle-paused",
    "pause-cursor-polling",
    "pet-drop-paths",
    "pet-interaction:reveal-session-hud",
    "pet-visual-ready",
    "pet-visual-settled",
    "play-click-reaction",
    "resume-from-reaction",
    "show-context-menu",
    "start-drag-reaction",
  ]);

  runtime.dispose();

  assert.strictEqual(ipcMain.listeners.size, 0);
});

test("pet interaction IPC delegates the first rendered visual recovery signal", () => {
  const { ipcMain, calls } = createHarness();

  ipcMain.send("pet-visual-ready");

  assert.deepStrictEqual(calls.filter((c) => c[0] === "recoverVisiblePetAfterRendererLoad"), [
    ["recoverVisiblePetAfterRendererLoad", "sender-web-contents"],
  ]);
});

test("pet interaction IPC delegates renderer settlement with the sender intact", () => {
  const { ipcMain, calls } = createHarness();
  const payload = { visualGeneration: 7, outcome: "swapped" };

  ipcMain.send("pet-visual-settled", payload);

  assert.deepStrictEqual(calls.filter((c) => c[0] === "settleVisual"), [
    ["settleVisual", "sender-web-contents", payload],
  ]);
});

test("visual settlements trust only the render webContents main frame", () => {
  const mainFrame = { url: "file:///index.html" };
  const webContents = { mainFrame };
  assert.strictEqual(
    isTrustedMainFrameEvent({ sender: webContents, senderFrame: mainFrame }, webContents),
    true
  );
  assert.strictEqual(
    isTrustedMainFrameEvent({ sender: webContents, senderFrame: { ...mainFrame } }, webContents),
    false
  );
  assert.strictEqual(
    isTrustedMainFrameEvent({ sender: {}, senderFrame: mainFrame }, webContents),
    false
  );
  assert.strictEqual(isTrustedMainFrameEvent({ sender: webContents }, webContents), false);
  const destroyedFrameEvent = { sender: webContents };
  Object.defineProperty(destroyedFrameEvent, "senderFrame", {
    get() { throw new Error("frame destroyed"); },
  });
  assert.strictEqual(isTrustedMainFrameEvent(destroyedFrameEvent, webContents), false);
});

test("pet interaction IPC delegates pet-interaction:reveal-session-hud to revealSessionHud", () => {
  const { ipcMain, calls } = createHarness();
  ipcMain.send("pet-interaction:reveal-session-hud");
  assert.deepStrictEqual(calls.filter((c) => c[0] === "revealSessionHud"), [
    ["revealSessionHud"],
  ]);
});

test("pet interaction IPC delegates menu, drag move, reaction pause, and renderer relays", () => {
  const { ipcMain, calls, state } = createHarness();

  ipcMain.send("show-context-menu");
  ipcMain.send("drag-move");
  ipcMain.send("pause-cursor-polling");
  ipcMain.send("resume-from-reaction");
  ipcMain.send("low-power-idle-paused", true);
  ipcMain.send("low-power-idle-paused", false);
  state.miniTransitioning = true;
  ipcMain.send("resume-from-reaction");
  ipcMain.send("start-drag-reaction");
  ipcMain.send("end-drag-reaction");
  ipcMain.send("play-click-reaction", "click.svg", 900);

  assert.deepStrictEqual(calls, [
    ["showContextMenu", "sender-web-contents"],
    ["moveWindowForDrag"],
    ["setIdlePaused", true],
    ["setIdlePaused", false],
    ["sendToRenderer", "state-change", "idle", "idle.svg"],
    ["setLowPowerIdlePaused", true],
    ["setLowPowerIdlePaused", false],
    ["setIdlePaused", false],
    ["sendToRenderer", "start-drag-reaction", null],
    ["sendToRenderer", "end-drag-reaction"],
    ["sendToRenderer", "play-click-reaction", "click.svg", 900],
  ]);
});

test("pet interaction IPC relays only supported drag directions", () => {
  const { ipcMain, calls } = createHarness();

  ipcMain.send("start-drag-reaction", "left");
  ipcMain.send("start-drag-reaction", "right");
  ipcMain.send("start-drag-reaction", "up");

  assert.deepStrictEqual(calls, [
    ["sendToRenderer", "start-drag-reaction", "left"],
    ["sendToRenderer", "start-drag-reaction", "right"],
    ["sendToRenderer", "start-drag-reaction", null],
  ]);
});

test("pet interaction IPC preserves drag lock lifecycle", () => {
  const { ipcMain, calls } = createHarness();

  ipcMain.send("drag-lock", true);
  ipcMain.send("drag-lock", false);

  assert.deepStrictEqual(calls, [
    ["setDragLocked", true],
    ["setMouseOverPet", true],
    ["cancelRoam"],
    ["beginDragSnapshot"],
    ["setDragLocked", false],
    ["clearDragSnapshot"],
    ["syncHitWin"],
    ["syncDisplayedVisualGeometry"],
    // #640: the dodge defers its hit-window click-through write while a drag
    // is in flight — releasing the lock must re-run the sync.
    ["syncImeEditingPetDodge"],
  ]);
});

test("pet interaction IPC requires the roam cancel dependency", () => {
  assert.throws(
    () => createHarness({ cancelRoam: null }),
    /registerPetInteractionIpc requires cancelRoam/,
  );
});

test("pet interaction IPC finalizes drag end and always clears drag state", () => {
  const { ipcMain, calls, state } = createHarness();

  ipcMain.send("drag-end");
  state.keepSizeAcrossDisplays = true;
  ipcMain.send("drag-end");

  assert.deepStrictEqual(calls, [
    ["checkMiniModeSnap"],
    ["computeDragEndBounds", state.petWindowBounds, state.currentPixelSize],
    ["applyPetWindowBounds", state.clampedBounds],
    ["flushRuntimeStateToPrefs"],
    ["reassertWinTopmost"],
    ["scheduleHwndRecovery"],
    ["syncHitWin"],
    ["syncDisplayedVisualGeometry"],
    ["repositionFloatingBubbles"],
    ["setDragLocked", false],
    ["clearDragSnapshot"],
    ["syncImeEditingPetDodge"],
    ["checkMiniModeSnap"],
    ["computeDragEndBounds", state.petWindowBounds, state.effectivePixelSize],
    ["applyPetWindowBounds", state.clampedBounds],
    ["flushRuntimeStateToPrefs"],
    ["reassertWinTopmost"],
    ["scheduleHwndRecovery"],
    ["syncHitWin"],
    ["syncDisplayedVisualGeometry"],
    ["repositionFloatingBubbles"],
    ["setDragLocked", false],
    ["clearDragSnapshot"],
    ["syncImeEditingPetDodge"],
  ]);
});

test("pet interaction IPC skips drag-end clamp when mini snap starts", () => {
  const { ipcMain, calls } = createHarness({
    checkMiniModeSnap: ({ calls, state }) => {
      calls.push(["checkMiniModeSnap"]);
      state.miniMode = true;
    },
  });

  ipcMain.send("drag-end");

  assert.deepStrictEqual(calls, [
    ["checkMiniModeSnap"],
    ["setDragLocked", false],
    ["clearDragSnapshot"],
    ["syncImeEditingPetDodge"],
  ]);
});

test("drag end refreshes the idle visual only after the final bounds are applied", () => {
  let calls;
  const harness = createHarness({
    refreshIdleVisualAfterDrag: () => calls.push(["refreshIdleVisualAfterDrag"]),
  });
  calls = harness.calls;
  harness.ipcMain.send("drag-lock", false);
  assert.ok(!calls.some(([name]) => name === "refreshIdleVisualAfterDrag"));
  harness.ipcMain.send("drag-end");
  const refreshIndex = calls.findIndex(([name]) => name === "refreshIdleVisualAfterDrag");
  assert.ok(refreshIndex > calls.findIndex(([name]) => name === "applyPetWindowBounds"));
  assert.strictEqual(calls.filter(([name]) => name === "refreshIdleVisualAfterDrag").length, 1);
});

test("drag end does not refresh an idle visual during mini entry or without a window", () => {
  for (const state of [{ miniMode: true }, { miniTransitioning: true }, { hasPetWindow: false }]) {
    let refreshed = false;
    const harness = createHarness({ state, refreshIdleVisualAfterDrag: () => { refreshed = true; } });
    harness.ipcMain.send("drag-end");
    assert.strictEqual(refreshed, false);
  }
  let refreshed = false;
  const harness = createHarness({
    checkMiniModeSnap: ({ state }) => { state.miniMode = true; },
    refreshIdleVisualAfterDrag: () => { refreshed = true; },
  });
  harness.ipcMain.send("drag-end");
  assert.strictEqual(refreshed, false);
});

test("pet interaction IPC does not persist when drag-end has no clamped bounds", () => {
  const { ipcMain, calls } = createHarness({
    state: { clampedBounds: null },
  });

  ipcMain.send("drag-end");

  assert.deepStrictEqual(calls, [
    ["checkMiniModeSnap"],
    ["computeDragEndBounds", { x: 10, y: 20, width: 120, height: 80 }, { width: 90, height: 60 }],
    ["reassertWinTopmost"],
    ["scheduleHwndRecovery"],
    ["syncHitWin"],
    ["syncDisplayedVisualGeometry"],
    ["repositionFloatingBubbles"],
    ["setDragLocked", false],
    ["clearDragSnapshot"],
    ["syncImeEditingPetDodge"],
  ]);
});

test("pet interaction IPC disables mini snap without skipping drag-end cleanup", () => {
  const { ipcMain, calls, state } = createHarness({
    state: { disableMiniMode: true },
  });

  ipcMain.send("drag-end");

  assert.deepStrictEqual(calls, [
    ["computeDragEndBounds", state.petWindowBounds, state.currentPixelSize],
    ["applyPetWindowBounds", state.clampedBounds],
    ["flushRuntimeStateToPrefs"],
    ["reassertWinTopmost"],
    ["scheduleHwndRecovery"],
    ["syncHitWin"],
    ["syncDisplayedVisualGeometry"],
    ["repositionFloatingBubbles"],
    ["setDragLocked", false],
    ["clearDragSnapshot"],
    ["syncImeEditingPetDodge"],
  ]);
});

test("pet interaction IPC still clears drag state when drag end has no live pet window", () => {
  const { ipcMain, calls } = createHarness({
    state: { hasPetWindow: false },
  });

  ipcMain.send("drag-end");

  assert.deepStrictEqual(calls, [
    ["checkMiniModeSnap"],
    ["setDragLocked", false],
    ["clearDragSnapshot"],
    ["syncImeEditingPetDodge"],
  ]);
});

test("pet interaction IPC gates exit-mini-mode on current mini state", () => {
  const { ipcMain, calls, state } = createHarness();

  ipcMain.send("exit-mini-mode");
  state.miniMode = true;
  ipcMain.send("exit-mini-mode");

  assert.deepStrictEqual(calls, [
    ["exitMiniMode"],
  ]);
});

test("pet interaction IPC preserves pet-body focus behavior", () => {
  const { ipcMain, calls, state } = createHarness();

  ipcMain.send("focus-terminal");
  state.focusableIds = ["single"];
  ipcMain.send("focus-terminal");
  state.focusableIds = ["one", "two"];
  ipcMain.send("focus-terminal");

  assert.deepStrictEqual(calls, [
    ["focusLog", "focus request source=pet-body sid=- focusableCount=0"],
    ["focusLog", "focus result branch=none reason=no-focusable-session source=pet-body"],
    ["focusLog", "focus request source=pet-body sid=- focusableCount=1"],
    ["focusSession", "single", { requestSource: "pet-body" }],
    ["focusLog", "focus request source=pet-body sid=- focusableCount=2"],
    ["focusLog", "focus result branch=none reason=multi-session-open-dashboard count=2"],
    ["showDashboard"],
  ]);
});

test("pet drop opens a terminal at a dropped directory and pings the hit window (#459)", async () => {
  const { ipcMain, calls, state } = createHarness();
  state.statDirs.add("/proj/dir");
  const sender = makeDropSender();

  await sendDrop(ipcMain, ["/proj/dir"], sender);

  assert.deepStrictEqual(
    calls.filter((c) => c[0] === "openTerminalAt"),
    [["openTerminalAt", "/proj/dir"]],
  );
  assert.deepStrictEqual(sender.sent, ["pet-drop-accepted"]);
});

test("pet drop resolves a dropped file to its parent directory", async () => {
  const { ipcMain, calls, state } = createHarness();
  state.statFiles.add("/proj/dir/file.txt");
  const sender = makeDropSender();

  await sendDrop(ipcMain, ["/proj/dir/file.txt"], sender);

  assert.deepStrictEqual(
    calls.filter((c) => c[0] === "openTerminalAt"),
    [["openTerminalAt", "/proj/dir"]],
  );
  assert.deepStrictEqual(sender.sent, ["pet-drop-accepted"]);
});

test("pet drop takes the first usable path only", async () => {
  const { ipcMain, calls, state } = createHarness();
  state.statDirs.add("/first");
  state.statDirs.add("/second");
  const sender = makeDropSender();

  await sendDrop(ipcMain, [null, "", "/first", "/second"], sender);

  assert.deepStrictEqual(
    calls.filter((c) => c[0] === "openTerminalAt"),
    [["openTerminalAt", "/first"]],
  );
});

test("pet drop is disabled on macOS: no stat, no terminal, no accept ping", async () => {
  const { ipcMain, calls, state } = createHarness({ isMacPlatform: true });
  state.statDirs.add("/proj/dir");
  const sender = makeDropSender();

  await sendDrop(ipcMain, ["/proj/dir"], sender);

  assert.deepStrictEqual(calls.filter((c) => c[0] === "statPath"), []);
  assert.deepStrictEqual(calls.filter((c) => c[0] === "openTerminalAt"), []);
  assert.deepStrictEqual(sender.sent, []);
  const logs = calls.filter((c) => c[0] === "dropLog").map((c) => c[1]);
  assert.ok(logs.some((m) => m.includes("disabled on macOS")), logs.join("; "));
});

test("pet drop is ignored in mini mode and during mini transitions", async () => {
  for (const stateOverride of [{ miniMode: true }, { miniTransitioning: true }]) {
    const { ipcMain, calls, state } = createHarness({ state: stateOverride });
    state.statDirs.add("/proj");
    const sender = makeDropSender();

    await sendDrop(ipcMain, ["/proj"], sender);

    assert.deepStrictEqual(calls.filter((c) => c[0] === "statPath"), []);
    assert.deepStrictEqual(calls.filter((c) => c[0] === "openTerminalAt"), []);
    assert.deepStrictEqual(sender.sent, []);
  }
});

test("pet drop ignores invalid payloads and failed stats without launching", async () => {
  const { ipcMain, calls } = createHarness();
  const sender = makeDropSender();

  await sendDrop(ipcMain, "not-an-array", sender);
  await sendDrop(ipcMain, [], sender);
  await sendDrop(ipcMain, [123, "", null], sender);
  await sendDrop(ipcMain, ["/missing"], sender);

  assert.deepStrictEqual(calls.filter((c) => c[0] === "openTerminalAt"), []);
  assert.deepStrictEqual(sender.sent, []);
  const logs = calls.filter((c) => c[0] === "dropLog").map((c) => c[1]);
  assert.ok(logs.some((m) => m.includes("stat failed") && m.includes("/missing")), logs.join("; "));
});

test("pet drop does not ping the hit window when the terminal launch fails", async () => {
  const { ipcMain, calls, state } = createHarness({
    state: { openTerminalResult: { ok: false, message: "no terminal" } },
  });
  state.statDirs.add("/proj");
  const sender = makeDropSender();

  await sendDrop(ipcMain, ["/proj"], sender);

  assert.deepStrictEqual(
    calls.filter((c) => c[0] === "openTerminalAt"),
    [["openTerminalAt", "/proj"]],
  );
  assert.deepStrictEqual(sender.sent, []);
  const logs = calls.filter((c) => c[0] === "dropLog").map((c) => c[1]);
  assert.ok(logs.some((m) => m.includes("launch failed") && m.includes("no terminal")), logs.join("; "));
});

// ── Clawd Alive: gestures and companion observations (Task 9) ──

function companionHarness({ extra = {}, state = {}, checkMiniModeSnap } = {}) {
  const companion = [];
  const clock = { now: 10_000 };
  const flags = { dragLocked: false };
  const harness = createHarness({
    state,
    checkMiniModeSnap,
    extra: {
      handlePetGesture: (kind) => companion.push(["gesture", kind]),
      noteCompanionEvent: (kind) => companion.push(["event", kind]),
      noteCompanionDragEnd: (spot) => companion.push(["dragEnd", spot]),
      isDragLocked: () => flags.dragLocked,
      getThemeReactions: () => ({
        double: { files: ["flail-a.svg", "flail-b.svg"], duration: 3500 },
        annoyed: { file: "annoyed.svg", duration: 3500 },
        clickLeft: { file: "left.svg" },
        clickRight: { file: "right.svg" },
      }),
      getDisplayNearestPoint: (point) => {
        companion.push(["displayFor", point]);
        return { id: 7, workArea: { x: 0, y: 0, width: 1000, height: 500 } };
      },
      now: () => clock.now,
      ...extra,
    },
  });
  return { ...harness, companion, clock, flags };
}

test("gesture rejects unknown kinds", () => {
  const h = companionHarness();
  for (const kind of ["pet-start", "pet-continue", "pet-end", "hover-dwell"]) {
    h.ipcMain.send("pet-interaction:gesture", kind);
  }
  for (const kind of ["pet", "click", "", null, undefined, 1, { kind: "pet-start" }, "PET-START", "toString"]) {
    h.ipcMain.send("pet-interaction:gesture", kind);
  }
  assert.deepStrictEqual(h.companion, [
    ["gesture", "pet-start"],
    ["gesture", "pet-continue"],
    ["gesture", "pet-end"],
    ["gesture", "hover-dwell"],
  ]);
});

test("gesture ignored in mini, transition and drag lock", () => {
  const h = companionHarness();
  h.state.miniMode = true;
  h.ipcMain.send("pet-interaction:gesture", "pet-start");
  h.state.miniMode = false;
  h.state.miniTransitioning = true;
  h.ipcMain.send("pet-interaction:gesture", "pet-start");
  h.state.miniTransitioning = false;
  h.flags.dragLocked = true;
  h.ipcMain.send("pet-interaction:gesture", "pet-start");
  h.flags.dragLocked = false;
  assert.deepStrictEqual(h.companion, []);
  h.ipcMain.send("pet-interaction:gesture", "pet-start");
  assert.deepStrictEqual(h.companion, [["gesture", "pet-start"]]);

  // Without an isDragLocked getter the module falls back to its own view of
  // the drag-lock IPC it already handles.
  const local = companionHarness({ extra: { isDragLocked: undefined } });
  local.ipcMain.send("drag-lock", true);
  local.ipcMain.send("pet-interaction:gesture", "hover-dwell");
  local.ipcMain.send("drag-lock", false);
  local.ipcMain.send("pet-interaction:gesture", "hover-dwell");
  assert.deepStrictEqual(local.companion.filter((c) => c[0] === "gesture"), [["gesture", "hover-dwell"]]);
});

test("gesture ignored from untrusted sender", () => {
  const mainFrame = { name: "hit-main-frame" };
  const hitWc = { mainFrame };
  for (const option of [hitWc, () => hitWc]) {
    const h = companionHarness({ extra: { hitWebContents: option } });
    const listener = h.ipcMain.listeners.get("pet-interaction:gesture");
    listener({ sender: { mainFrame } , senderFrame: mainFrame }, "pet-start");
    listener({ sender: hitWc, senderFrame: { name: "iframe" } }, "pet-start");
    listener({ sender: "sender-web-contents" }, "pet-start");
    listener({ sender: hitWc, senderFrame: mainFrame }, "pet-end");
    assert.deepStrictEqual(h.companion, [["gesture", "pet-end"]]);
  }
  // A getter that has no live hit window rejects everything.
  const gone = companionHarness({ extra: { hitWebContents: () => null } });
  gone.ipcMain.listeners.get("pet-interaction:gesture")({ sender: hitWc, senderFrame: mainFrame }, "pet-start");
  assert.deepStrictEqual(gone.companion, []);
});

test("click reaction notes click vs clickBurst", () => {
  const h = companionHarness();
  h.ipcMain.send("play-click-reaction", "left.svg", 2500);
  h.ipcMain.send("play-click-reaction", "annoyed.svg", 3500);
  h.ipcMain.send("play-click-reaction", "flail-b.svg", 3500);
  h.ipcMain.send("play-click-reaction", "right.svg", 2500);
  assert.deepStrictEqual(h.companion, [
    ["event", "click"],
    ["event", "clickBurst"],
    ["event", "clickBurst"],
    ["event", "click"],
  ]);
  // What plays is untouched.
  assert.deepStrictEqual(h.calls.filter((c) => c[0] === "sendToRenderer"), [
    ["sendToRenderer", "play-click-reaction", "left.svg", 2500],
    ["sendToRenderer", "play-click-reaction", "annoyed.svg", 3500],
    ["sendToRenderer", "play-click-reaction", "flail-b.svg", 3500],
    ["sendToRenderer", "play-click-reaction", "right.svg", 2500],
  ]);

  // A theme with the single-file double form.
  const single = companionHarness({ extra: { getThemeReactions: () => ({ double: { file: "flail.svg" } }) } });
  single.ipcMain.send("play-click-reaction", "flail.svg", 3500);
  assert.deepStrictEqual(single.companion, [["event", "clickBurst"]]);
  // A throwing observer never blocks the reaction.
  const boom = companionHarness({ extra: { noteCompanionEvent: () => { throw new Error("boom"); } } });
  boom.ipcMain.send("play-click-reaction", "left.svg", 2500);
  assert.deepStrictEqual(boom.calls.filter((c) => c[0] === "sendToRenderer").length, 1);
});

test("long drag notes dragLong and reports relative drop", () => {
  const h = companionHarness({ state: { clampedBounds: { x: 200, y: 100, width: 100, height: 100 } } });
  h.ipcMain.send("drag-lock", true);
  h.clock.now += 1500;
  h.ipcMain.send("drag-lock", false);
  h.ipcMain.send("drag-end");
  // Exactly 1500 ms is not long.
  assert.deepStrictEqual(h.companion.filter((c) => c[0] === "event"), [["event", "drag"]]);

  h.ipcMain.send("drag-lock", true);
  h.clock.now += 1501;
  h.ipcMain.send("drag-lock", false);
  h.ipcMain.send("drag-end");
  assert.deepStrictEqual(h.companion.filter((c) => c[0] === "event"), [["event", "drag"], ["event", "dragLong"]]);

  // drag-end without the paired drag-lock(false) still measures from the lock.
  h.ipcMain.send("drag-lock", true);
  h.clock.now += 2000;
  h.ipcMain.send("drag-end");
  assert.deepStrictEqual(h.companion.filter((c) => c[0] === "event").length, 3);
  assert.deepStrictEqual(h.companion.filter((c) => c[0] === "event")[2], ["event", "dragLong"]);

  // Final pet center (250,150) on the 1000x500 work area of display 7.
  const ends = h.companion.filter((c) => c[0] === "dragEnd");
  assert.strictEqual(ends.length, 3);
  assert.deepStrictEqual(ends[0], ["dragEnd", { displayId: 7, x: 0.25, y: 0.3 }]);
  assert.deepStrictEqual(h.companion.find((c) => c[0] === "displayFor"), ["displayFor", { x: 250, y: 150 }]);

  // A plain lock/unlock without drag-end (a click) notes nothing.
  const click = companionHarness();
  click.ipcMain.send("drag-lock", true);
  click.ipcMain.send("drag-lock", false);
  assert.deepStrictEqual(click.companion, []);
});

test("rest spot is clamped to the work area and skipped without a display", () => {
  const h = companionHarness({ state: { clampedBounds: { x: 950, y: -80, width: 100, height: 100 } } });
  h.ipcMain.send("drag-end");
  assert.deepStrictEqual(h.companion.find((c) => c[0] === "dragEnd"), ["dragEnd", { displayId: 7, x: 1, y: 0 }]);

  // No clamped bounds: the live bounds are used.
  const live = companionHarness({ state: { clampedBounds: null, petWindowBounds: { x: 0, y: 0, width: 100, height: 50 } } });
  live.ipcMain.send("drag-end");
  assert.deepStrictEqual(live.companion.find((c) => c[0] === "dragEnd"), ["dragEnd", { displayId: 7, x: 0.05, y: 0.05 }]);

  const none = companionHarness({ extra: { getDisplayNearestPoint: () => null } });
  none.ipcMain.send("drag-end");
  assert.deepStrictEqual(none.companion, [["event", "drag"]]);
  const zero = companionHarness({ extra: { getDisplayNearestPoint: () => ({ id: 1, workArea: { x: 0, y: 0, width: 0, height: 0 } }) } });
  zero.ipcMain.send("drag-end");
  assert.deepStrictEqual(zero.companion, [["event", "drag"]]);
  const boom = companionHarness({ extra: { noteCompanionDragEnd: () => { throw new Error("boom"); } } });
  boom.ipcMain.send("drag-end");
  assert.ok(boom.calls.some((c) => c[0] === "repositionFloatingBubbles"));
  assert.ok(boom.calls.some((c) => c[0] === "setDragLocked" && c[1] === false));
});

test("drop in mini mode records no rest spot", () => {
  // Already in mini.
  const mini = companionHarness({ state: { miniMode: true } });
  mini.ipcMain.send("drag-end");
  assert.deepStrictEqual(mini.companion.filter((c) => c[0] === "dragEnd"), []);

  // The drop snapped into mini.
  const snap = companionHarness({ checkMiniModeSnap: ({ state }) => { state.miniTransitioning = true; } });
  snap.ipcMain.send("drag-end");
  assert.deepStrictEqual(snap.companion, [["event", "drag"]]);
  assert.ok(!snap.calls.some((c) => c[0] === "applyPetWindowBounds"));
});

test("missing companion options keep existing behavior", () => {
  const plain = createHarness();
  const withCompanion = companionHarness();
  // No gesture channel without a handler.
  assert.strictEqual(plain.ipcMain.listeners.has("pet-interaction:gesture"), false);
  assert.strictEqual(withCompanion.ipcMain.listeners.has("pet-interaction:gesture"), true);
  for (const h of [plain, withCompanion]) {
    h.ipcMain.send("drag-lock", true);
    h.ipcMain.send("drag-lock", false);
    h.ipcMain.send("drag-end");
    h.ipcMain.send("play-click-reaction", "annoyed.svg", 3500);
  }
  // The existing side effects are byte-identical with or without the companion.
  assert.deepStrictEqual(withCompanion.calls, plain.calls);
  assert.strictEqual(plain.calls.length > 0, true);

  withCompanion.runtime.dispose();
  assert.strictEqual(withCompanion.ipcMain.listeners.size, 0);
});
