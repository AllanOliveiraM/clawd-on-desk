"use strict";

// src/companion-geometry.js — art-anchored geometry for Clawd Alive scenes.
//
// Every edge mime (poke, wall, sit-edge, reach-close) and the pounce strike
// line up a point of the art (a fingertip, the pushing hands, the ledge under
// the bottom) with a point of the screen. Those art points are authored in
// viewBox units; this module turns them into window pixels through the same
// layout math the renderer uses (hit-geometry.getAssetRectScreen), so nothing
// here hard-codes the clawd px-per-unit ratio. Pure: no Electron, no state.

const hitGeometry = require("./hit-geometry");

// ---- art anchors (viewBox units, clawd convention) ----
// Anchors are given for the variant drawn toward screen-left (or, for
// reach-close, the original drawn toward the top-right corner); the opposite
// variant mirrors them around the body center (u -> 2 * centerX - u).

// clawd-alive-poke-left.svg: the poking fingertip.
const POKE_FINGERTIP = Object.freeze({ u: -5.5, v: 10 });
// clawd-alive-pounce-strike-left.svg: the strike hand tip during the hold
// (artist report: lands at ~53% of the 1800 ms loop, holds until ~72%; the
// right file mirrors it to u 24.0). Tune here if the art changes.
const POUNCE_STRIKE_TIP = Object.freeze({ u: -9.0, v: 9.6 });
// clawd-alive-pounce-left.svg (short pounce, the fallback without strike art):
// where the paw pats after the lunge (~66-73% of the 2400 ms loop).
const POUNCE_SHORT_TIP = Object.freeze({ u: -6.5, v: 10.5 });
// clawd-alive-wall-push-left.svg: the line of the pushing hands.
const WALL_PUSH_HANDS_U = -2.5;
// clawd-alive-wall-peek-left.svg: the edge the pet peeks around.
const WALL_PEEK_EDGE_U = -1.12;
// clawd-alive-sit-edge.svg: the ledge the pet sits on (bottom of the feet).
const SIT_EDGE_LEDGE_V = 15;
// clawd-alive-reach-close.svg: the long arm's hand tip (top-right reach).
const REACH_CLOSE_TIP = Object.freeze({ u: 16, v: -9 });
// Reach-close parks the hand tip just under a typical ~40 px titlebar, this
// far in from the corner side.
const REACH_CLOSE_TITLEBAR_PX = 48;
const REACH_CLOSE_SIDE_INSET_PX = 20;

// Hover catch buckets (viewBox units of the resting pose): above the head,
// beside the arms, at the feet, else the body.
const CATCH_HIGH_V = 7.5;
const CATCH_LEFT_U = 2;
const CATCH_RIGHT_U = 13;
const CATCH_LOW_V = 13;
const DEFAULT_CENTER_U = 7.5;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

function catchBucket(u, v) {
  if (!isNum(u) || !isNum(v)) return null;
  if (v < CATCH_HIGH_V) return "high";
  if (u < CATCH_LEFT_U) return "left";
  if (u > CATCH_RIGHT_U) return "right";
  if (v > CATCH_LOW_V) return "low";
  return "body";
}

// Hover info for the companion from an asset pointer payload ({x, y} in
// viewBox units, hit-geometry.getAssetPointerPayload): the catch bucket and
// the half of the pet the cursor is on. null when the payload is unusable.
function hoverInfoFromPointer(payload, centerU = DEFAULT_CENTER_U) {
  if (!payload || !isNum(payload.x) || !isNum(payload.y)) return null;
  return {
    bucket: catchBucket(payload.x, payload.y),
    side: payload.x < (isNum(centerU) ? centerU : DEFAULT_CENTER_U) ? "left" : "right",
  };
}

function firstFile(theme, key) {
  const anims = theme && theme.companionAnimations;
  const entry = anims && typeof anims === "object" ? anims[key] : null;
  if (!entry) return null;
  if (Array.isArray(entry.files) && typeof entry.files[0] === "string" && entry.files[0]) return entry.files[0];
  return typeof entry.file === "string" && entry.file ? entry.file : null;
}

// Art helper for one theme and window size. Every method answers null when the
// theme cannot place the art (no viewBox / layout, missing key, no size): the
// callers then keep their whole-window fallback. The layout of each file is
// measured once per helper, so keep one helper per (theme, size).
function createArt(theme, size) {
  const W = size && isNum(size.width) && size.width > 0 ? size.width : 0;
  const H = size && isNum(size.height) && size.height > 0 ? size.height : 0;
  const frames = new Map();

  function measure(file) {
    if (!theme || !file || !W || !H) return null;
    const rect = hitGeometry.getAssetRectScreen(theme, { x: 0, y: 0, width: W, height: H }, "idle", file);
    const vb = hitGeometry.resolveViewBox(theme, "idle", file);
    if (!rect || !vb || !(rect.w > 0) || !(rect.h > 0) || !(vb.width > 0) || !(vb.height > 0)) return null;
    return { rect, vb };
  }

  function frame(file) {
    if (!frames.has(file)) frames.set(file, measure(file));
    return frames.get(file);
  }

  function centerU(file) {
    const layout = theme && theme.layout;
    if (layout && isNum(layout.centerX)) return layout.centerX;
    const f = frame(file);
    return f ? f.vb.x + f.vb.width / 2 : null;
  }

  const has = (key) => !!firstFile(theme, key);

  // Window-pixel offset (from the window's top-left) of art point (u, v).
  function point(key, u, v) {
    const f = frame(firstFile(theme, key));
    if (!f || !isNum(u) || !isNum(v)) return null;
    return {
      x: f.rect.x + ((u - f.vb.x) * f.rect.w) / f.vb.width,
      y: f.rect.y + ((v - f.vb.y) * f.rect.h) / f.vb.height,
    };
  }

  function mirrorU(key, u) {
    const c = centerU(firstFile(theme, key));
    return isNum(c) && isNum(u) ? 2 * c - u : null;
  }

  // Window-pixel insets of the theme's margin box (the box the rest clamp
  // keeps on screen): how far the window may hang above / below the work area.
  function visualMargins(key) {
    const box = theme && theme.layout && (theme.layout.marginBox || theme.layout.contentBox);
    if (!box || !isNum(box.y) || !isNum(box.height)) return null;
    const top = point(key, 0, box.y);
    const bottom = point(key, 0, box.y + box.height);
    if (!top || !bottom) return null;
    return { top: Math.max(0, top.y), bottom: Math.max(0, H - bottom.y) };
  }

  return { width: W, height: H, has, file: (key) => firstFile(theme, key), point, mirrorU, visualMargins };
}

module.exports = {
  POKE_FINGERTIP,
  POUNCE_STRIKE_TIP,
  POUNCE_SHORT_TIP,
  WALL_PUSH_HANDS_U,
  WALL_PEEK_EDGE_U,
  SIT_EDGE_LEDGE_V,
  REACH_CLOSE_TIP,
  REACH_CLOSE_TITLEBAR_PX,
  REACH_CLOSE_SIDE_INSET_PX,
  catchBucket,
  hoverInfoFromPointer,
  createArt,
};
