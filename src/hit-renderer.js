// --- Input window: pointer capture, drag, click detection ---
// This is the "controller" — all input decisions happen here.
// Render window is pure "view" — receives reaction commands via IPC relay.

const area = document.getElementById("hit-area");

// ── Theme config (injected via preload-hit.js additionalArguments) ──
let tc = window.hitThemeConfig || {};
let _reactions = (tc && tc.reactions) || {};

// ── Platform (injected via preload-hit.js additionalArguments) ──
const isMac = !!(window.hitPlatform && window.hitPlatform.isMac);

// Theme switch: IPC push overrides additionalArguments
if (window.hitAPI && window.hitAPI.onThemeConfig) {
  window.hitAPI.onThemeConfig((cfg) => {
    tc = cfg || {};
    _reactions = (tc && tc.reactions) || {};
  });
}

// --- State synced from main ---
let currentState = null;
let miniMode = false;
let dndEnabled = false;
// Clawd Alive (opt-in): companionEnabled && companionInteractions, pushed by main.
let petGesturesEnabled = false;

window.hitAPI.onStateSync((data) => {
  if (data.currentState !== undefined) currentState = data.currentState;
  if (data.miniMode !== undefined) {
    miniMode = data.miniMode;
    area.style.cursor = miniMode ? "default" : "";
  }
  if (data.dndEnabled !== undefined) dndEnabled = data.dndEnabled;
  if (data.petGesturesEnabled !== undefined) petGesturesEnabled = data.petGesturesEnabled === true;
  if (!petGesturesEnabled || miniMode) endPetGestures();
});

// --- Drag state ---
let isDragging = false;
let didDrag = false;
let mouseDownX, mouseDownY;
let lastDragClientX;
let dragReactionDirection = null;
let dragMoveRAF = null;
const DRAG_THRESHOLD = 3;

// --- Reaction state (tracked here to gate input) ---
let isReacting = false;
let isDragReacting = false;

// Cancel signal from main (e.g. state change)
window.hitAPI.onCancelReaction(() => {
  endPetGestures();
  if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; clickCount = 0; firstClickDir = null; }
  isReacting = false;
  isDragReacting = false;
  dragReactionDirection = null;
});

function queueDragMove() {
  if (dragMoveRAF !== null) return;
  dragMoveRAF = requestAnimationFrame(() => {
    dragMoveRAF = null;
    if (!isDragging) return;
    window.hitAPI.dragMove();
  });
}

function clearQueuedDragMove() {
  if (dragMoveRAF === null) return;
  cancelAnimationFrame(dragMoveRAF);
  dragMoveRAF = null;
}

// --- Petting / hover gestures (Clawd Alive, opt-in) ---
// Everything here is inert unless main sent petGesturesEnabled=true AND the
// detector script loaded (hit.html includes pet-stroke-detector.js before this
// file). Listeners never preventDefault, capture the pointer or touch the
// drag / click state: they only observe button-less hover moves and report
// "pet-start" / "pet-continue" / "pet-end" / "hover-dwell" to main, which
// re-validates everything. After a dwell, the first move > 3 px (or the leave)
// reports one "hover-move" (Clawd Mischief: the catch turns into a miss).
// Both timers exist only while needed: the 500 ms poll while the detector is
// active, the 1200 ms dwell inside a fresh entry.
const PET_POLL_MS = 500;
const HOVER_DWELL_MS = 1200;
const HOVER_DWELL_SLOP_PX = 3;
const _petStrokeApi = window.ClawdPetStrokeDetector || null;
const petDetector = _petStrokeApi && typeof _petStrokeApi.createPetStrokeDetector === "function"
  ? _petStrokeApi.createPetStrokeDetector()
  : null;
let petPollTimer = null;
let hoverDwellTimer = null;
let hoverEntryX = 0;
let hoverEntryY = 0;
let hoverLastX = 0;
let hoverLastY = 0;
// Set when a dwell was sent; cleared once hover-move goes out or on the next entry.
let hoverMoveArmed = false;
let hoverMoveX = 0;
let hoverMoveY = 0;

function petGesturesAllowed() {
  return petGesturesEnabled && !!petDetector && !miniMode && !dndEnabled && !isDragging;
}

