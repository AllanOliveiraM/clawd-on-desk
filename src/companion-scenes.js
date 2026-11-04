"use strict";

// src/companion-scenes.js — multi-part scene player for the Clawd Alive
// "mischief" layer.
//
// A scene is a list of parts { key, file, duration, loop?, maxMs?, once? }. A
// `once` part is a one-shot intro / outro played exactly for its own length;
// an `optional` part without art is left out of the scene. Every part
// (and every iteration of a looping part) is a fresh send through the
// runtime's own play() protocol: send -> committed settlement -> duration ->
// next part. Each send is a new visual generation, so a newer visual, a state
// change or a closed gate ends the whole scene, and idle is restored only while
// the scene still owns the screen. The player owns no timer: the runtime's
// per-playback timer drives the end of each part.

const {
  POKE_FINGERTIP,
  WALL_PUSH_HANDS_U,
  WALL_PEEK_EDGE_U,
  SIT_EDGE_LEDGE_V,
  REACH_CLOSE_TIP,
  REACH_CLOSE_TITLEBAR_PX,
  REACH_CLOSE_SIDE_INSET_PX,
} = require("./companion-geometry");

const SCENE_DEFAULT_DURATION_MS = 3500;
const SCENE_MIN_DURATION_MS = 1000;
const SCENE_MAX_DURATION_MS = 8000;
// One-shot intro / outro parts may be much shorter than a scene part.
const ONE_SHOT_MIN_DURATION_MS = 100;
const FAKE_NAP_MAX_MS = 20000;
const SIT_EDGE_MAX_MS = 15000;

// Reactive scenes answer the user (interactions switch); the rest are the
// pet's own initiative (autonomy switch).
const REACTIVE_SCENES = new Set(["catch", "pounce"]);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function partDurationMs(anim, once = false) {
  const authored = anim && Number.isFinite(anim.duration) && anim.duration > 0;
  if (once && authored) return clamp(anim.duration, ONE_SHOT_MIN_DURATION_MS, SCENE_MAX_DURATION_MS);
  const duration = authored ? anim.duration : SCENE_DEFAULT_DURATION_MS;
  return clamp(duration, SCENE_MIN_DURATION_MS, SCENE_MAX_DURATION_MS);
}

function sided(base, side) {
  return base + (side === "left" ? "Left" : "Right");
}

const CATCH_BUCKETS = { high: "High", body: "Body", low: "Low", left: "Left", right: "Right" };

// The bucket's own key when the theme has it, else the plain key.
function bucketKey(base, bucket, hasKey) {
  const suffix = Object.prototype.hasOwnProperty.call(CATCH_BUCKETS, bucket) ? CATCH_BUCKETS[bucket] : null;
  return suffix && hasKey(base + suffix) ? base + suffix : base;
}

// Theme keys of each scene. `on` lists the parts an external event switches to.
function sceneSpec(id, opts, hasKey, random) {
  switch (id) {
    case "catch":
      // Directional catch (Ruling P3); each part falls back on its own.
      return {
        parts: [{ key: bucketKey("catch", opts.bucket, hasKey) }],
        on: { "hover-move": [{ key: bucketKey("catchMiss", opts.bucket, hasKey) }] },
      };
    case "pounce": {
      // The long-reach strike when the theme has it, else the short pounce.
      const strike = sided("pounceStrike", opts.side);
      return { parts: [{ key: hasKey(strike) ? strike : sided("pounce", opts.side) }] };
    }
    case "poke":
      return { parts: [{ key: sided("poke", opts.side) }] };
    case "fakeNap":
      // Lie down, nap, get up; a boo jumps straight up (no nap-out).
      return {
        parts: [
          { key: "fakeNapIn", once: true, optional: true },
          { key: "fakeNap", loop: true, maxMs: FAKE_NAP_MAX_MS },
          { key: "fakeNapOut", once: true, optional: true },
        ],
        on: { boo: [{ key: "boo" }] },
      };
    case "sitEdge":
      return {
        parts: [
          { key: "sitDown", once: true, optional: true },
          { key: "sitEdge", loop: true, maxMs: SIT_EDGE_MAX_MS },
          { key: "standUp", once: true, optional: true },
        ],
      };
    case "wall": {
      // An art-anchored walk fixed push or peek when it was planned.
      if (typeof opts.variant === "string" && hasKey(opts.variant)) return { parts: [{ key: opts.variant }] };
      const open = [sided("wallPush", opts.side), sided("wallPeek", opts.side)].filter(hasKey);
      if (open.length === 0) return null;
      const index = clamp(Math.floor(random() * open.length), 0, open.length - 1);
      return { parts: [{ key: open[Number.isFinite(index) ? index : 0] }] };
    }
    case "dayRhythm":
    case "toy":
      return typeof opts.variant === "string" ? { parts: [{ key: opts.variant }] } : null;
    case "reachClose":
      // reachCloseLeft (macOS corner) when the walk planned it and the art exists.
      return { parts: [{ key: opts.variant === "reachCloseLeft" && hasKey("reachCloseLeft") ? "reachCloseLeft" : "reachClose" }] };
    case "welcome":
    case "stretchBack":
      return { parts: [{ key: id }] };
    default:
      return null;
  }
}

