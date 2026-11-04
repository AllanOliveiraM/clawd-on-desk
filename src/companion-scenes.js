"use strict";

// src/companion-scenes.js — multi-part scene player for the Clawd Alive
// "mischief" layer.
//
// A scene is a list of parts { key, file, duration, loop?, maxMs? }. Every part
// (and every iteration of a looping part) is a fresh send through the
// runtime's own play() protocol: send -> committed settlement -> duration ->
// next part. Each send is a new visual generation, so a newer visual, a state
// change or a closed gate ends the whole scene, and idle is restored only while
// the scene still owns the screen. The player owns no timer: the runtime's
// per-playback timer drives the end of each part.

const SCENE_DEFAULT_DURATION_MS = 3500;
const SCENE_MIN_DURATION_MS = 1000;
const SCENE_MAX_DURATION_MS = 8000;
const FAKE_NAP_MAX_MS = 20000;
const SIT_EDGE_MAX_MS = 15000;

// Reactive scenes answer the user (interactions switch); the rest are the
// pet's own initiative (autonomy switch).
const REACTIVE_SCENES = new Set(["catch", "pounce"]);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function partDurationMs(anim) {
  const duration = anim && Number.isFinite(anim.duration) && anim.duration > 0
    ? anim.duration
    : SCENE_DEFAULT_DURATION_MS;
  return clamp(duration, SCENE_MIN_DURATION_MS, SCENE_MAX_DURATION_MS);
}

function sided(base, side) {
  return base + (side === "left" ? "Left" : "Right");
}

// Theme keys of each scene. `on` lists the parts an external event switches to.
function sceneSpec(id, opts, hasKey, random) {
  switch (id) {
    case "catch":
      return { parts: [{ key: "catch" }], on: { "hover-move": [{ key: "catchMiss" }] } };
    case "pounce":
      return { parts: [{ key: sided("pounce", opts.side) }] };
    case "poke":
      return { parts: [{ key: sided("poke", opts.side) }] };
    case "fakeNap":
      return { parts: [{ key: "fakeNap", loop: true, maxMs: FAKE_NAP_MAX_MS }], on: { boo: [{ key: "boo" }] } };
    case "sitEdge":
      return { parts: [{ key: "sitEdge", loop: true, maxMs: SIT_EDGE_MAX_MS }] };
    case "wall": {
      const open = [sided("wallPush", opts.side), sided("wallPeek", opts.side)].filter(hasKey);
      if (open.length === 0) return null;
      const index = clamp(Math.floor(random() * open.length), 0, open.length - 1);
      return { parts: [{ key: open[Number.isFinite(index) ? index : 0] }] };
    }
    case "dayRhythm":
    case "toy":
      return typeof opts.variant === "string" ? { parts: [{ key: opts.variant }] } : null;
    case "reachClose":
    case "welcome":
    case "stretchBack":
      return { parts: [{ key: id }] };
    default:
      return null;
  }
}

// Resolves every part to a file. Returns null when a main part has no art;
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
      if (!anim) return null;
      out.push({ ...part, file: anim.file, duration: partDurationMs(anim) });
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

// Center point a walking mischief heads to, on the pet's current work area,
// plus the scene side fixed for the arrival. null when it cannot be placed.
function walkTarget(walk, { area, bounds, size, platform }) {
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
  if (walk.id === "reachClose") {
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
  partDurationMs,
  buildScene,
  createScenePlayer,
  mischiefAvailable,
  walkTarget,
  walkEdgeDistance,
};
