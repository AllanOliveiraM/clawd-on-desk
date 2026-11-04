"use strict";

// src/cursor-trust.js — XWayland cursor trust for the Clawd Alive mischief
// (spec 2026-11-04 §4, Ruling N2). Under XWayland the app only sees the real
// cursor over its own windows; elsewhere screen.getCursorScreenPoint() keeps
// the last point seen inside one of them, frozen. So under XWayland:
//   - the transparent render pet window is not a trust surface (the caller
//     leaves it out; the hit window stands for the pet);
//   - Settings and Dashboard ("pinned") report pointer leave, so a point
//     inside them is trusted even when still, until a leave report — but
//     only once the point moved inside that window since it last appeared
//     (a window reopened over a frozen point is not trusted), and for at
//     most PINNED_STILL_TRUST_MS without motion (a lost leave event);
//   - every other app window (HUD, bubbles, hit window) is trusted only while
//     the point moved within MOTION_TRUST_MS;
//   - after a leave report the point is untrusted until it moves again.
// Outside XWayland every sample is trusted. No timer, no polling: the window
// list is read at sample time, at most once per WINDOWS_CACHE_MS.

const MOTION_TRUST_MS = 2000;
const PINNED_STILL_TRUST_MS = 90000;
const WINDOWS_CACHE_MS = 1000;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

function validBounds(b) {
  return !!b && isNum(b.x) && isNum(b.y) && isNum(b.width) && isNum(b.height);
}

function contains(bounds, x, y) {
  return validBounds(bounds) && x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height;
}

// getWindows() -> [{ id, bounds, pinned }] of the visible app windows except
// the render pet window; pinned = Settings / Dashboard (they report pointer
// leave); id tells a window apart across reads (BrowserWindow.id).
function createCursorTrust({ enabled = false, getWindows = () => [], now = Date.now } = {}) {
  let windows = null;
  let windowsAt = 0;
  let lastPoint = null;
  let lastPointAt = null;
  let movedAt = null;
  let leftSinceMotion = false;
  // Pinned windows the point moved inside since they last appeared.
  let armed = new Set();
  // Pinned window keys seen by the latest read, and the points that moved
  // while reads were served from the cache without landing in a known pinned
  // window (a window may have opened inside that gap).
  let knownPinned = new Set();
  let gapMoves = [];

  function keyOf(w) {
    return w.id !== undefined && w.id !== null
      ? `id:${w.id}`
      : `b:${w.bounds.x},${w.bounds.y},${w.bounds.width},${w.bounds.height}`;
  }

  function readWindows(t) {
    if (windows && t - windowsAt >= 0 && t - windowsAt < WINDOWS_CACHE_MS) return windows;
    let list;
    try {
      list = getWindows();
    } catch {
      list = [];
    }
    windows = Array.isArray(list) ? list.filter((w) => w && validBounds(w.bounds)) : [];
    windowsAt = t;
    // A pinned window that closed or hid must be moved in again once back.
    const pinnedNow = windows.filter((w) => w.pinned === true);
    const present = new Set(pinnedNow.map(keyOf));
    armed = new Set([...armed].filter((key) => present.has(key)));
    // A pinned window that appeared in the cache gap and was moved in before
    // this read arms now; one that was already known (or replaced a known one)
    // does not, since those moves landed in the old window.
    for (const w of pinnedNow) {
      const key = keyOf(w);
      if (!knownPinned.has(key) && gapMoves.some((p) => contains(w.bounds, p.x, p.y))) armed.add(key);
    }
    knownPinned = present;
    gapMoves = [];
    return windows;
  }

  function isTrusted(point) {
    if (!enabled) return true;
    if (!point || !isNum(point.x) || !isNum(point.y)) return false;
    const t = now();
    // A change across a sample gap longer than MOTION_TRUST_MS proves nothing
    // (the frozen point may have moved long ago): only refresh lastPoint.
    const fresh = lastPointAt !== null && t - lastPointAt <= MOTION_TRUST_MS;
    const moved = !!lastPoint && fresh && (lastPoint.x !== point.x || lastPoint.y !== point.y);
    lastPointAt = t;
    if (moved) {
      movedAt = t;
      leftSinceMotion = false;
    }
    lastPoint = { x: point.x, y: point.y };
    const cached = !!windows && t - windowsAt >= 0 && t - windowsAt < WINDOWS_CACHE_MS;
    if (cached && moved && !windows.some((w) => w.pinned === true && contains(w.bounds, point.x, point.y))) {
      gapMoves.push({ x: point.x, y: point.y });
      if (gapMoves.length > 64) gapMoves.shift();
    }
    const list = readWindows(t);
    const inside = list.filter((w) => contains(w.bounds, point.x, point.y));
    if (moved) for (const w of inside) if (w.pinned === true) armed.add(keyOf(w));
    if (leftSinceMotion) return false;
    const still = movedAt !== null && t - movedAt >= 0 ? t - movedAt : Infinity;
    return inside.some((w) => (w.pinned === true && armed.has(keyOf(w)) && still <= PINNED_STILL_TRUST_MS)
      || still <= MOTION_TRUST_MS);
  }

  // Settings / Dashboard reported that the pointer left the window.
  function notePointerLeft() {
    if (!enabled) return;
    leftSinceMotion = true;
    movedAt = null;
    armed = new Set();
  }

  return { enabled: !!enabled, isTrusted, notePointerLeft };
}

module.exports = { MOTION_TRUST_MS, PINNED_STILL_TRUST_MS, WINDOWS_CACHE_MS, createCursorTrust };
