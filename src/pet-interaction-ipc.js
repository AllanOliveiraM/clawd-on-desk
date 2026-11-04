"use strict";

const path = require("path");

function requiredDependency(value, name) {
  if (!value) throw new Error(`registerPetInteractionIpc requires ${name}`);
  return value;
}

function isTrustedMainFrameEvent(event, webContents) {
  if (!event || !webContents || event.sender !== webContents) return false;
  try {
    return !!event.senderFrame && event.senderFrame === webContents.mainFrame;
  } catch {
    return false;
  }
}

// Clawd Alive gesture kinds the hit renderer may report.
const PET_GESTURE_KINDS = new Set(["pet-start", "pet-continue", "pet-end", "hover-dwell", "hover-move"]);
// A drag whose lock lasted longer than this counts as "dragLong" for the mood.
const DRAG_LONG_MS = 1500;

function clamp01(value) {
  return value < 0 ? 0 : (value > 1 ? 1 : value);
}

function reactionFiles(reaction) {
  if (!reaction || typeof reaction !== "object") return [];
  if (Array.isArray(reaction.files)) return reaction.files;
  return reaction.file ? [reaction.file] : [];
}

function registerPetInteractionIpc(options = {}) {
  const ipcMain = requiredDependency(options.ipcMain, "ipcMain");
  const showContextMenu = requiredDependency(options.showContextMenu, "showContextMenu");
  const moveWindowForDrag = requiredDependency(options.moveWindowForDrag, "moveWindowForDrag");
  const setIdlePaused = requiredDependency(options.setIdlePaused, "setIdlePaused");
  const isMiniTransitioning = requiredDependency(options.isMiniTransitioning, "isMiniTransitioning");
  const getCurrentState = requiredDependency(options.getCurrentState, "getCurrentState");
  const getCurrentSvg = requiredDependency(options.getCurrentSvg, "getCurrentSvg");
  const sendToRenderer = requiredDependency(options.sendToRenderer, "sendToRenderer");
  const requestDragReaction = options.requestDragReaction || null;
  const requestClickReaction = options.requestClickReaction || null;
  const refreshIdleVisualAfterDrag = options.refreshIdleVisualAfterDrag || (() => {});
  const recoverVisiblePetAfterRendererLoad = requiredDependency(
    options.recoverVisiblePetAfterRendererLoad,
    "recoverVisiblePetAfterRendererLoad"
  );
  const setDragLocked = requiredDependency(options.setDragLocked, "setDragLocked");
  const setMouseOverPet = requiredDependency(options.setMouseOverPet, "setMouseOverPet");
  const cancelRoam = requiredDependency(options.cancelRoam, "cancelRoam");
  const beginDragSnapshot = requiredDependency(options.beginDragSnapshot, "beginDragSnapshot");
  const clearDragSnapshot = requiredDependency(options.clearDragSnapshot, "clearDragSnapshot");
  const syncHitWin = requiredDependency(options.syncHitWin, "syncHitWin");
  const isMiniMode = requiredDependency(options.isMiniMode, "isMiniMode");
  const checkMiniModeSnap = requiredDependency(options.checkMiniModeSnap, "checkMiniModeSnap");
  const hasPetWindow = requiredDependency(options.hasPetWindow, "hasPetWindow");
  const getPetWindowBounds = requiredDependency(options.getPetWindowBounds, "getPetWindowBounds");
  const getCurrentPixelSize = requiredDependency(options.getCurrentPixelSize, "getCurrentPixelSize");
  // #408: prefer the effective (frozen, when keepSizeAcrossDisplays) size over
  // re-reading live bounds; falls back to proportional when not provided.
  const getEffectiveCurrentPixelSize = options.getEffectiveCurrentPixelSize || getCurrentPixelSize;
  const computeDragEndBounds = requiredDependency(options.computeDragEndBounds, "computeDragEndBounds");
  const applyPetWindowBounds = requiredDependency(options.applyPetWindowBounds, "applyPetWindowBounds");
  const flushRuntimeStateToPrefs = requiredDependency(
    options.flushRuntimeStateToPrefs,
    "flushRuntimeStateToPrefs"
  );
  const reassertWinTopmost = requiredDependency(options.reassertWinTopmost, "reassertWinTopmost");
  const scheduleHwndRecovery = requiredDependency(options.scheduleHwndRecovery, "scheduleHwndRecovery");
  const repositionFloatingBubbles = requiredDependency(
    options.repositionFloatingBubbles,
    "repositionFloatingBubbles"
  );
  const exitMiniMode = requiredDependency(options.exitMiniMode, "exitMiniMode");
  const getDisableMiniMode = options.getDisableMiniMode || (() => false);
  const getFocusableLocalHudSessionIds = requiredDependency(
    options.getFocusableLocalHudSessionIds,
    "getFocusableLocalHudSessionIds"
  );
  const focusLog = requiredDependency(options.focusLog, "focusLog");
  const showDashboard = requiredDependency(options.showDashboard, "showDashboard");
  const focusSession = requiredDependency(options.focusSession, "focusSession");
  const revealSessionHud = requiredDependency(options.revealSessionHud, "revealSessionHud");
  const setLowPowerIdlePaused = requiredDependency(
    options.setLowPowerIdlePaused,
    "setLowPowerIdlePaused"
  );
  const setAccessoryMirror = options.setAccessoryMirror || (() => {});
  const settleVisual = options.settleVisual || (() => false);
  const syncDisplayedVisualGeometry = options.syncDisplayedVisualGeometry || (() => {});
  // #640: the editing-overlap dodge defers its hit-window click-through write
  // while a drag is in flight; drag-lock release must re-run the sync so the
  // state the drag ended in (overlapping or not) gets applied.
  const syncImeEditingPetDodge = options.syncImeEditingPetDodge || (() => {});
  const statPath = requiredDependency(options.statPath, "statPath");
  const openTerminalAt = requiredDependency(options.openTerminalAt, "openTerminalAt");
  const dropLog = options.dropLog || (() => {});
  const isMacPlatform = options.isMacPlatform != null
    ? !!options.isMacPlatform
    : process.platform === "darwin";
  // Clawd Alive companion (all optional; absent = exactly the old behavior).
  // handlePetGesture: receives validated petting / hover gestures; without it
  //   the gesture channel is not registered at all.
  // hitWebContents: the hit window's webContents, or a getter for it. When
  //   supplied, gestures from any other sender / sub-frame are dropped; when
  //   omitted every sender is accepted (tests and back-compat).
  // noteCompanionEvent: observes "click" / "clickBurst" / "drag" / "dragLong"
  //   without changing what the existing handlers do.
  // noteCompanionDragEnd({displayId, x, y}): the pet's final center as a
  //   fraction of its display's work area, needs getDisplayNearestPoint.
  // isCompanionEnabled(): when supplied and not true, the click / drag
  //   observers skip all work (no theme lookup, no display query).
  const handlePetGesture = typeof options.handlePetGesture === "function" ? options.handlePetGesture : null;
  const noteCompanionEvent = typeof options.noteCompanionEvent === "function" ? options.noteCompanionEvent : null;
  const noteCompanionDragEnd = typeof options.noteCompanionDragEnd === "function"
    ? options.noteCompanionDragEnd
    : null;
  const hitWebContents = options.hitWebContents || null;
  const isDragLockedOption = typeof options.isDragLocked === "function" ? options.isDragLocked : null;
  const getThemeReactions = typeof options.getThemeReactions === "function" ? options.getThemeReactions : null;
  const getDisplayNearestPoint = typeof options.getDisplayNearestPoint === "function"
    ? options.getDisplayNearestPoint
    : null;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const companionLog = options.companionLog || (() => {});
  const isCompanionEnabledOption = typeof options.isCompanionEnabled === "function"
    ? options.isCompanionEnabled
    : null;
  const disposers = [];
  // Local view of the drag lock this module handles; only used for the
  // duration measurement and as the gesture gate when main gives no getter.
  let localDragLocked = false;
  let dragLockedAt = null;
  let lastDragLockMs = null;

  function on(channel, listener) {
    ipcMain.on(channel, listener);
    disposers.push(() => ipcMain.removeListener(channel, listener));
  }

  // Clawd Alive test mode: the hit window forwards Shift; only a strict
  // boolean survives, so a malformed payload is a plain right-click.
  on("show-context-menu", (event, payload) => showContextMenu(event, {
    shiftKey: !!payload && typeof payload === "object" && payload.shiftKey === true,
  }));
  on("drag-move", () => moveWindowForDrag());
  on("pet-visual-ready", (event) => recoverVisiblePetAfterRendererLoad(event));
  on("pet-visual-settled", (event, payload) => settleVisual(event, payload));

  on("pause-cursor-polling", () => {
    setIdlePaused(true);
  });
  on("resume-from-reaction", () => {
    setIdlePaused(false);
    if (isMiniTransitioning()) return;
    sendToRenderer("state-change", getCurrentState(), getCurrentSvg());
  });
  on("low-power-idle-paused", (_event, paused) => {
    setLowPowerIdlePaused(!!paused);
  });
  // The renderer is the only side that knows whether the accessory ended up
  // mirrored (mini edge flip composed with the asset-direction flip). Hit
  // geometry consumes this instead of predicting it.
  on("accessory-mirror", (_event, mirrored) => {
    setAccessoryMirror(!!mirrored);
  });

  function companionObserving() {
    if (!isCompanionEnabledOption) return true;
    try {
      return isCompanionEnabledOption() === true;
    } catch {
      return false;
    }
  }

  function observeCompanion(fn) {
    try {
      fn();
    } catch (err) {
      companionLog(`companion observer failed: ${(err && err.message) || err}`);
    }
  }

  function isClickBurstFile(svg) {
    const reactions = getThemeReactions ? getThemeReactions() : null;
    if (!reactions || typeof reactions !== "object") return false;
    return reactionFiles(reactions.annoyed).includes(svg) || reactionFiles(reactions.double).includes(svg);
  }

  function takeDragDurationMs() {
    const duration = dragLockedAt != null ? now() - dragLockedAt : lastDragLockMs;
    dragLockedAt = null;
    lastDragLockMs = null;
    return duration;
  }

  function noteDragRestSpot(finalBounds) {
    if (!noteCompanionDragEnd || !getDisplayNearestPoint) return;
    // The clamped bounds just applied are where the pet came to rest; fall
    // back to the live bounds when no clamp was needed.
    const bounds = finalBounds || getPetWindowBounds();
    if (!bounds) return;
    const cx = bounds.x + bounds.width / 2;
    const cy = bounds.y + bounds.height / 2;
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;
    const display = getDisplayNearestPoint({ x: Math.round(cx), y: Math.round(cy) });
    const wa = display && display.workArea;
    if (!wa || !(wa.width > 0) || !(wa.height > 0)) return;
    noteCompanionDragEnd({
      displayId: display.id,
      x: clamp01((cx - wa.x) / wa.width),
      y: clamp01((cy - wa.y) / wa.height),
    });
  }

  on("drag-lock", (_event, locked) => {
    localDragLocked = !!locked;
    if (locked) {
      dragLockedAt = now();
      lastDragLockMs = null;
    } else if (dragLockedAt != null) {
      lastDragLockMs = now() - dragLockedAt;
      dragLockedAt = null;
    }
    setDragLocked(!!locked);
    if (locked) {
      setMouseOverPet(true);
      cancelRoam();
      beginDragSnapshot();
    } else {
      clearDragSnapshot();
      syncHitWin();
      syncDisplayedVisualGeometry();
      syncImeEditingPetDodge();
    }
  });

  on("start-drag-reaction", (_event, direction) => {
    const normalized = direction === "left" || direction === "right" ? direction : null;
    if (requestDragReaction) requestDragReaction(normalized);
    else sendToRenderer("start-drag-reaction", normalized);
  });
  on("end-drag-reaction", () => sendToRenderer("end-drag-reaction"));
  on("play-click-reaction", (_event, svg, duration) => {
    if (requestClickReaction) requestClickReaction(svg, duration);
    else sendToRenderer("play-click-reaction", svg, duration);
    if (noteCompanionEvent && typeof svg === "string" && svg && companionObserving()) {
      observeCompanion(() => noteCompanionEvent(isClickBurstFile(svg) ? "clickBurst" : "click"));
    }
  });

  if (handlePetGesture) {
    on("pet-interaction:gesture", (event, kind) => {
      if (typeof kind !== "string" || !PET_GESTURE_KINDS.has(kind)) return;
      if (hitWebContents) {
        let wc = null;
        try {
          wc = typeof hitWebContents === "function" ? hitWebContents() : hitWebContents;
        } catch {
          return;
        }
        if (!isTrustedMainFrameEvent(event, wc)) return;
      }
      if (isMiniMode() || isMiniTransitioning()) return;
      if (isDragLockedOption ? isDragLockedOption() : localDragLocked) return;
      observeCompanion(() => handlePetGesture(kind));
    });
  }

  on("drag-end", () => {
    // The renderer sends drag-end only after real movement: one mood event
    // per completed drag, measured from the drag lock.
    const dragMs = takeDragDurationMs();
    localDragLocked = false;
    const observing = companionObserving();
    if (noteCompanionEvent && observing) {
      observeCompanion(() => noteCompanionEvent(dragMs != null && dragMs > DRAG_LONG_MS ? "dragLong" : "drag"));
    }
    try {
      if (!isMiniMode() && !isMiniTransitioning()) {
        if (!getDisableMiniMode()) checkMiniModeSnap();
        if (isMiniMode() || isMiniTransitioning()) return;
        if (hasPetWindow()) {
          const virtualBounds = getPetWindowBounds();
          const size = getEffectiveCurrentPixelSize();
          const clamped = computeDragEndBounds(virtualBounds, size);
          if (clamped) {
            applyPetWindowBounds(clamped);
            flushRuntimeStateToPrefs();
          }
          reassertWinTopmost();
          scheduleHwndRecovery();
          syncHitWin();
          syncDisplayedVisualGeometry();
          repositionFloatingBubbles();
          refreshIdleVisualAfterDrag();
          if (observing) observeCompanion(() => noteDragRestSpot(clamped));
        }
      }
    } finally {
      setDragLocked(false);
      clearDragSnapshot();
      // Normally the preceding drag-lock(false) already re-ran the dodge, but
      // this handler also releases the lock defensively — mirror the re-run so
      // a drag-end without a paired drag-lock(false) can't strand the deferred
      // click-through write.
      syncImeEditingPetDodge();
    }
  });

  on("exit-mini-mode", () => {
    if (isMiniMode()) exitMiniMode();
  });

  on("pet-interaction:reveal-session-hud", () => {
    revealSessionHud();
  });

  // OS file drop from the hit window (#459, Windows/Linux only): first path
  // wins, files resolve to their parent directory, then open a plain terminal
  // there (no agent). The accept ping goes back to the SENDING window (hit
  // renderer plays its own reaction so its isReacting gate stays consistent).
  // macOS never registers the renderer-side listeners (screen-saver-level
  // windows are invisible to macOS drag-destination search); this guard is the
  // second layer so a stray IPC can't open terminals there either.
  on("pet-drop-paths", async (event, paths) => {
    try {
      if (isMacPlatform) {
        dropLog("drop ignored: OS file drop is disabled on macOS");
        return;
      }
      if (isMiniMode() || isMiniTransitioning()) return;
      if (!Array.isArray(paths)) return;
      const first = paths.find((p) => typeof p === "string" && p.length > 0);
      if (!first) return;
      let stats;
      try {
        stats = await statPath(first);
      } catch (_) {
        dropLog(`drop ignored: stat failed for ${first}`);
        return;
      }
      const dir = stats.isDirectory() ? first : path.dirname(first);
      const result = await openTerminalAt(dir);
      if (result && result.ok) {
        dropLog(`drop opened terminal=${result.terminal} dir=${dir}`);
        const sender = event && event.sender;
        if (sender && typeof sender.send === "function" && !(typeof sender.isDestroyed === "function" && sender.isDestroyed())) {
          sender.send("pet-drop-accepted");
        }
      } else {
        dropLog(`drop terminal launch failed: ${(result && result.message) || "unknown"}`);
      }
    } catch (err) {
      dropLog(`drop error: ${(err && err.message) || err}`);
    }
  });

  on("focus-terminal", () => {
    const focusableIds = getFocusableLocalHudSessionIds();
    focusLog(`focus request source=pet-body sid=- focusableCount=${focusableIds.length}`);
    if (focusableIds.length > 1) {
      focusLog(`focus result branch=none reason=multi-session-open-dashboard count=${focusableIds.length}`);
      showDashboard();
      return;
    }
    if (focusableIds.length === 1) {
      focusSession(focusableIds[0], { requestSource: "pet-body" });
      return;
    }
    focusLog("focus result branch=none reason=no-focusable-session source=pet-body");
  });

  return {
    dispose() {
      while (disposers.length) {
        const dispose = disposers.pop();
        dispose();
      }
    },
  };
}

module.exports = {
  isTrustedMainFrameEvent,
  registerPetInteractionIpc,
};
