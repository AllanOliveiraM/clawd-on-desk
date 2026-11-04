"use strict";

// src/companion-runtime.js — single arbiter for the opt-in "Clawd Alive" companion.
//
// Main-process logic with every dependency injected (no electron require), so it
// can be unit-tested with fakes. It owns mood bookkeeping, intent decisions,
// beat/petting playback and the in-memory roam visit grid. It never changes the
// logical state: beats are painted as "idle" visuals exactly like idle-activity.js.
//
// No polling: mood advances lazily on events/decisions, beats are driven by the
// existing tick, and the only timers are the per-playback duration timer and
// the petting inactivity timer.
//
// Mischief (opt-in, `mischief`): multi-part scenes played through the same
// playback protocol (src/companion-scenes.js), triggered by cursor samples the
// tick already reads, hover gestures, idle entries and roam arrivals. With
// mischief off every path below behaves exactly like plain Clawd Alive.

const {
  getTraits,
  normalizePersonality,
  createInitialState,
  sanitizeState,
  applyEvent,
  advance,
} = require("./companion-model");
const {
  ANIMATION_KEY_BY_INTENT,
  chooseIntent,
  cooldownFor,
  beatDelayMs,
  roamDelayMs,
} = require("./companion-intent");
const { createMischiefBrain, reactWeight } = require("./companion-mischief");
const {
  buildScene,
  createScenePlayer,
  partDurationMs,
  mischiefAvailable,
  walkTarget,
  walkEdgeDistance,
  SPOT_TOLERANCE_RATIO,
} = require("./companion-scenes");
const { createArt } = require("./companion-geometry");

const BEAT_DEFAULT_DURATION_MS = 3500;
const BEAT_MIN_DURATION_MS = 2000;
const BEAT_MAX_DURATION_MS = 8000;
const PETTING_DEFAULT_DURATION_MS = 2000;
const PETTING_INACTIVITY_MS = 3000;
const HOVER_COOLDOWN_MS = 60000;
const FORCED_BEAT_DELAY_MS = 1000;
const REST_ENERGY_THRESHOLD = 35;
const FORCED_TIRED_ENERGY_THRESHOLD = 50;
const SHY_FAMILIARITY_THRESHOLD = 20;
const EXPLORE_CHANCE_PER_CURIOSITY = 0.6;
const MAX_CONSECUTIVE_REST_HOLDS = 3;
const GRID_SIZE = 3;
const GRID_DECAY = 0.9;
const GESTURES = new Set(["pet-start", "pet-continue", "pet-end", "hover-dwell", "hover-move"]);
// Mischief tuning.
const MISCHIEF_LOW_ENERGY = 25; // jumpy/walking reactions stay off below this
const WALKING_MISCHIEF = new Set(["poke", "reachClose", "wall", "sitEdge"]);
const EDGE_WALKS = new Set(["reachClose", "wall", "sitEdge"]); // skip roam's margin band
const IDLE_QUEUE_MAX_WAIT_MS = 60000; // welcome / stretch wait this long for the gate
const PENDING_WALK_MAX_MS = 120000; // a walk the roam never asked for (or cut) is dropped
const LONG_WORK_MS = 600000;
const LONG_SLEEP_MS = 600000;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function validEdgeBounds(b) {
  return b && isNum(b.xMin) && isNum(b.xMax) && isNum(b.yMin) && isNum(b.yMax)
    && b.xMax >= b.xMin && b.yMax >= b.yMin ? b : null;
}

function pickFrom(list, random) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const index = Math.floor(random() * list.length);
  return list[clamp(Number.isFinite(index) ? index : 0, 0, list.length - 1)];
}