// Resolves every part to a file. Returns null when a main part has no art;
// an optional part without art is left out (the scene keeps its other parts);
// an event whose parts have no art is simply dropped (fake nap without boo
// just ends at maxMs).
function buildScene(id, opts, resolve, random) {
  const options = opts || {};
  const hasKey = (key) => !!resolve(key);
  const spec = sceneSpec(id, options, hasKey, random);
  if (!spec) return null;
  const toParts = (list) => {
    const out = [];
    for (const part of list) {
      const anim = resolve(part.key);
      if (!anim) {
        if (part.optional) continue;
        return null;
      }
      const { optional, ...rest } = part;
      out.push({ ...rest, file: anim.file, duration: partDurationMs(anim, !!part.once) });
    }
    return out;
  };
  const parts = toParts(spec.parts);
  if (!parts) return null;
  const on = {};
  for (const [event, list] of Object.entries(spec.on || {})) {
    const resolved = toParts(list);
    if (resolved) on[event] = resolved;
  }
  return {
    id,
    requires: REACTIVE_SCENES.has(id) ? "interactions" : "autonomy",
    parts,
    on,
    index: 0,
    partStartedAt: null,
    switched: false, // at most one event switch per scene
  };
}

const VARIANT_KEYS = ["morningStretch", "coffee", "nightSleepy", "toyBall", "toyYoyo", "toyPlane"];
const WALL_KEYS = ["wallPushLeft", "wallPushRight", "wallPeekLeft", "wallPeekRight"];

// Ids/variants the mischief brain may pick, mapped from the theme keys present.
// Single-part only (activities mode) leaves out every walking or looping scene.
function mischiefAvailable(keys, singlePartOnly) {
  const out = new Set(VARIANT_KEYS.filter((key) => keys.has(key)));
  if (singlePartOnly) return out;
  for (const id of ["fakeNap", "reachClose", "sitEdge"]) if (keys.has(id)) out.add(id);
  if (WALL_KEYS.some((key) => keys.has(key))) out.add("wall");
  return out;
}

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

// reachClose stops this far from its corner: 1.5 pet widths from the corner
// side and 0.4 pet heights below the work-area top.
const REACH_CLOSE_INSET_X = 1.5;
const REACH_CLOSE_INSET_Y = 0.4;

// Arrival tolerance of an art-anchored walk: the anchor (fingertip, hands,
// ledge, hand tip) may end this fraction of the pet width off its spot.
const SPOT_TOLERANCE_RATIO = 0.05;
// Same sideways overhang the rest clamp allows (clampToScreenVisual, 0.25 w).
const SCREEN_SIDE_OVERHANG_RATIO = 0.25;

function overhangOf(spot, area, W, H) {
  return {
    left: Math.max(0, area.x - spot.x),
    right: Math.max(0, spot.x + W - (area.x + area.width)),
    top: Math.max(0, area.y - spot.y),
    bottom: Math.max(0, spot.y + H - (area.y + area.height)),
  };
}