function sendPetGesture(kind) {
  if (window.hitAPI.petGesture) window.hitAPI.petGesture(kind);
}

function cancelHoverDwell() {
  if (hoverDwellTimer === null) return;
  clearTimeout(hoverDwellTimer);
  hoverDwellTimer = null;
}

function schedulePetPoll() {
  if (petPollTimer !== null) return;
  petPollTimer = setTimeout(() => {
    petPollTimer = null;
    if (!petDetector) return;
    const out = petDetector.poll();
    if (out) sendPetGesture(out);
    if (petDetector.isActive()) schedulePetPoll();
  }, PET_POLL_MS);
}

// Every end path: drop both timers, reset the detector, and report the end
// only when a petting session was actually running.
function endPetGestures() {
  cancelHoverDwell();
  if (petPollTimer !== null) {
    clearTimeout(petPollTimer);
    petPollTimer = null;
  }
  if (!petDetector) return;
  const wasActive = petDetector.isActive();
  petDetector.reset();
  if (wasActive) sendPetGesture("pet-end");
}

function sendHoverMoveOnce() {
  if (!hoverMoveArmed) return;
  hoverMoveArmed = false;
  if (petGesturesAllowed()) sendPetGesture("hover-move");
}

function handlePetHoverMove(e) {
  hoverLastX = e.clientX;
  hoverLastY = e.clientY;
  if (hoverMoveArmed
    && Math.hypot(e.clientX - hoverMoveX, e.clientY - hoverMoveY) > HOVER_DWELL_SLOP_PX) {
    sendHoverMoveOnce();
  }
  if (hoverDwellTimer !== null
    && Math.hypot(e.clientX - hoverEntryX, e.clientY - hoverEntryY) > HOVER_DWELL_SLOP_PX) {
    cancelHoverDwell();
  }
  const out = petDetector.feed(e.clientX, e.clientY);
  if (out) sendPetGesture(out);
  if (petDetector.isActive()) schedulePetPoll();
}

area.addEventListener("pointerenter", (e) => {
  cancelHoverDwell();
  hoverMoveArmed = false;
  if (!petGesturesAllowed()) return;
  hoverEntryX = e.clientX;
  hoverEntryY = e.clientY;
  hoverLastX = e.clientX;
  hoverLastY = e.clientY;
  hoverDwellTimer = setTimeout(() => {
    hoverDwellTimer = null;
    if (!petGesturesAllowed()) return;
    sendPetGesture("hover-dwell");
    hoverMoveArmed = true;
    hoverMoveX = hoverLastX;
    hoverMoveY = hoverLastY;
  }, HOVER_DWELL_MS);
});

area.addEventListener("pointerleave", () => {
  sendHoverMoveOnce();
  endPetGestures();
});
window.addEventListener("blur", () => endPetGestures());

// --- Pointer handlers ---
area.addEventListener("pointerdown", (e) => {
  endPetGestures();
  if (e.button === 0) {
    if (miniMode) { didDrag = false; return; }
    area.setPointerCapture(e.pointerId);
    isDragging = true;
    didDrag = false;
    mouseDownX = e.clientX;
    mouseDownY = e.clientY;
    lastDragClientX = e.clientX;
    dragReactionDirection = null;
    window.hitAPI.dragLock(true);
    area.classList.add("dragging");
  }
});

document.addEventListener("pointermove", (e) => {
  if (isDragging) {
    // A swallowed pointerup (UAC secure desktop, RDP reconnect, fullscreen
    // transition) leaves isDragging and the main-process drag lock stranded
    // while hover moves keep flowing. The first move with no pressed button
    // proves the physical gesture is over — finish through the normal stop
    // path (drag-lock false, drag-end if moved). A real drag always carries
    // buttons != 0, and a held-still mouse emits no moves at all, so a
    // genuine long press is never cut short by this.
    if (e.buttons === 0) {
      stopDrag();
      return;
    }
    if (!didDrag) {
      const totalDx = e.clientX - mouseDownX;
      const totalDy = e.clientY - mouseDownY;
      if (Math.abs(totalDx) > DRAG_THRESHOLD || Math.abs(totalDy) > DRAG_THRESHOLD) {
        didDrag = true;
        startDragReaction(totalDx < 0 ? "left" : (totalDx > 0 ? "right" : null));
      }
    } else {
      const stepDx = e.clientX - lastDragClientX;
      if (stepDx !== 0) startDragReaction(stepDx < 0 ? "left" : "right");
    }
    lastDragClientX = e.clientX;
    queueDragMove();
  } else if (e.buttons === 0 && petGesturesAllowed()) {
    handlePetHoverMove(e);
  }
});