function createCompanionRuntime(options = {}) {
  const {
    getTheme = () => null,
    getCurrentState = () => "idle",
    canPlay = () => false,
    restoreIdleVisual = () => {},
    isVisualGenerationCurrent = () => false,
    sendToRenderer = () => null,
    getIdleMode = () => "none",
    isRoamAnimating = () => false,
    // True while another idle visual (idle-activity.js) is on screen; hover
    // greets wait for it, petting may still take over.
    isOtherIdleVisualPlaying = () => false,
    getDisplayWorkArea = null,
    // Mischief: platform for the "close button" corner, local hour for tests.
    getPlatform = () => process.platform,
    getHour = undefined,
    store = null,
    random = Math.random,
    now = Date.now,
    setTimeout: setTimer = setTimeout,
    clearTimeout: clearTimer = clearTimeout,
  } = options;

  const config = {
    enabled: false, personality: "balanced", autonomy: true, interactions: true, memory: true, mischief: false,
  };
  let traits = getTraits(config.personality);
  let state = createInitialState();
  let restSpot = null;
  let cooldownUntil = {};
  let nextBeatAt = null;
  let forcedIntent = null;
  let hoverReadyAt = 0;
  let playing = null; // { kind: "beat"|"hover"|"petting", file, duration, visualGeneration, committed }
  let playTimer = null;
  let petSession = false;
  let petTimer = null;
  let grids = new Map(); // displayId -> number[9] visit counts (memory only)
  let pendingWalkCell = null;
  let restHolds = 0; // consecutive rest-spot answers; the pet never parks forever
  let disposed = false;
  // Mischief bookkeeping (memory only).
  const brain = createMischiefBrain({ now, random, getHour });
  let napping = false; // last value given to brain.setNapping
  let pendingWalk = null; // { id, at, target? } chosen, waiting for the roam to ask
  let walkingMischief = null; // { id, at, side, petWidth, area, bounds, goal } proposed to the roam, waiting for arrival
  let idleQueue = null; // { id, at } welcome / stretchBack waiting for the gate
  // After an edge scene (reachClose, wall, sitEdge) the pet walks back into
  // the margin band soon: one short pause, then one normal roam target.
  let returnWalk = false;

  const memoryOn = () => config.enabled && config.memory;
  const autonomous = () => config.enabled && config.autonomy;
  const mischiefOn = () => config.enabled && config.mischief;

  function persist() {
    if (memoryOn() && store) store.schedule({ state, restSpot });
  }

  function setMood(next) {
    state = next;
    persist();
  }

  function advanceMood() {
    state = advance(state, now(), traits);
  }

  function companionAnimations(theme) {
    const anims = theme && theme.companionAnimations;
    return anims && typeof anims === "object" ? anims : {};
  }

  function animationFor(key, theme) {
    const entry = companionAnimations(theme)[key];
    if (!entry || !Array.isArray(entry.files) || entry.files.length === 0) return null;
    const file = pickFrom(entry.files, random);
    return file ? { file, duration: isNum(entry.duration) && entry.duration > 0 ? entry.duration : null } : null;
  }

  function availableKeys(theme) {
    const anims = companionAnimations(theme);
    return new Set(Object.keys(anims).filter((key) => animationFor(key, theme)));
  }

  function beatDuration(anim) {
    return clamp(anim.duration ?? BEAT_DEFAULT_DURATION_MS, BEAT_MIN_DURATION_MS, BEAT_MAX_DURATION_MS);
  }

  // ---- playback (mirrors idle-activity.js play/finish/abandon) ----

  function clearPlayTimer() {
    if (playTimer) {
      clearTimer(playTimer);
      playTimer = null;
    }
  }

  function scheduleBeat() {
    nextBeatAt = now() + beatDelayMs(traits, state.mood, random);
  }

  function isAnimating() {
    return playing !== null
      && (!playing.committed || isVisualGenerationCurrent(playing.visualGeneration));
  }

  // Drop the current playback. Restores idle only when our visual is still the
  // one on screen and the logical state is idle.
  function stopPlayback(restore) {
    if (playing && playing.kind === "scene") noteSceneEnded(playing.scene);
    const shouldRestore = restore && isAnimating() && getCurrentState() === "idle";
    const wasBeat = playing && (playing.kind === "beat" || playing.kind === "scene");
    clearPlayTimer();
    playing = null;
    if (shouldRestore) restoreIdleVisual();
    if (wasBeat && autonomous()) scheduleBeat();
  }

  // Any end of an edge scene (on its own or killed) queues the return walk.
  function noteSceneEnded(scene) {
    if (scene && EDGE_WALKS.has(scene.id) && mischiefOn() && autonomous()) returnWalk = true;
  }

  function abandon() {
    stopPlayback(false);
  }

  function finish(attempt) {
    clearPlayTimer();
    if (playing !== attempt) return;
    const stillOurs = getCurrentState() === "idle" && isVisualGenerationCurrent(attempt.visualGeneration);
    if (attempt.kind === "scene") {
      playing = null;
      scenes.partFinished(attempt.scene, stillOurs);
      return;
    }
    if (attempt.kind === "petting" && petSession) {
      // Loop the same file while the session lasts; a newer visual ends the
      // loop, and so does a closed gate (the session itself stays for mood).
      playing = null;
      if (!stillOurs) return;
      if (canPlay()) play("petting", attempt.file, attempt.duration);
      else restoreIdleVisual();
      return;
    }
    playing = null;
    if (stillOurs) restoreIdleVisual();
    if (attempt.kind === "beat" && autonomous()) scheduleBeat();
  }

  function play(kind, file, duration, scene = null) {
    const attempt = { kind, file, duration, visualGeneration: null, committed: false, scene };
    playing = attempt;
    const onLogicalSettlement = (settlement) => {
      if (playing !== attempt) return;
      if (
        !settlement
        || settlement.status !== "committed"
        || !Number.isSafeInteger(settlement.visualGeneration)
        || getCurrentState() !== "idle"
        || !isVisualGenerationCurrent(settlement.visualGeneration)
      ) {
        abandon();
        return;
      }
      // Timeout recovery can commit a newer generation than the original send.
      attempt.visualGeneration = settlement.visualGeneration;
      attempt.committed = true;
      clearPlayTimer();
      playTimer = setTimer(() => finish(attempt), attempt.duration);
    };
    const request = sendToRenderer("state-change", "idle", file, { onLogicalSettlement });
    if (playing !== attempt) return; // settled (and dropped) synchronously
    const visualGeneration = request && request.visualGeneration;
    if (!Number.isSafeInteger(visualGeneration)) {
      abandon();
      return;
    }
    if (!attempt.committed) attempt.visualGeneration = visualGeneration;
  }

  function visualGateOpen() {
    return !playing && getCurrentState() === "idle" && canPlay();
  }

  // ---- mischief scenes ----

  const scenes = createScenePlayer({
    play,
    getPlaying: () => playing,
    isOwned: () => isAnimating(),
    canContinue: () => canPlay() && getCurrentState() === "idle",
    stopPlayback,
    clearPlayback: () => {
      clearPlayTimer();
      playing = null;
    },
    restoreIdleVisual: () => restoreIdleVisual(),
    now,
    onEnd: (scene) => {
      noteSceneEnded(scene);
      if (autonomous()) scheduleBeat();
    },
  });

  // A scene never starts over another idle visual, a walk or a closed gate.
  function sceneGateOpen() {
    return visualGateOpen() && !isOtherIdleVisualPlaying() && !isRoamAnimating();
  }

  function startScene(id, opts) {
    if (!sceneGateOpen()) return false;
    const theme = getTheme();
    const scene = buildScene(id, opts, (key) => animationFor(key, theme), random);
    if (!scene) return false;
    const t = now();
    brain.markPlayed(id, t, traits);
    if (scene.requires === "autonomy") setMood(applyEvent(state, { kind: "beat" }, traits, t));
    scenes.start(scene);
    return true;
  }

  function sceneAllowed(scene) {
    if (!mischiefOn()) return false;
    return scene.requires === "interactions" ? config.interactions : config.autonomy;
  }

  // Personality chance, individual cooldown and energy for a cursor reaction.
  function acceptReaction(id, t) {
    if (!brain.canReact(id, t)) return false;
    advanceMood();
    if (state.mood.energy < MISCHIEF_LOW_ENERGY) return false;
    return random() < clamp(reactWeight(id, config.personality), 0, 1);
  }

  // A walking mischief that never reaches its scene still spends its cooldown,
  // so the pet does not keep picking (and walking toward) the same spot.
  function spendWalk(walk) {
    if (walk) brain.markPlayed(walk.id, now(), traits);
  }

  function clearMischiefWork() {
    pendingWalk = null;
    walkingMischief = null;
    idleQueue = null;
    returnWalk = false;
  }

  function syncNap() {
    const scene = scenes.current();
    const napNow = !!(scene && scene.id === "fakeNap" && !scene.switched && isAnimating());
    if (napNow !== napping) {
      napping = napNow;
      brain.setNapping(napNow);
    }
  }

  function tryBoo() {
    const scene = scenes.current();
    if (!scene || scene.id !== "fakeNap" || scene.switched) return;
    if (!(random() < clamp(reactWeight("boo", config.personality), 0, 1))) return;
    scenes.event("boo");
  }

  // Cursor reactions, the idle-entry queue and stale bookkeeping. Returns true
  // when this tick is spoken for (the beat path then waits).
  function mischiefTick(cursor) {
    const t = now();
    const scene = scenes.current();
    // A replaced visual or a non-idle state ends the scene right away.
    if (scene && (!isAnimating() || getCurrentState() !== "idle")) stopPlayback(true);
    if (!autonomous() || getIdleMode() !== "roam") {
      pendingWalk = null;
      walkingMischief = null;
      returnWalk = false;
    }
    if (pendingWalk && t - pendingWalk.at > PENDING_WALK_MAX_MS) {
      spendWalk(pendingWalk);
      pendingWalk = null;
    }
    if (walkingMischief && t - walkingMischief.at > PENDING_WALK_MAX_MS) {
      spendWalk(walkingMischief);
      walkingMischief = null;
    }
    if (idleQueue && t - idleQueue.at > IDLE_QUEUE_MAX_WAIT_MS) idleQueue = null;
    syncNap();
    const hit = brain.observeCursor(cursor);
    if (playing || petSession) {
      if (hit && hit.id === "boo") tryBoo();
      return true;
    }
    if (getCurrentState() !== "idle") return true;
    if (idleQueue && autonomous() && getIdleMode() !== "none" && startScene(idleQueue.id)) {
      idleQueue = null;
      return true;
    }
    if (!hit) return false;
    if (hit.id === "pounce" && config.interactions && !isRoamAnimating()
      && acceptReaction("pounce", t) && startScene("pounce", { side: hit.side })) {
      return true;
    }
    if (hit.id === "poke" && autonomous() && getIdleMode() === "roam" && !pendingWalk && !walkingMischief
      && brain.isGlobalReady(t) && acceptReaction("poke", t)) {
      const keys = availableKeys(getTheme());
      if (keys.has("pokeLeft") || keys.has("pokeRight")) pendingWalk = { id: "poke", at: t, target: hit.target };
    }
    return false;
  }

  // Autonomous mischief on a due beat. A walking one becomes a pending walk
  // that rides the next roam; the rest play right away as a scene.
  function tryAutonomousMischief(keys) {
    if (pendingWalk || walkingMischief) return false;
    const t = now();
    const pick = brain.pickAutonomous({
      traits, personality: config.personality, state, mode: "roam", available: mischiefAvailable(keys, false), now: t,
    });
    if (!pick) return false;
    if (WALKING_MISCHIEF.has(pick.id)) {
      pendingWalk = { id: pick.id, at: t };
      scheduleBeat();
      return true;
    }
    return startScene(pick.id, { variant: pick.variant });
  }

  // ---- beats and choosers ----

  function markIntentPlayed(intent) {
    cooldownUntil[intent] = now() + cooldownFor(intent, traits);
    setMood(applyEvent(state, { kind: "beat" }, traits, now()));
  }

  function tick(cursor) {
    if (disposed) return;
    if (mischiefOn() && mischiefTick(cursor)) return;
    if (!autonomous() || getIdleMode() !== "roam") return;
    if (playing || petSession || getCurrentState() !== "idle") return;
    // Arm the clock even while a gate is closed so the beat is ready when it opens.
    if (nextBeatAt == null) {
      scheduleBeat();
      return;
    }
    if (now() < nextBeatAt || isRoamAnimating() || !canPlay()) return;
    advanceMood();
    const theme = getTheme();
    const available = availableKeys(theme);
    if (!forcedIntent && mischiefOn() && tryAutonomousMischief(available)) return;
    const intent = forcedIntent
      || chooseIntent({ traits, state, mode: "roam", available, cooldownUntil, now: now(), random });
    forcedIntent = null;
    const key = ANIMATION_KEY_BY_INTENT[intent];
    const anim = key && available.has(key) ? animationFor(key, theme) : null;
    if (!anim) {
      scheduleBeat(); // observe (or missing art): just wait for the next beat
      return;
    }
    markIntentPlayed(intent);
    play("beat", anim.file, beatDuration(anim));
  }

  function chooseIdleActivity(args) {
    if (disposed) return null;
    // Never fight our own petting/hover visual or an ongoing petting session,
    // whatever the autonomy setting (disabled: nothing can be playing).
    if (playing || petSession) return { skip: true };
    if (!autonomous() || getIdleMode() !== "activities") return null;
    const theme = (args && args.theme) || getTheme();
    advanceMood();
    const available = availableKeys(theme);
    if (mischiefOn()) {
      // Single-part mischief only: idle-activity plays one file, no scenes.
      const t = now();
      const pick = brain.pickAutonomous({
        traits, personality: config.personality, state, mode: "activities", available: mischiefAvailable(available, true), now: t,
      });
      const anim = pick && pick.variant ? animationFor(pick.variant, theme) : null;
      if (anim) {
        brain.markPlayed(pick.id, t, traits);
        setMood(applyEvent(state, { kind: "beat" }, traits, t));
        return { file: anim.file, durationMs: partDurationMs(anim) };
      }
    }
    const intent = chooseIntent({ traits, state, mode: "activities", available, cooldownUntil, now: now(), random });
    if (intent === "themeActivity") return null;
    const key = ANIMATION_KEY_BY_INTENT[intent];
    const anim = key && available.has(key) ? animationFor(key, theme) : null;
    if (!anim) return { skip: true };
    markIntentPlayed(intent);
    return { file: anim.file, durationMs: beatDuration(anim) };
  }

  function getRoamDelayMs(isFirst, baseMs) {
    if (disposed || !autonomous()) return baseMs;
    // A pending mischief walk, or the walk back from an edge scene, asks for
    // the shortest pause roam allows.
    if (mischiefOn() && (pendingWalk || returnWalk)) return 0.5 * baseMs;
    advanceMood();
    return roamDelayMs(isFirst, baseMs, traits, state.mood);
  }

  // ---- roam targets (3x3 visit grid per display, memory only) ----

  function cellOf(area, cx, cy) {
    const col = clamp(Math.floor(((cx - area.x) / area.width) * GRID_SIZE), 0, GRID_SIZE - 1);
    const row = clamp(Math.floor(((cy - area.y) / area.height) * GRID_SIZE), 0, GRID_SIZE - 1);
    return row * GRID_SIZE + col;
  }

  function gridFor(displayId) {
    const id = displayId ?? null;
    if (!grids.has(id)) grids.set(id, new Array(GRID_SIZE * GRID_SIZE).fill(0));
    return grids.get(id);
  }

  function validArea(area) {
    return area && isNum(area.x) && isNum(area.y) && isNum(area.width) && isNum(area.height)
      && area.width > 0 && area.height > 0 ? area : null;
  }

  function pickRoamTarget(args) {
    if (disposed || !autonomous() || !args) return null;
    const { xMin, xMax, yMin, yMax, bounds, size, displayId } = args;
    if (![xMin, xMax, yMin, yMax].every(isNum)) return null;
    const area = validArea(args.workArea)
      || { x: xMin, y: yMin, width: Math.max(1, xMax - xMin), height: Math.max(1, yMax - yMin) };
    const halfW = size && isNum(size.width) ? size.width / 2 : 0;
    const halfH = size && isNum(size.height) ? size.height / 2 : 0;
    const toTarget = (cx, cy, preferred) => ({
      x: clamp(cx - halfW, xMin, Math.max(xMin, xMax)),
      y: clamp(cy - halfH, yMin, Math.max(yMin, yMax)),
      preferred,
    });

    // Every walk decays the grid and records where the pet starts from.
    const grid = gridFor(displayId);
    for (let i = 0; i < grid.length; i += 1) grid[i] *= GRID_DECAY;
    if (bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(isNum)) {
      grid[cellOf(area, bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)] += 1;
    }
    pendingWalkCell = null;
    // A new walk supersedes an older one that never reported its arrival.
    spendWalk(walkingMischief);
    walkingMischief = null;

    if (returnWalk) {
      // Leave the edge: roam picks its own target inside the margin band.
      returnWalk = false;
      if (mischiefOn()) return null;
    }

    if (mischiefOn() && pendingWalk) {
      const walk = pendingWalk;
      pendingWalk = null;
      const artSize = size && isNum(size.width) && isNum(size.height)
        ? size
        : (bounds && isNum(bounds.width) && isNum(bounds.height) ? { width: bounds.width, height: bounds.height } : null);
      const art = createArt(getTheme(), artSize);
      const spot = walkTarget(walk, { area, bounds, size, platform: getPlatform(), art, random });
      if (spot && spot.spot) {
        // Art-anchored (Ruling P4): walk the window to the exact spot; past the
        // work area only by the art's overhang and never with a fence.
        const edge = validEdgeBounds(args.edgeBounds);
        const overhang = args.fence ? null : spot.overhang;
        const ov = (k) => (overhang && isNum(overhang[k]) ? overhang[k] : 0);
        const box = edge
          ? { xMin: edge.xMin - ov("left"), xMax: edge.xMax + ov("right"), yMin: edge.yMin - ov("top"), yMax: edge.yMax + ov("bottom") }
          : { xMin, xMax: Math.max(xMin, xMax), yMin, yMax: Math.max(yMin, yMax) };
        const target = {
          x: clamp(spot.spot.x, box.xMin, box.xMax),
          y: clamp(spot.spot.y, box.yMin, box.yMax),
          preferred: true,
          mischief: walk.id,
          spot: { ...spot.spot },
        };
        if (overhang && (ov("left") || ov("right") || ov("top") || ov("bottom"))) target.overhang = { ...overhang };
        if (spot.side && walk.id === "wall") target.side = spot.side;
        walkingMischief = {
          id: walk.id,
          at: now(),
          side: spot.side,
          variant: spot.variant || null,
          spot: { ...spot.spot },
          petWidth: spot.petWidth,
          area,
          bounds,
          goal: { x: target.x, y: target.y },
        };
        return target;
      }
      if (spot) {
        // Edge/corner kinds may leave the margin band: roam's edgeBounds is the
        // work area (whole window) narrowed by an active fence.
        const edge = EDGE_WALKS.has(walk.id) ? validEdgeBounds(args.edgeBounds) : null;
        const target = edge
          ? {
            x: clamp(spot.cx - halfW, edge.xMin, edge.xMax),
            y: clamp(spot.cy - halfH, edge.yMin, edge.yMax),
            preferred: true,
            mischief: walk.id,
          }
          : { ...toTarget(spot.cx, spot.cy, true), mischief: walk.id };
        // The wall scene animates this side; roam measures the gap on it too.
        if (spot.side && walk.id === "wall") target.side = spot.side;
        walkingMischief = {
          id: walk.id, at: now(), side: spot.side, petWidth: spot.petWidth, area, bounds, goal: { x: target.x, y: target.y },
        };
        return target;
      }
      spendWalk(walk);
    }

    advanceMood();
    if (state.mood.energy < REST_ENERGY_THRESHOLD && restSpot) {
      if (restHolds >= MAX_CONSECUTIVE_REST_HOLDS) {
        // Stretch the legs: one normal walk, then the rest spot may win again.
        restHolds = 0;
        return null;
      }
      restHolds += 1;
      const restArea = (typeof getDisplayWorkArea === "function" && validArea(getDisplayWorkArea(restSpot.displayId)))
        || area;
      return toTarget(restArea.x + restSpot.x * restArea.width, restArea.y + restSpot.y * restArea.height, true);
    }
    restHolds = 0;
    if (random() < traits.curiosity * EXPLORE_CHANCE_PER_CURIOSITY) {
      const min = Math.min(...grid);
      const candidates = [];
      grid.forEach((count, i) => { if (count === min) candidates.push(i); });
      const cell = pickFrom(candidates, random);
      const col = cell % GRID_SIZE;
      const row = Math.floor(cell / GRID_SIZE);
      pendingWalkCell = { grid, cell };
      return toTarget(
        area.x + ((col + 0.5) * area.width) / GRID_SIZE,
        area.y + ((row + 0.5) * area.height) / GRID_SIZE,
        false,
      );
    }
    return null;
  }

  // An art-anchored walk must end with its anchor on the spot; the older
  // whole-window walks only need to be within a pet width of their edge.
  function arrivalTolerance(walk) {
    return walk.spot ? SPOT_TOLERANCE_RATIO * walk.petWidth : walk.petWidth;
  }

  // Roam did not use the proposed target (too close, or holding): the explore
  // cell must not be credited on the next arrival. A mischief walk discarded
  // because the pet is already there plays its scene in place; otherwise it
  // spends its cooldown.
  function onPreferredTargetDiscarded() {
    if (disposed) return;
    pendingWalkCell = null;
    const walk = walkingMischief;
    walkingMischief = null;
    spendWalk(pendingWalk);
    pendingWalk = null;
    if (!walk) return;
    const distance = walkEdgeDistance(walk, { area: walk.area, bounds: walk.bounds, goal: walk.goal, platform: getPlatform() });
    const played = mischiefOn() && autonomous() && getIdleMode() === "roam" && distance <= arrivalTolerance(walk)
      && startScene(walk.id, { side: walk.side, variant: walk.variant });
    if (!played) spendWalk(walk);
  }

  // A real (non-walk) idle entry: the next beat waits a fresh delay. With
  // mischief, a return from a long sleep or a long work stretch queues a short
  // welcome / stretch that waits (on tick) for the gate to open.
  function noteIdleEntered(info) {
    if (disposed || !autonomous()) return;
    scheduleBeat();
    if (!mischiefOn() || !info) return;
    // Only a long sleep celebrates: DND and short dozes also pass the sleep flow.
    if (info.from === "sleep") {
      if (isNum(info.awayMs) && info.awayMs >= LONG_SLEEP_MS) idleQueue = { id: "welcome", at: now() };
    }
    else if (info.from === "work" && isNum(info.awayMs) && info.awayMs >= LONG_WORK_MS) {
      idleQueue = { id: "stretchBack", at: now() };
    }
  }

  function noteWalkFinished(info) {
    if (disposed || !config.enabled) return;
    if (pendingWalkCell) {
      pendingWalkCell.grid[pendingWalkCell.cell] += 1;
      pendingWalkCell = null;
    }
    setMood(applyEvent(state, { kind: "walk" }, traits, now()));
    let played = false;
    if (mischiefOn() && walkingMischief && info && info.mischief === walkingMischief.id) {
      const walk = walkingMischief;
      walkingMischief = null;
      // Fence or clamp may stop the pet short of the edge: then skip the scene.
      const reached = info.reachedEdgeDistancePx;
      const close = walk.spot
        ? isNum(reached) && reached <= arrivalTolerance(walk)
        : walk.id === "poke" || (isNum(reached) && reached <= walk.petWidth);
      if (close && autonomous() && getIdleMode() === "roam") {
        played = startScene(walk.id, { side: walk.side, variant: walk.variant });
      }
      // Spend the cooldown anyway so a fenced pet does not keep walking there.
      if (!played) brain.markPlayed(walk.id, now(), traits);
    }
    if (!played && info && info.preferred && autonomous() && state.mood.energy < FORCED_TIRED_ENERGY_THRESHOLD) {
      nextBeatAt = now() + FORCED_BEAT_DELAY_MS;
      forcedIntent = "tired";
    }
  }

  // ---- events and gestures ----

  function noteEvent(kind) {
    if (disposed || !config.enabled) return;
    setMood(applyEvent(state, { kind }, traits, now()));
  }

  function noteDragEnd(spot) {
    if (disposed || !config.enabled || !spot) return;
    if (!isNum(spot.x) || !isNum(spot.y)) return;
    const displayId = isNum(spot.displayId) ? spot.displayId : null;
    restSpot = { displayId, x: clamp(spot.x, 0, 1), y: clamp(spot.y, 0, 1) };
    persist();
  }

  function clearPetTimer() {
    if (petTimer) {
      clearTimer(petTimer);
      petTimer = null;
    }
  }

  function endPetSession() {
    clearPetTimer();
    if (!petSession) return;
    petSession = false;
    if (playing && playing.kind === "petting") stopPlayback(true);
  }

  function armPetTimer() {
    clearPetTimer();
    petTimer = setTimer(() => {
      petTimer = null;
      endPetSession();
    }, PETTING_INACTIVITY_MS);
  }

  function startPetVisual() {
    if (!canPlay() || getCurrentState() !== "idle") return;
    if (playing && playing.kind === "petting") return;
    const theme = getTheme();
    const shyAnswer = config.personality === "shy" && state.mood.familiarity < SHY_FAMILIARITY_THRESHOLD
      ? animationFor("shy", theme)
      : null;
    const anim = shyAnswer || animationFor("petting", theme);
    if (!anim) return;
    // Petting takes the visual right away, so a beat/hover needs no restore.
    if (playing) stopPlayback(false);
    play("petting", anim.file, anim.duration ?? PETTING_DEFAULT_DURATION_MS);
  }

  // Hover answer facing the cursor: with the cursor on the pet's left half a
  // greet waves left (greetLeft) and shy looks away to the right (shyRight);
  // either falls back to the original art.
  function hoverAnimation(key, info) {
    const theme = getTheme();
    const sideKey = info && info.side === "left"
      ? (key === "greet" ? "greetLeft" : "shyRight")
      : null;
    return (sideKey && animationFor(sideKey, theme)) || animationFor(key, theme);
  }

  function handleHover(info) {
    if (now() < hoverReadyAt || !visualGateOpen() || isOtherIdleVisualPlaying()) return;
    const key = traits.sociability >= 0.6 ? "greet" : (traits.sociability < 0.3 ? "shy" : null);
    const anim = key && hoverAnimation(key, info);
    if (!anim) return;
    hoverReadyAt = now() + HOVER_COOLDOWN_MS;
    cooldownUntil[key] = Math.max(cooldownUntil[key] || 0, now() + cooldownFor(key, traits));
    setMood(applyEvent(state, { kind: "hoverGreet" }, traits, now()));
    play("hover", anim.file, beatDuration(anim));
  }

  // Mischief answer to a hover dwell; shy pets keep today's shy answer.
  function tryCatch(info) {
    if (traits.sociability < 0.3) return false;
    const t = now();
    // Intentionally ignores hoverReadyAt: catch has its own 90 s cooldown.
    const bucket = info && typeof info.bucket === "string" ? info.bucket : null;
    if (!brain.canReact("catch", t) || !startScene("catch", { bucket })) return false;
    hoverReadyAt = t + HOVER_COOLDOWN_MS; // no greet right after a catch
    setMood(applyEvent(state, { kind: "hoverGreet" }, traits, t));
    return true;
  }

  // info (hover-dwell only, optional): { bucket, side } from main, the cursor
  // in viewBox units of the resting pose (companion-geometry.hoverInfoFromPointer).
  function handleGesture(kind, info) {
    if (disposed || !config.enabled || !config.interactions || !GESTURES.has(kind)) return;
    if (kind === "hover-move") {
      // Cursor moved or left during a catch: it turns into the miss.
      if (mischiefOn()) scenes.event("hover-move");
      return;
    }
    if (kind === "hover-dwell") {
      if (!(mischiefOn() && tryCatch(info))) handleHover(info);
      return;
    }
    if (kind === "pet-end") {
      endPetSession();
      return;
    }
    noteEvent("pet");
    armPetTimer();
    if (!petSession) {
      petSession = true;
      startPetVisual();
    }
  }

  // ---- lifecycle ----

  function cancel() {
    if (disposed) return;
    clearPetTimer();
    petSession = false;
    clearPlayTimer();
    playing = null;
    nextBeatAt = null;
    forcedIntent = null;
    clearMischiefWork();
  }

  function stopEverything() {
    clearPetTimer();
    petSession = false;
    stopPlayback(true);
    nextBeatAt = null;
    forcedIntent = null;
    clearMischiefWork();
  }

  function configure(next = {}) {
    if (disposed) return;
    const prev = { ...config };
    if (typeof next.enabled === "boolean") config.enabled = next.enabled;
    if (next.personality !== undefined) config.personality = normalizePersonality(next.personality);
    for (const key of ["autonomy", "interactions", "memory", "mischief"]) {
      if (typeof next[key] === "boolean") config[key] = next[key];
    }
    traits = getTraits(config.personality);

    if (!config.enabled) {
      if (prev.enabled) {
        stopEverything();
        if (prev.memory && store) store.flush();
      }
      return;
    }
    if (!prev.enabled) {
      if (config.memory && store) {
        const loaded = store.load() || {};
        state = loaded.state ? sanitizeState(loaded.state, now()) : state;
        restSpot = loaded.restSpot || null;
      }
      advanceMood();
      nextBeatAt = null;
    }
    if (!config.memory && (!prev.enabled || prev.memory) && store) store.remove();
    if (config.memory && prev.enabled && !prev.memory) persist();
    if (!config.autonomy && playing && playing.kind === "beat") stopPlayback(true);
    if (!config.autonomy) {
      nextBeatAt = null;
      forcedIntent = null;
    }
    if (!config.interactions) endPetSession();
    const scene = scenes.current();
    if (scene && !sceneAllowed(scene)) stopPlayback(true);
    if (!config.mischief || !config.autonomy) clearMischiefWork();
  }

  function reset() {
    if (disposed) return;
    stopEverything();
    state = advance(createInitialState(), now(), traits);
    restSpot = null;
    cooldownUntil = {};
    hoverReadyAt = 0;
    grids = new Map();
    pendingWalkCell = null;
    restHolds = 0;
    brain.reset();
    napping = false;
    if (store) store.remove();
  }

  function dispose() {
    if (disposed) return;
    clearPetTimer();
    clearPlayTimer();
    petSession = false;
    playing = null;
    clearMischiefWork();
    disposed = true;
    if (memoryOn() && store) store.flush();
  }

  return {
    configure,
    tick,
    chooseIdleActivity,
    getRoamDelayMs,
    pickRoamTarget,
    noteEvent,
    handleGesture,
    noteDragEnd,
    noteWalkFinished,
    onPreferredTargetDiscarded,
    noteIdleEntered,
    isAnimating: () => !disposed && isAnimating(),
    cancel,
    reset,
    dispose,
    getMood: () => ({ ...state.mood }),
    getRestSpot: () => (restSpot ? { ...restSpot } : null),
  };
}

module.exports = { createCompanionRuntime };