// Art-anchored walk (Ruling P4): the exact window top-left that puts an art
// anchor on its screen point. undefined -> the art cannot be placed (keep the
// whole-window walk); null -> skip this walk (it would never line up).
function artWalkTarget(walk, { area, bounds, art, platform, random, petWidth }) {
  const W = art.width;
  const H = art.height;
  if (!W || !H) return undefined;
  const hasBounds = !!bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(isNum);
  const right = area.x + area.width;
  const bottom = area.y + area.height;
  const done = (spot, extra = {}) => ({ spot, overhang: overhangOf(spot, area, W, H), side: null, petWidth, ...extra });
  if (walk.id === "reachClose") {
    const darwin = platform === "darwin";
    const key = darwin && art.has("reachCloseLeft") ? "reachCloseLeft" : "reachClose";
    const u = darwin ? art.mirrorU(key, REACH_CLOSE_TIP.u) : REACH_CLOSE_TIP.u;
    const tip = art.point(key, u, REACH_CLOSE_TIP.v);
    if (!tip) return undefined;
    const x = darwin ? area.x + REACH_CLOSE_SIDE_INSET_PX - tip.x : right - REACH_CLOSE_SIDE_INSET_PX - tip.x;
    return done({ x, y: area.y + Math.max(0, REACH_CLOSE_TITLEBAR_PX - tip.y) }, { variant: key });
  }
  if (walk.id === "wall") {
    const cx = hasBounds ? bounds.x + bounds.width / 2 : area.x + area.width / 2;
    const side = cx - area.x <= right - cx ? "left" : "right";
    const open = [sided("wallPush", side), sided("wallPeek", side)].filter((key) => art.has(key));
    if (open.length === 0) return undefined;
    const index = clamp(Math.floor(random() * open.length), 0, open.length - 1);
    const key = open[Number.isFinite(index) ? index : 0];
    const leftU = key.startsWith("wallPush") ? WALL_PUSH_HANDS_U : WALL_PEEK_EDGE_U;
    const anchor = art.point(key, side === "left" ? leftU : art.mirrorU(key, leftU), 0);
    if (!anchor) return undefined;
    const y = hasBounds ? bounds.y : area.y + (area.height - H) / 2;
    return done({ x: side === "left" ? area.x - anchor.x : right - anchor.x, y }, { side, variant: key });
  }
  if (walk.id === "sitEdge") {
    const ledge = art.point("sitEdge", 0, SIT_EDGE_LEDGE_V);
    if (!ledge) return undefined;
    const x = hasBounds ? bounds.x : area.x + (area.width - W) / 2;
    return done({ x, y: bottom - ledge.y });
  }
  if (walk.id === "poke" && walk.target && isNum(walk.target.x) && isNum(walk.target.y)) {
    const cx = hasBounds ? bounds.x + bounds.width / 2 : area.x + area.width / 2;
    const side = cx < walk.target.x ? "right" : "left";
    const key = sided("poke", side);
    const u = side === "left" ? POKE_FINGERTIP.u : art.mirrorU(key, POKE_FINGERTIP.u);
    const tip = art.point(key, u, POKE_FINGERTIP.v);
    if (!tip) return undefined;
    const spot = { x: walk.target.x - tip.x, y: walk.target.y - tip.y };
    // Screen-visual limits (not roam's margin band): the rest clamp's sideways
    // overhang and the theme margin box top / bottom.
    const margins = art.visualMargins(key) || { top: 0, bottom: 0 };
    const side25 = SCREEN_SIDE_OVERHANG_RATIO * W;
    const yMin = area.y - margins.top;
    const yMax = bottom - H + margins.bottom;
    const cxSpot = clamp(spot.x, area.x - side25, right - W + side25);
    if (spot.y < yMin || spot.y > yMax || Math.abs(cxSpot - spot.x) > SPOT_TOLERANCE_RATIO * W) return null;
    return done(spot, { side });
  }
  return undefined;
}

// Center point a walking mischief heads to, on the pet's current work area,
// plus the scene side fixed for the arrival. null when it cannot be placed.
// With `art` (companion-geometry.createArt) the art-anchored spot wins when
// the theme can place it: { spot, overhang, side, variant, petWidth }.
function walkTarget(walk, { area, bounds, size, platform, art, random = Math.random }) {
  if (art) {
    const width0 = size && isNum(size.width) ? size.width : (bounds && isNum(bounds.width) ? bounds.width : 0);
    const anchored = artWalkTarget(walk, { area, bounds, art, platform, random, petWidth: width0 });
    if (anchored !== undefined) return anchored;
  }
  const width = size && isNum(size.width) ? size.width : 0;
  const height = size && isNum(size.height) ? size.height : 0;
  const hasBounds = !!bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(isNum);
  const cx = hasBounds ? bounds.x + bounds.width / 2 : area.x + area.width / 2;
  const cy = hasBounds ? bounds.y + bounds.height / 2 : area.y + area.height / 2;
  const left = area.x + width / 2;
  const right = area.x + area.width - width / 2;
  const petWidth = width || (hasBounds ? bounds.width : 0);
  if (walk.id === "reachClose") {
    // Toward the close-button corner (top right, top left on macOS), but
    // inset so the pet never parks over real window controls or a scrollbar.
    const insetX = REACH_CLOSE_INSET_X * width;
    const cx = platform === "darwin" ? left + insetX : right - insetX;
    return { cx, cy: area.y + REACH_CLOSE_INSET_Y * height + height / 2, side: null, petWidth };
  }
  if (walk.id === "wall") {
    const side = cx - area.x <= area.x + area.width - cx ? "left" : "right";
    return { cx: side === "left" ? left : right, cy, side, petWidth };
  }
  if (walk.id === "sitEdge") return { cx, cy: area.y + area.height - height / 2, side: null, petWidth };
  if (walk.id === "poke" && walk.target && isNum(walk.target.x) && isNum(walk.target.y)) {
    // Stop half a pet away from the cursor on the pet's side; the scene faces the cursor.
    const petOnLeft = cx < walk.target.x;
    return {
      cx: walk.target.x + (petOnLeft ? -width : width),
      cy: walk.target.y,
      side: petOnLeft ? "right" : "left",
      petWidth,
    };
  }
  return null;
}

