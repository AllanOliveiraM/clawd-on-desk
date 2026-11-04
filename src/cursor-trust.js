"use strict";

// src/cursor-trust.js — XWayland cursor trust for the Clawd Alive mischief
// (spec 2026-11-04 §4). Under XWayland the app only sees the real cursor
// over its own windows; elsewhere screen.getCursorScreenPoint() returns the
// last known point, frozen. A sample is trusted only inside the bounds of a
// visible app window (pet, hit, settings, dashboard, HUD, bubbles). Outside
// XWayland every sample is trusted. No timer, no polling: the bounds are read
// at sample time, and the same point reuses its answer for CACHE_MS.

const CACHE_MS = 1000;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

function contains(bounds, x, y) {
  return !!bounds && isNum(bounds.x) && isNum(bounds.y) && isNum(bounds.width) && isNum(bounds.height)
    && x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height;
}

function createCursorTrust({ enabled = false, getWindowBounds = () => [], now = Date.now } = {}) {
  let cached = null; // { x, y, at, trusted }

  function isTrusted(point) {
    if (!enabled) return true;
    if (!point || !isNum(point.x) || !isNum(point.y)) return false;
    const t = now();
    if (cached && cached.x === point.x && cached.y === point.y && t - cached.at >= 0 && t - cached.at < CACHE_MS) {
      return cached.trusted;
    }
    let list = [];
    try {
      list = getWindowBounds();
    } catch {
      list = [];
    }
    const trusted = Array.isArray(list) && list.some((bounds) => contains(bounds, point.x, point.y));
    cached = { x: point.x, y: point.y, at: t, trusted };
    return trusted;
  }

  return { isTrusted };
}

module.exports = { CACHE_MS, createCursorTrust };
