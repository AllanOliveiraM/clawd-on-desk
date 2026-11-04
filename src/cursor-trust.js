"use strict";

// src/cursor-trust.js — XWayland cursor trust for the Clawd Alive mischief
// (spec 2026-11-04 §4, Ruling N2). Under XWayland the app only sees the real
// cursor over its own windows; elsewhere screen.getCursorScreenPoint() keeps
// the last point seen inside one of them, frozen. So under XWayland:
//   - the transparent render pet window is not a trust surface (the caller
//     leaves it out; the hit window stands for the pet);
//   - Settings and Dashboard ("pinned") report pointer leave, so a point
//     inside them is trusted even when still, until a leave report;
//   - every other app window (HUD, bubbles, hit window) is trusted only while
//     the point moved within MOTION_TRUST_MS;
//   - after a leave report the point is untrusted until it moves again.
// Outside XWayland every sample is trusted. No timer, no polling: the window
// list is read at sample time, at most once per WINDOWS_CACHE_MS.

const MOTION_TRUST_MS = 2000;
const WINDOWS_CACHE_MS = 1000;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

function validBounds(b) {
  return !!b && isNum(b.x) && isNum(b.y) && isNum(b.width) && isNum(b.height);
}

function contains(bounds, x, y) {
  return validBounds(bounds) && x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height;
}

// getWindows() -> [{ bounds, pinned }] of the visible app windows except the
// render pet window; pinned = Settings / Dashboard (they report pointer leave).
function createCursorTrust({ enabled = false, getWindows = () => [], now = Date.now } = {}) {
  let windows = null;
  let windowsAt = 0;
  let lastPoint = null;
  let movedAt = null;
  let leftSinceMotion = false;

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
    return windows;
  }

  function isTrusted(point) {
    if (!enabled) return true;
    if (!point || !isNum(point.x) || !isNum(point.y)) return false;
    const t = now();
    if (lastPoint && (lastPoint.x !== point.x || lastPoint.y !== point.y)) {
      movedAt = t;
      leftSinceMotion = false;
    }
    lastPoint = { x: point.x, y: point.y };
    if (leftSinceMotion) return false;
    const recent = movedAt !== null && t - movedAt >= 0 && t - movedAt <= MOTION_TRUST_MS;
    return readWindows(t).some((w) => contains(w.bounds, point.x, point.y) && (w.pinned === true || recent));
  }

  // Settings / Dashboard reported that the pointer left the window.
  function notePointerLeft() {
    if (!enabled) return;
    leftSinceMotion = true;
    movedAt = null;
  }

  return { enabled: !!enabled, isTrusted, notePointerLeft };
}

module.exports = { MOTION_TRUST_MS, WINDOWS_CACHE_MS, createCursorTrust };