// How far the pet (bounds) still is from where a walking mischief wants it:
// the relevant work-area edge or corner, or the goal next to the cursor (poke).
function walkEdgeDistance(walk, { area, bounds, goal, platform }) {
  const hasBounds = !!bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(isNum);
  if (!hasBounds || !area) return Infinity;
  const leftGap = bounds.x - area.x;
  const rightGap = area.x + area.width - (bounds.x + bounds.width);
  const topGap = bounds.y - area.y;
  const bottomGap = area.y + area.height - (bounds.y + bounds.height);
  let distance = Infinity;
  if (walk.spot && isNum(walk.spot.x) && isNum(walk.spot.y)) {
    // Art-anchored walk: how far the window is from the exact spot the art
    // needs (fingertip on the cursor, hands on the wall, ledge on the edge).
    distance = Math.hypot(bounds.x - walk.spot.x, bounds.y - walk.spot.y);
  }
  else if (walk.id === "reachClose") {
    // Distance to the inset spot next to the corner, not to the corner itself.
    const sideGap = platform === "darwin" ? leftGap : rightGap;
    distance = Math.max(
      Math.abs(topGap - REACH_CLOSE_INSET_Y * bounds.height),
      Math.abs(sideGap - REACH_CLOSE_INSET_X * bounds.width),
    );
  }
  else if (walk.id === "wall") distance = walk.side === "left" ? leftGap : rightGap;
  else if (walk.id === "sitEdge") distance = bottomGap;
  else if (walk.id === "poke" && goal && isNum(goal.x) && isNum(goal.y)) {
    distance = Math.hypot(bounds.x - goal.x, bounds.y - goal.y);
  }
  return Math.max(0, distance);
}

function createScenePlayer(deps) {
  const {
    play, // (kind, file, durationMs, scene) -> runtime play protocol
    getPlaying, // () -> current runtime attempt or null
    isOwned, // () -> our visual is still the one on screen
    canContinue, // () -> gate open and logical state idle
    stopPlayback, // (restore) -> runtime stop; restores only while owned
    clearPlayback, // () -> drop the current attempt and its timer, no restore
    restoreIdleVisual,
    now,
    onEnd, // (scene) -> called once when a scene ends on its own
  } = deps;

  function current() {
    const attempt = getPlaying();
    return attempt && attempt.kind === "scene" ? attempt.scene : null;
  }

  function playPart(scene) {
    const part = scene.parts[scene.index];
    if (scene.partStartedAt === null) scene.partStartedAt = now();
    let duration = part.duration;
    if (part.loop) {
      // The last loop iteration is cut so the part ends exactly at maxMs.
      duration = Math.max(1, Math.min(duration, part.maxMs - (now() - scene.partStartedAt)));
    }
    play("scene", part.file, duration, scene);
  }

  function start(scene) {
    scene.index = 0;
    scene.partStartedAt = null;
    playPart(scene);
  }

  // Called by the runtime after a part's timer fired (the attempt is already
  // dropped). `stillOurs` = state idle and our generation is current.
  function partFinished(scene, stillOurs) {
    if (!stillOurs) {
      onEnd(scene);
      return;
    }
    const part = scene.parts[scene.index];
    const looping = part.loop && now() - scene.partStartedAt < part.maxMs;
    if (!looping) {
      scene.index += 1;
      scene.partStartedAt = null;
    }
    if (scene.index < scene.parts.length && canContinue()) {
      playPart(scene); // takes the visual over directly, no restore in between
      return;
    }
    restoreIdleVisual();
    onEnd(scene);
  }

  // External event (cursor approach, hover move): switch the rest of the
  // scene to the event's parts. Returns true when the switch was played.
  function event(name) {
    const scene = current();
    if (!scene || scene.switched || !scene.on[name]) return false;
    if (!isOwned() || !canContinue()) {
      stopPlayback(true); // kills the scene, restores only if still ours
      return false;
    }
    scene.switched = true;
    scene.parts = scene.on[name];
    scene.index = 0;
    scene.partStartedAt = null;
    clearPlayback();
    playPart(scene);
    return true;
  }

  return { start, partFinished, event, current };
}

module.exports = {
  FAKE_NAP_MAX_MS,
  REACH_CLOSE_INSET_X,
  REACH_CLOSE_INSET_Y,
  SIT_EDGE_MAX_MS,
  SPOT_TOLERANCE_RATIO,
  partDurationMs,
  buildScene,
  createScenePlayer,
  mischiefAvailable,
  walkTarget,
  walkEdgeDistance,
};