function stopDrag() {
  if (!isDragging) return;
  clearQueuedDragMove();
  isDragging = false;
  window.hitAPI.dragLock(false);
  area.classList.remove("dragging");
  if (didDrag) {
    window.hitAPI.dragEnd();
  }
  // A state-change cancel can arrive after pointer movement and clear the
  // input window's local reaction flag. The render window may already have
  // received startDragReaction, so an actual drag must still complete the
  // end handshake on pointerup/cancel/lost capture/blur.
  endDragReaction(didDrag);
}

document.addEventListener("pointerup", (e) => {
  if (e.button !== 0) return;
  const wasDrag = didDrag;
  stopDrag();
  if (wasDrag) return;

  // macOS Ctrl-click is the system right-click gesture. Let the OS / our
  // contextmenu handler deal with it; do NOT treat it as the Dashboard
  // shortcut, and do NOT fall through to handleClick (would otherwise
  // leak into the click accumulator).
  if (isMac && e.ctrlKey && !e.metaKey) {
    resetClickAccumulator();
    return;
  }

  // Dashboard shortcut: Cmd-click on mac, Ctrl-click elsewhere.
  const isDashboardShortcut = isMac ? e.metaKey : (e.ctrlKey && !e.metaKey);
  if (isDashboardShortcut) {
    resetClickAccumulator();
    window.hitAPI.showDashboard();
    return;
  }

  handleClick(e.clientX);
});

area.addEventListener("pointercancel", () => stopDrag());
area.addEventListener("lostpointercapture", () => { endPetGestures(); if (isDragging) stopDrag(); });
window.addEventListener("blur", stopDrag);

// Main released the lock because a user-invoked recovery ran (bring to
// primary display / send to display / hide show). If this renderer is alive
// and still holding a phantom capture, drop it through the normal stop path
// so gesture state, drag reaction and the input gate all unwind together.
window.hitAPI.onForceDragRelease(() => {
  if (isDragging) stopDrag();
});

// --- Click reaction logic (2-click = poke, 4-click = flail) ---
const CLICK_WINDOW_MS = 400;

let clickCount = 0;
let clickTimer = null;
let firstClickDir = null;

function _getReaction(name) {
  return _reactions[name] || null;
}

function resetClickAccumulator() {
  if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
  clickCount = 0;
  firstClickDir = null;
}

// Fresh-read at reaction timer fire time, NOT closured at click time —
// state / DND may change inside the 400 ms accumulator window.
function canPlayReactionNow() {
  return currentState === "idle" && !dndEnabled && !isReacting;
}

function handleClick(clientX) {
  if (miniMode) {
    window.hitAPI.exitMiniMode();
    return;
  }
  if (isDragReacting) return;

  clickCount++;
  if (clickCount === 1) {
    firstClickDir = clientX < area.offsetWidth / 2 ? "left" : "right";
    // First click reveals the session HUD. Lightweight side effect — NOT
    // gated by isReacting (HUD reveal is independent of pet animation).
    window.hitAPI.revealSessionHud();
  }

  if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }

  const doubleReact = _getReaction("double");
  const annoyedReact = _getReaction("annoyed");
  const leftReact = _getReaction("clickLeft");
  const rightReact = _getReaction("clickRight");

  if (clickCount >= 4 && doubleReact) {
    clickCount = 0;
    firstClickDir = null;
    if (!canPlayReactionNow()) return;
    const files = doubleReact.files || [doubleReact.file];
    const file = files[Math.floor(Math.random() * files.length)];
    playReaction(file, doubleReact.duration || 3500);
  } else if (clickCount >= 2) {
    clickTimer = setTimeout(() => {
      clickTimer = null;
      clickCount = 0;
      const dir = firstClickDir;
      firstClickDir = null;
      if (!canPlayReactionNow()) return;
      if (annoyedReact && Math.random() < 0.5) {
        playReaction(annoyedReact.file, annoyedReact.duration || 3500);
      } else if (leftReact && rightReact) {
        const react = dir === "left" ? leftReact : rightReact;
        playReaction(react.file, react.duration || 2500);
      }
    }, CLICK_WINDOW_MS);
  } else {
    clickTimer = setTimeout(() => {
      clickTimer = null;
      clickCount = 0;
      firstClickDir = null;
    }, CLICK_WINDOW_MS);
  }
}

function playReaction(svg, duration) {
  if (!svg) return;
  isReacting = true;
  window.hitAPI.playClickReaction(svg, duration);
  // Local timer to ungate input after duration
  setTimeout(() => { isReacting = false; }, duration);
}

// --- Drag reaction ---
function startDragReaction(direction) {
  if (dndEnabled) return;
  if (isDragReacting && dragReactionDirection === direction) return;

  if (isReacting) {
    isReacting = false;
  }

  isDragReacting = true;
  dragReactionDirection = direction;
  window.hitAPI.startDragReaction(direction);
}

function endDragReaction(force = false) {
  if (!isDragReacting && !force) return;
  isDragReacting = false;
  dragReactionDirection = null;
  window.hitAPI.endDragReaction();
}

// --- OS file drop → open terminal at that directory (#459, Windows/Linux only) ---
// macOS is OUT: the pet windows live at screen-saver level so they stay above
// fullscreen apps, and macOS drag-destination search never delivers drag
// events to windows at that level (real-machine bisect, 2026-06-11 — lowering
// only the hit window doesn't help either, the overlapping screen-saver render
// window still blocks the search; ignoresMouseEvents passes mouse events
// through but NOT drag destinations). Don't re-attempt without changing the
// window-level model; listeners are simply not registered on mac.
//
// Affordance gating lives HERE (not only in main): in mini mode dragover must
// not preventDefault, so the OS shows "no drop" instead of a copy cursor that
// would then do nothing. Main re-checks mini (and platform) as the second layer.
function dragHasFiles(e) {
  const types = e.dataTransfer && e.dataTransfer.types;
  if (!types) return false;
  for (const t of types) { if (t === "Files") return true; }
  return false;
}

if (!isMac) {
  area.addEventListener("dragover", (e) => {
    if (miniMode || !dragHasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });

  area.addEventListener("drop", (e) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    if (miniMode) return;
    const paths = [];
    for (const file of e.dataTransfer.files || []) {
      const p = window.hitAPI.getPathForFile(file);
      if (typeof p === "string" && p) paths.push(p);
    }
    if (paths.length) window.hitAPI.dropPaths(paths);
  });

  // Main confirmed the drop opened a terminal → react. Routed back through the
  // local playReaction so isReacting gating stays consistent. Best-effort with a
  // fallback chain: double (Clawd) → clickLeft/clickRight poke (Calico) →
  // nothing (Cloudling only ships a drag reaction; no new theme capability is
  // invented for drops).
  window.hitAPI.onDropAccepted(() => {
    if (!canPlayReactionNow()) return;
    const doubleReact = _getReaction("double");
    if (doubleReact) {
      const files = doubleReact.files || [doubleReact.file];
      playReaction(files[Math.floor(Math.random() * files.length)], doubleReact.duration || 3500);
      return;
    }
    const left = _getReaction("clickLeft");
    const right = _getReaction("clickRight");
    const poke = left && right ? (Math.random() < 0.5 ? left : right) : (left || right);
    if (poke) playReaction(poke.file, poke.duration || 2500);
  });
}

// --- Right-click context menu ---
// #1260: a menu popped mid-drag runs a modal loop that takes the OS mouse
// capture and swallows the closing pointerup, and while dragLocked is held
// syncHitWin() keeps the input window at its pre-drag rect. After the menu
// closes no pointer event reaches this renderer again (capture is gone and
// the cursor sits over the pet's new position, off the stale input rect), so
// the buttons=0 move self-heal can never fire and the drag strand is
// permanent — pet frozen in the drag pose, input window stranded at the old
// rect, right-click falling through to whatever is underneath. Ending the
// drag through the normal stop path BEFORE the menu opens leaves nothing to
// strand regardless of what the menu loop swallows.
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  endPetGestures();
  if (isDragging) stopDrag();
  window.hitAPI.showContextMenu();
});
