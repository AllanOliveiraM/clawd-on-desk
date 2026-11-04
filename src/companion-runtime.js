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
const {
  createMischiefBrain, reactWeight, CURSOR_UNSEEN_MS, XWAYLAND_CURSOR_UNSEEN_MS,
} = require("./companion-mischief");
const {
  buildScene,
  createScenePlayer,
  partDurationMs,
  mischiefAvailable,
  walkTarget,
  walkEdgeDistance,
  sided,
  FETCH_OBJECTS,
  fetchObjectKeys,
  SPOT_TOLERANCE_RATIO,
  SPOT_REACH_TOLERANCE_RATIO,
} = require("./companion-scenes");
const { createArt, POUNCE_STRIKE_TIP, POUNCE_SHORT_TIP } = require("./companion-geometry");

// The cursor counts as at the strike's arm height within this fraction of H.
const POUNCE_TIP_TOLERANCE_RATIO = 0.15;

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
const WALKING_MISCHIEF = new Set(["poke", "reachClose", "wall", "sitEdge", "fetch"]);
const EDGE_WALKS = new Set(["reachClose", "wall", "sitEdge", "fetch"]); // skip roam's margin band
// Sides the scene animates, so roam measures the arrival gap on that side.
const SIDED_WALKS = new Set(["wall", "fetch"]);
const IDLE_QUEUE_MAX_WAIT_MS = 60000; // welcome / stretch wait this long for the gate
const PENDING_WALK_MAX_MS = 120000; // a walk the roam never asked for (or cut) is dropped
const LONG_WORK_MS = 600000;
// After any companion visual ends roam waits this long before a new walk.
const ROAM_BREATHER_MS = 1500;
// Walk variant chances per walk (Ruling P6).
const WALK_TIRED_CHANCE = 0.6; // energy below REST_ENERGY_THRESHOLD
const WALK_BOUNCY_PLAYFUL_CHANCE = 0.4;
const WALK_BOUNCY_CONTENT_CHANCE = 0.25; // other personalities, contentment above the threshold
const WALK_BOUNCY_CONTENT_THRESHOLD = 75;
const WALK_CURIOUS_CHANCE = 0.35;
// Dreamy sleep: chance per real sleep that it twitches its legs (owner decision).
const SLEEP_TWITCH_CHANCE = 0.35;
const WORK_VARIANT_CHANCE = 0.35;
const LONG_SLEEP_MS = 600000;
const ART_CACHE_MAX = 8; // (theme, window size) helpers kept for the geometry
// Test mode (spec 2026-11-04 §2): what the "Test animations" menu lists.
// Fixed English labels (developer tool). Single-key ids play one theme key
// (the variant) once; the rest are scenes, walks or previews.
const SLEEP_FLOW_STATES = new Set(["yawning", "dozing", "collapsing", "sleeping", "waking"]);
const DEBUG_SINGLE = {
  mood: [
    ["content", "Content"], ["tired", "Tired"], ["grumpy", "Grumpy"], ["curious", "Curious"],
    ["shy", "Shy"], ["shyRight", "Shy (looks right)"], ["greet", "Greet"], ["greetLeft", "Greet (left)"],
    ["petting", "Petting"],
  ],
  catch: [
    ["catch", "Catch"], ["catchHigh", "Catch: high"], ["catchBody", "Catch: body"], ["catchLow", "Catch: low"],
    ["catchLeft", "Catch: left"], ["catchRight", "Catch: right"],
    ["catchMiss", "Catch miss"], ["catchMissHigh", "Catch miss: high"], ["catchMissBody", "Catch miss: body"],
    ["catchMissLow", "Catch miss: low"], ["catchMissLeft", "Catch miss: left"], ["catchMissRight", "Catch miss: right"],
  ],
  pounce: [
    ["pounceLeft", "Pounce (left)"], ["pounceRight", "Pounce (right)"],
    ["pounceStrikeLeft", "Pounce strike (left)"], ["pounceStrikeRight", "Pounce strike (right)"],
  ],
  boo: [["boo", "Boo!"]],
  dayRhythm: [["morningStretch", "Morning stretch"], ["coffee", "Coffee"], ["nightSleepy", "Sleepy night"]],
  toy: [["toyBall", "Toy: ball"], ["toyYoyo", "Toy: yo-yo"], ["toyPlane", "Toy: paper plane"]],
  welcome: [["welcome", "Welcome back"]],
  stretchBack: [["stretchBack", "Stretch after work"]],
  searchMouse: [["searchMouse", "Searching for the mouse"]],
  sleep: [["sleepTwitch", "Dreamy sleep"], ["collapseSleepTwitch", "Dreamy collapse sleep"]],
  transition: [
    ["sitDown", "Sit down"], ["standUp", "Stand up"], ["fakeNapIn", "Fake nap: lie down"],
    ["fakeNapOut", "Fake nap: get up"], ["pettingIn", "Petting: ease in"], ["pettingOut", "Petting: ease out"],
  ],
};
const DEBUG_GROUP = {
  mood: "Moods", catch: "Catch", pounce: "Mischief", boo: "Mischief", dayRhythm: "Mischief", toy: "Mischief",
  welcome: "Mischief", stretchBack: "Mischief", searchMouse: "Mischief", sleep: "Sleep", transition: "Transitions",
};
const DEBUG_ONCE = new Set(["transition"]);
const DEBUG_WALKS = [["walkBouncy", "Bouncy walk"], ["walkTired", "Tired walk"], ["walkCurious", "Curious walk"]];
const DEBUG_WALL = [
  ["wallPushLeft", "Wall push (left)"], ["wallPushRight", "Wall push (right)"],
  ["wallPeekLeft", "Wall peek (left)"], ["wallPeekRight", "Wall peek (right)"],
];
const DEBUG_GROUP_ORDER = ["Moods", "Catch", "Mischief", "Walks", "Sleep", "Work", "Transitions"];

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
    // Test mode: why the pet cannot play right now ("dnd", "mini", ...) or
    // null; without it a closed canPlay() reads as "agent-busy".
    getDebugBlockReason = null,
    // Test mode: stop a walk in progress / re-arm roam's pause so a pending
    // test walk starts at roam's shortest pause.
    interruptRoam = () => {},
    // XWayland session (Ruling N1): searchMouse after 30 s, not 10 min.
    xwayland = false,
    store = null,
    random = Math.random,
    now: rawNow = Date.now,
    setTimeout: setTimer = setTimeout,
    clearTimeout: clearTimer = clearTimeout,
  } = options;

  // Every clock read goes through here: when the clock goes backwards (NTP,
  // manual change) every stored deadline and stamp that is now ahead of the
  // clock is pulled back to it, so nothing stays "in the future" for the
  // length of the jump (Rulings R2/R3). A forward jump changes nothing.
  let lastNow = null;
  function now() {
    const t = rawNow();
    if (isNum(t)) {
      if (lastNow !== null && t < lastNow) rebaseClock(t, lastNow);
      lastNow = t;
    }
    return t;
  }
  function rebaseClock(t, was) {
    // Past stamps cannot be ahead of the clock: cap them. Deadlines keep the
    // time that was left at the last read (Ruling R2').
    const cap = (v) => (isNum(v) && v > t ? t : v);
    const deadline = (v) => (isNum(v) && v > t ? Math.min(v, t + Math.max(0, v - was)) : v);
    breatherUntil = deadline(breatherUntil);
    nextBeatAt = deadline(nextBeatAt);
    lastTrustedCursorAt = cap(lastTrustedCursorAt);
    hoverReadyAt = deadline(hoverReadyAt);
    for (const key of Object.keys(cooldownUntil)) cooldownUntil[key] = deadline(cooldownUntil[key]);
    const running = scenes.current();
    if (running && isNum(running.partStartedAt)) running.partStartedAt = cap(running.partStartedAt);
    if (idleQueue) idleQueue.at = cap(idleQueue.at);
    if (pendingWalk) pendingWalk.at = cap(pendingWalk.at);
    if (walkingMischief) walkingMischief.at = cap(walkingMischief.at);
    state = {
      ...state,
      lastAdvanceAt: cap(state.lastAdvanceAt),
      lastInteractionAt: cap(state.lastInteractionAt),
      streak: state.streak ? { ...state.streak, at: cap(state.streak.at) } : state.streak,
    };
  }

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
  let breatherUntil = 0; // roam holds until then after a visual / petting ended
  // Art geometry helpers per (theme id, W, H); each one measures a file once.
  const artCache = new Map();
  // XWayland cursor trust (searchMouse): when the latest trusted cursor
  // sample was seen (null until the first tick), and its position (poke
  // target for a test-mode poke).
  let lastTrustedCursorAt = null;
  let lastCursorPoint = null;
  // Test mode: a walk variant file for the next walk.
  let debugWalkFile = null;
  let debugVisualWalk = false; // the walk in progress carries a test-mode variant

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

  // Cached companion-geometry helper: the layout math runs once per theme
  // object, window size and file instead of on every cursor sample.
  function artFor(theme, size) {
    const W = size && isNum(size.width) ? size.width : 0;
    const H = size && isNum(size.height) ? size.height : 0;
    if (!theme || typeof theme !== "object") return createArt(theme, size);
    const id = typeof theme._id === "string" ? theme._id : "";
    const key = `${id}|${theme._variantId || ""}|${W}|${H}`;
    const hit = artCache.get(key);
    if (hit && hit.theme === theme) return hit.art;
    if (artCache.size >= ART_CACHE_MAX) artCache.clear();
    const art = createArt(theme, size);
    artCache.set(key, { theme, art });
    return art;
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
  function startBreather() {
    breatherUntil = now() + ROAM_BREATHER_MS;
  }

  function stopPlayback(restore) {
    if (playing) startBreather();
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
    if (!scene || !EDGE_WALKS.has(scene.id)) return;
    if (mischiefOn() && autonomous()) returnWalk = true;
    // A test edge scene walks back even with mischief / autonomy off.
    else if (scene.debug && config.enabled) returnWalk = "debug";
  }

  function abandon() {
    stopPlayback(false);
  }

  function finish(attempt) {
    clearPlayTimer();
    if (playing !== attempt) return;
    startBreather(); // a next part / petting loop replays right away anyway
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
      const loop = attempt.loop || { file: attempt.file, duration: attempt.duration };
      if (canPlay()) play("petting", loop.file, loop.duration, null, { phase: "loop", loop, outro: attempt.outro });
      else restoreIdleVisual();
      return;
    }
    playing = null;
    if (stillOurs) restoreIdleVisual();
    if (attempt.kind === "beat" && autonomous()) scheduleBeat();
  }

  function play(kind, file, duration, scene = null, extra = null) {
    const attempt = { ...extra, kind, file, duration, visualGeneration: null, committed: false, scene };
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
    // A test scene keeps playing under the test gate (no doze guard / menu).
    canContinue: (scene) => getCurrentState() === "idle"
      && (scene && scene.debug ? config.enabled && !debugBlockReason() : canPlay()),
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
    if (scene.debug) return config.enabled;
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
    if (walk && !walk.debug) brain.markPlayed(walk.id, now(), traits);
  }

  function clearMischiefWork() {
    pendingWalk = null;
    walkingMischief = null;
    idleQueue = null;
    returnWalk = false;
  }

  // The pet counts as napping from lying down until it starts getting up.
  function napScene() {
    const scene = scenes.current();
    const part = scene && scene.parts[scene.index];
    return scene && scene.id === "fakeNap" && !scene.switched && part && part.key !== "fakeNapOut" ? scene : null;
  }

  function syncNap() {
    const napNow = !!(napScene() && isAnimating());
    if (napNow !== napping) {
      napping = napNow;
      brain.setNapping(napNow);
    }
  }

  function tryBoo() {
    if (!napScene()) return;
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
      // A test-mode walk only needs Free Roam.
      const roam = getIdleMode() === "roam";
      if (!(roam && pendingWalk && pendingWalk.debug)) pendingWalk = null;
      if (!(roam && walkingMischief && walkingMischief.debug)) walkingMischief = null;
      // The walk back from a test edge scene also only needs Free Roam.
      if (!(roam && returnWalk === "debug")) returnWalk = false;
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
    const hit = brain.observeCursor(withPounceZone(cursor));
    if (playing || petSession) {
      if (hit && hit.id === "boo") tryBoo();
      return true;
    }
    if (getCurrentState() !== "idle") return true;
    if (idleQueue && autonomous() && getIdleMode() !== "none") {
      const gateOpen = sceneGateOpen();
      if (startScene(idleQueue.id)) {
        idleQueue = null;
        return true;
      }
      // An open gate that still builds no scene means the art is gone (theme
      // switch): nothing to wait for, so roam is not held for a minute.
      if (gateOpen) idleQueue = null;
    }
    // searchMouse does not wait for a beat: under XWayland it must come
    // before the 60 s doze (Ruling N1). Own cooldown only (Ruling N3).
    if (autonomous() && getIdleMode() !== "none" && searchMouseDue(t) && startScene("searchMouse")) return true;
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

  // Strike reach (Ruling P1) from the window bounds of the sample: the
  // visible hand-tip lines of the pounce strike art and its arm height, so
  // only a cursor the strike can actually reach triggers it. Without bounds
  // or placeable art the brain keeps its band around the pet.
  function withPounceZone(cursor) {
    const b = cursor && cursor.petBounds;
    if (!b || ![b.x, b.y, b.width, b.height].every(isNum)) return cursor;
    const art = artFor(getTheme(), { width: b.width, height: b.height });
    // The strike's hand tip, or the short pounce's paw when only that art exists.
    const tipOf = (side) => {
      const strike = sided("pounceStrike", side);
      const key = art.has(strike) ? strike : sided("pounce", side);
      const tip = key === strike ? POUNCE_STRIKE_TIP : POUNCE_SHORT_TIP;
      return art.point(key, side === "left" ? tip.u : art.mirrorU(key, tip.u), tip.v);
    };
    const left = tipOf("left");
    const right = tipOf("right");
    if (!left || !right) return cursor;
    return {
      ...cursor,
      pounceZone: {
        leftX: b.x + left.x,
        rightX: b.x + right.x,
        tipY: b.y + (left.y + right.y) / 2,
        tolY: POUNCE_TIP_TOLERANCE_RATIO * b.height,
      },
    };
  }

  // Autonomous mischief on a due beat. A walking one becomes a pending walk
  // that rides the next roam; the rest play right away as a scene.
  function tryAutonomousMischief(keys) {
    if (pendingWalk || walkingMischief) return false;
    const t = now();
    const pick = brain.pickAutonomous({
      traits, personality: config.personality, state, mode: "roam", available: mischiefAvailable(keys, false), now: t,
      cursorUnseenMs: cursorUnseenMs(t), cursorUnseenMinMs: cursorUnseenMinMs(),
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

  function searchMouseDue(t) {
    return cursorUnseenMs(t) >= cursorUnseenMinMs() && brain.canReact("searchMouse", t)
      && hasArt(getTheme(), "searchMouse");
  }

  function cursorUnseenMinMs() {
    return xwayland === true ? XWAYLAND_CURSOR_UNSEEN_MS : CURSOR_UNSEEN_MS;
  }

  function cursorUnseenMs(t) {
    return lastTrustedCursorAt === null ? 0 : Math.max(0, t - lastTrustedCursorAt);
  }

  // info.cursorTrusted === false: this tick's cursor read is not trusted
  // (XWayland outside the app's windows; the sample is then null). Callers
  // without the info count as trusted, so searchMouse never plays there.
  function noteCursorTrust(cursor, info) {
    const t = now();
    const trusted = !(info && info.cursorTrusted === false);
    if (trusted || lastTrustedCursorAt === null) lastTrustedCursorAt = t;
    if (trusted && cursor && isNum(cursor.x) && isNum(cursor.y)) lastCursorPoint = { x: cursor.x, y: cursor.y };
  }

  // Test walks with mischief off (mischiefTick does this when it is on):
  // dropped off Free Roam, expired like any pending walk.
  function tidyDebugWalks() {
    const t = now();
    const drop = (walk) => walk && walk.debug && (getIdleMode() !== "roam" || t - walk.at > PENDING_WALK_MAX_MS);
    if (drop(pendingWalk)) pendingWalk = null;
    if (drop(walkingMischief)) walkingMischief = null;
    if (returnWalk === "debug" && getIdleMode() !== "roam") returnWalk = false;
  }

  function tick(cursor, info) {
    if (disposed) return;
    if (debugWalkFile && getIdleMode() !== "roam") debugWalkFile = null;
    noteCursorTrust(cursor, info);
    if (!mischiefOn()) tidyDebugWalks();
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
        cursorUnseenMs: cursorUnseenMs(t), cursorUnseenMinMs: cursorUnseenMinMs(),
      });
      const singleKey = pick && (pick.variant || (pick.id === "searchMouse" ? "searchMouse" : null));
      const anim = singleKey ? animationFor(singleKey, theme) : null;
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
    // A test-mode walk asks for roam's shortest pause, even without autonomy.
    if (!disposed && config.enabled && ((pendingWalk && pendingWalk.debug) || debugWalkFile)) return 0;
    if (!disposed && config.enabled && returnWalk === "debug") return 0.5 * baseMs;
    if (disposed || !autonomous()) return baseMs;
    // A pending mischief walk, or the walk back from an edge scene, asks for
    // the shortest pause roam allows.
    if (mischiefOn() && (pendingWalk || returnWalk)) return 0.5 * baseMs;
    advanceMood();
    return roamDelayMs(isFirst, baseMs, traits, state.mood);
  }

  // ---- roam walk variants (Rulings P5/P6) ----

  // Asked by roam once per walk, just before it shows its walk visual: a
  // companion walk file that replaces the theme's roam visual for this walk,
  // or null for the original. Rolls only when the variant's art exists, so a
  // theme without it (or the feature off) behaves exactly as before.
  function pickWalkVisual() {
    if (disposed || !config.enabled) return null;
    // Asked once per walk: only the walk that consumes a test-mode file is a
    // test walk (noteWalkFinished then skips mood, store and explore credit).
    debugVisualWalk = false;
    if (debugWalkFile) {
      const file = debugWalkFile;
      debugWalkFile = null;
      debugVisualWalk = true;
      return file;
    }
    const theme = getTheme();
    const roll = (key, chance) => {
      const entry = companionAnimations(theme)[key];
      if (!(chance > 0) || !entry || !Array.isArray(entry.files) || entry.files.length === 0) return null;
      if (!(random() < chance)) return null;
      const anim = animationFor(key, theme);
      return anim ? anim.file : null;
    };
    advanceMood();
    if (state.mood.energy < REST_ENERGY_THRESHOLD) return roll("walkTired", WALK_TIRED_CHANCE);
    const bouncy = config.personality === "playful"
      ? WALK_BOUNCY_PLAYFUL_CHANCE
      : (state.mood.contentment > WALK_BOUNCY_CONTENT_THRESHOLD ? WALK_BOUNCY_CONTENT_CHANCE : 0);
    const bounce = roll("walkBouncy", bouncy);
    if (bounce) return bounce;
    return config.personality === "curious" ? roll("walkCurious", WALK_CURIOUS_CHANCE) : null;
  }

  // ---- dreamy sleep ----

  // Asked by the state machine once per entry into the real "collapsing" or
  // "sleeping" state (not DND, not mini): a companion file that replaces the
  // theme's visual for that whole phase, or null for the original. The logical
  // state never changes. One chance roll per sleep episode: a collapse that
  // rolled keeps its hit or miss for the sleep that follows it (fromCollapse).
  // Rolls only when the art exists and the feature is on.
  let collapseTwitchHit = null; // null = no collapse roll pending
  function hasSleepArt(theme, key) {
    const entry = companionAnimations(theme)[key];
    return Boolean(entry && Array.isArray(entry.files) && entry.files.length > 0);
  }
  function sleepFile(theme, key) {
    const anim = animationFor(key, theme);
    return anim ? anim.file : null;
  }
  function pickSleepVisual(state = "sleeping", options = {}) {
    const pending = collapseTwitchHit;
    collapseTwitchHit = null;
    if (disposed || !config.enabled) return null;
    const theme = getTheme();
    if (state === "collapsing") {
      if (!hasSleepArt(theme, "collapseSleepTwitch")) return null;
      collapseTwitchHit = random() < SLEEP_TWITCH_CHANCE;
      return collapseTwitchHit ? sleepFile(theme, "collapseSleepTwitch") : null;
    }
    if (state !== "sleeping") return null;
    const decided = options && options.fromCollapse === true ? pending : null;
    if (!hasSleepArt(theme, "sleepTwitch")) return null;
    const hit = decided === null ? random() < SLEEP_TWITCH_CHANCE : decided;
    return hit ? sleepFile(theme, "sleepTwitch") : null;
  }

  // ---- work escalation ladder ----

  // Asked by the state machine whenever it resolves the working / juggling
  // tier visual (not DND, previews, mini, display hints or explicit files): a
  // file from theme.companionWorkTiers for the current count, or null for the
  // theme's own tier file. A tier with variants shows one ~35% of the time.
  // Each tier's choice holds for the state's whole episode (ended by the state
  // machine when the pet really leaves working / juggling), so repeated
  // working events and count oscillation never flicker between files.
  const workPicks = new Map(); // "working" | "juggling" -> { episode, byTier: Map(tier -> file) }
  function workTierFor(theme, group, count) {
    const block = theme && theme.companionWorkTiers;
    const tiers = block && typeof block === "object" && Array.isArray(block[group]) ? block[group] : [];
    let best = null;
    for (const tier of tiers) {
      if (!tier || typeof tier !== "object" || !isNum(tier.minSessions) || tier.minSessions > count) continue;
      if (!best || tier.minSessions > best.minSessions) best = tier;
    }
    return best;
  }
  function pickWorkVisual(state, info) {
    if (disposed || !config.enabled) {
      workPicks.clear();
      return null;
    }
    if ((state !== "working" && state !== "juggling") || !info || typeof info !== "object") return null;
    const count = state === "working" ? info.sessions : info.subagents;
    if (!isNum(count)) return null;
    const tier = workTierFor(getTheme(), state, count);
    if (!tier) return null;
    let held = workPicks.get(state);
    if (!held || held.episode !== info.episode) {
      held = { episode: info.episode, byTier: new Map() };
      workPicks.set(state, held);
    }
    const files = Array.isArray(tier.files) ? tier.files.filter((f) => typeof f === "string" && f) : [];
    const variants = Array.isArray(tier.variants) ? tier.variants.filter((f) => typeof f === "string" && f) : [];
    // Keyed by what the tier says, not by object identity: a theme reload
    // builds new, equal objects and must not re-roll the episode.
    const signature = JSON.stringify([tier.minSessions, files, variants]);
    if (held.byTier.has(signature)) return held.byTier.get(signature);
    const pickOne = (list) => (list.length === 1 ? list[0] : pickFrom(list, random));
    let file = null;
    if (variants.length > 0 && random() < WORK_VARIANT_CHANCE) file = pickOne(variants);
    else if (files.length > 0) file = pickOne(files);
    held.byTier.set(signature, file);
    return file;
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

  function sameRect(a, b) {
    return !!(a && b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);
  }

  function pickRoamTarget(args) {
    if (disposed || !args) return null;
    const debugWalk = !!(config.enabled && pendingWalk && pendingWalk.debug);
    if (!autonomous() && !debugWalk) {
      // The walk back from a test edge scene: roam's own band target.
      if (returnWalk === "debug") returnWalk = false;
      return null;
    }
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
      const wasDebug = returnWalk === "debug";
      returnWalk = false;
      if ((mischiefOn() || wasDebug) && !debugWalk) return null;
    }

    if ((mischiefOn() || debugWalk) && pendingWalk) {
      const walk = pendingWalk;
      pendingWalk = null;
      const artSize = size && isNum(size.width) && isNum(size.height)
        ? size
        : (bounds && isNum(bounds.width) && isNum(bounds.height) ? { width: bounds.width, height: bounds.height } : null);
      const art = artFor(getTheme(), artSize);
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
        if (spot.side && SIDED_WALKS.has(walk.id)) target.side = spot.side;
        walkingMischief = {
          id: walk.id,
          at: now(),
          debug: !!walk.debug,
          side: spot.side,
          variant: spot.variant || walk.variant || null,
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
        // The wall / fetch scene animates this side; roam measures the gap on it too.
        if (spot.side && SIDED_WALKS.has(walk.id)) target.side = spot.side;
        walkingMischief = {
          id: walk.id, at: now(), side: spot.side, petWidth: spot.petWidth, area, bounds, goal: { x: target.x, y: target.y },
        };
        if (walk.debug) walkingMischief.debug = true;
        if (spot.variant || walk.variant) walkingMischief.variant = spot.variant || walk.variant;
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
      const otherArea = restSpot.displayId != null && typeof getDisplayWorkArea === "function"
        ? validArea(getDisplayWorkArea(restSpot.displayId)) : null;
      // An unknown pet display is not "every display": only a rest spot whose
      // work area is exactly the pet's own counts as the same monitor.
      const sameDisplay = restSpot.displayId == null
        || (displayId != null ? restSpot.displayId === displayId : sameRect(otherArea, validArea(args.workArea)));
      // A rest spot on another monitor the pet cannot reach from here would
      // clamp to the wrong edge every time: no preferred target (Ruling R11).
      if (!sameDisplay && !otherArea) return null;
      const restArea = otherArea || area;
      const rx = restArea.x + restSpot.x * restArea.width;
      const ry = restArea.y + restSpot.y * restArea.height;
      if (!sameDisplay && (rx < area.x || rx > area.x + area.width || ry < area.y || ry > area.y + area.height)) return null;
      restHolds += 1;
      return toTarget(rx, ry, true);
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

  // A discarded walk cannot get any closer: an art-anchored one still plays
  // in place within the art's reach of its spot.
  function discardTolerance(walk) {
    return walk.spot ? SPOT_REACH_TOLERANCE_RATIO * walk.petWidth : walk.petWidth;
  }

  // Roam did not use the proposed target (too close, or holding): the explore
  // cell must not be credited on the next arrival. A mischief walk discarded
  // because the pet is already (close enough to) there plays its scene in
  // place; otherwise it spends its cooldown.
  function onPreferredTargetDiscarded() {
    if (disposed) return;
    pendingWalkCell = null;
    const walk = walkingMischief;
    walkingMischief = null;
    spendWalk(pendingWalk);
    pendingWalk = null;
    if (!walk) return;
    if (walk.debug) {
      // Test mode: already there (or as close as roam gets), play in place.
      if (getIdleMode() === "roam") startDebugScene(walk.id, { side: walk.side, variant: walk.variant });
      return;
    }
    const distance = walkEdgeDistance(walk, { area: walk.area, bounds: walk.bounds, goal: walk.goal, platform: getPlatform() });
    const played = mischiefOn() && autonomous() && getIdleMode() === "roam" && distance <= discardTolerance(walk)
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
    let id = null;
    // Only a long sleep celebrates: DND and short dozes also pass the sleep flow.
    if (info.from === "sleep") {
      if (isNum(info.awayMs) && info.awayMs >= LONG_SLEEP_MS) id = "welcome";
    }
    else if (info.from === "work" && isNum(info.awayMs) && info.awayMs >= LONG_WORK_MS) {
      id = "stretchBack";
    }
    // Without its art, or with idle animations off, the scene can never play:
    // queueing it would only hold roam for IDLE_QUEUE_MAX_WAIT_MS.
    if (id && hasArt(getTheme(), id) && getIdleMode() !== "none") idleQueue = { id, at: now() };
  }

  function noteWalkFinished(info) {
    if (disposed || !config.enabled) return;
    if (debugVisualWalk) {
      // Test mode walk variant: no mood event, no persist, no explore credit.
      debugVisualWalk = false;
      pendingWalkCell = null;
      return;
    }
    if (pendingWalkCell) {
      pendingWalkCell.grid[pendingWalkCell.cell] += 1;
      pendingWalkCell = null;
    }
    if (walkingMischief && walkingMischief.debug && info && info.mischief === walkingMischief.id) {
      // Test mode: the scene plays wherever the walk ended; no mood, no cooldown.
      const walk = walkingMischief;
      walkingMischief = null;
      if (getIdleMode() === "roam") startDebugScene(walk.id, { side: walk.side, variant: walk.variant });
      return;
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

  // The session's end eases out (pettingOut) while our petting visual still
  // owns the screen and the gate is open; otherwise idle comes back directly.
  function endPetSession() {
    clearPetTimer();
    if (!petSession) return;
    petSession = false;
    startBreather();
    if (!playing || playing.kind !== "petting" || playing.phase === "out") return;
    const outro = playing.outro ? animationFor("pettingOut", getTheme()) : null;
    if (outro && isAnimating() && canPlay() && getCurrentState() === "idle") {
      clearPlayTimer();
      playing = null;
      play("petting", outro.file, partDurationMs(outro, true), null, { phase: "out" });
      return;
    }
    stopPlayback(true);
  }

  function armPetTimer() {
    clearPetTimer();
    petTimer = setTimer(() => {
      petTimer = null;
      endPetSession();
    }, PETTING_INACTIVITY_MS);
  }

  // Petting eases in (pettingIn, one-shot) then loops the petting file; the
  // shy answer plays alone. A stroke during the outro starts over.
  function startPetVisual() {
    if (!canPlay() || getCurrentState() !== "idle") return;
    if (playing && playing.kind === "petting" && playing.phase !== "out") return;
    const theme = getTheme();
    const shyAnswer = config.personality === "shy" && state.mood.familiarity < SHY_FAMILIARITY_THRESHOLD
      ? animationFor("shy", theme)
      : null;
    const anim = shyAnswer || animationFor("petting", theme);
    if (!anim) return;
    const loop = { file: anim.file, duration: anim.duration ?? PETTING_DEFAULT_DURATION_MS };
    const intro = shyAnswer ? null : animationFor("pettingIn", theme);
    const outro = !shyAnswer;
    // Petting takes the visual right away, so a beat/hover needs no restore.
    if (playing) stopPlayback(false);
    if (intro) play("petting", intro.file, partDurationMs(intro, true), null, { phase: "in", loop, outro });
    else play("petting", loop.file, loop.duration, null, { phase: "loop", loop, outro });
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
    petSession = true;
    // Also on a later stroke: a session that began behind a closed gate (e.g.
    // mid-walk) shows its visual once the gate opens. No-op while it shows.
    startPetVisual();
  }

  // Roam's isCompanionPlaying gate: true from the send of any companion
  // visual (committed or not), across scene parts and event switches, during
  // a petting session even without a visual, while a welcome / stretch waits
  // for the gate, and for ROAM_BREATHER_MS after any of these ended. Pure
  // check of in-memory state (no timer); always false with the feature off.
  function holdsRoam() {
    if (disposed || !config.enabled) return false;
    if (isAnimating() || petSession) return true;
    const t = now();
    if (idleQueue && mischiefOn() && t - idleQueue.at <= IDLE_QUEUE_MAX_WAIT_MS) return true;
    return t < breatherUntil;
  }

  // ---- test mode (spec 2026-11-04 §2) ----
  // Plays any companion visual now through the same playback protocol and
  // visual generations, ignoring cooldowns, chances and personality. Never
  // touches mood, persistence or the brain's cooldowns. Walking scenes ride
  // the next roam walk at roam's shortest pause.

  // Art presence without drawing a file (the catalog consumes no randomness).
  function hasArt(theme, key) {
    const entry = companionAnimations(theme)[key];
    return Boolean(entry && Array.isArray(entry.files) && entry.files.some((f) => typeof f === "string" && f));
  }

  function workFiles(theme) {
    const block = theme && theme.companionWorkTiers;
    const out = [];
    const seen = new Set();
    for (const group of ["working", "juggling"]) {
      const tiers = block && typeof block === "object" && Array.isArray(block[group]) ? block[group] : [];
      const sorted = tiers.filter((tier) => tier && typeof tier === "object" && isNum(tier.minSessions))
        .slice().sort((a, b) => a.minSessions - b.minSessions);
      for (const tier of sorted) {
        const unit = group === "working" ? "sessions" : "subagents";
        const lists = [[tier.files, ""], [tier.variants, " variant"]];
        for (const [list, kind] of lists) {
          for (const file of Array.isArray(list) ? list : []) {
            if (typeof file !== "string" || !file || seen.has(file)) continue;
            seen.add(file);
            out.push({ file, label: `${group === "working" ? "Working" : "Juggling"} ${tier.minSessions}+ ${unit}${kind}: ${file}` });
          }
        }
      }
    }
    return out;
  }

  function debugCatalog() {
    if (disposed || !config.enabled) return [];
    const theme = getTheme();
    const has = (key) => hasArt(theme, key);
    const rows = [];
    const add = (group, id, label, variant, walking) => {
      const row = { group, id, label };
      if (variant) row.variant = variant;
      if (walking) row.walking = true;
      rows.push(row);
    };
    for (const id of ["mood", "catch", "pounce"]) {
      for (const [key, label] of DEBUG_SINGLE[id]) if (has(key)) add(DEBUG_GROUP[id], id, label, key);
    }
    if (has("fakeNap")) add("Mischief", "fakeNap", "Fake nap");
    if (has("boo")) add("Mischief", "boo", "Boo!", "boo");
    if (has("pokeLeft") || has("pokeRight")) add("Mischief", "poke", "Poke (walks to the cursor)", null, true);
    if (has("reachClose")) add("Mischief", "reachClose", "Reach for the close button", null, true);
    for (const [key, label] of DEBUG_WALL) if (has(key)) add("Mischief", "wall", label, key, true);
    if (has("sitEdge")) add("Mischief", "sitEdge", "Sit on the edge", null, true);
    for (const side of ["left", "right"]) {
      if (!has(sided("fetchExit", side))) continue;
      for (const key of fetchObjectKeys(side, has)) {
        const object = FETCH_OBJECTS.find((obj) => key === sided(`fetch${obj}`, side));
        add("Mischief", "fetch", `Fetch: ${object.toLowerCase()} (${side})`, key, true);
      }
    }
    for (const id of ["dayRhythm", "toy", "welcome", "stretchBack", "searchMouse"]) {
      for (const [key, label] of DEBUG_SINGLE[id]) if (has(key)) add("Mischief", id, label, key);
    }
    for (const [key, label] of DEBUG_WALKS) if (has(key)) add("Walks", "walk", label, key, true);
    for (const [key, label] of DEBUG_SINGLE.sleep) if (has(key)) add("Sleep", "sleep", label, key);
    for (const { file, label } of workFiles(theme)) add("Work", "work", label, file);
    for (const [key, label] of DEBUG_SINGLE.transition) if (has(key)) add("Transitions", "transition", label, key);
    return DEBUG_GROUP_ORDER.flatMap((group) => rows.filter((row) => row.group === group));
  }

  // Why the pet cannot play a test visual now, or null.
  function debugBlockReason() {
    const reason = typeof getDebugBlockReason === "function" ? getDebugBlockReason() : (canPlay() ? null : "agent-busy");
    if (reason) return reason;
    const current = getCurrentState();
    if (SLEEP_FLOW_STATES.has(current)) return "sleeping";
    if (current !== "idle" && current !== "roam") return "agent-busy";
    return null;
  }

  // The plan of a test id: { scene } (plays now), { walk } (rides the next
  // roam walk), { walkFile } (walk variant) or null when the art is missing.
  function debugPlan(id, opts) {
    const theme = getTheme();
    const has = (key) => hasArt(theme, key);
    const resolve = (key) => animationFor(key, theme);
    const variant = typeof opts.variant === "string" ? opts.variant : null;
    const sideOf = (key) => (key && key.endsWith("Left") ? "left" : (key && key.endsWith("Right") ? "right" : null));
    const side = opts.side === "left" || opts.side === "right" ? opts.side : sideOf(variant);
    if (Object.prototype.hasOwnProperty.call(DEBUG_SINGLE, id)) {
      const list = DEBUG_SINGLE[id];
      const key = variant || (list.length === 1 ? list[0][0] : null);
      if (!key || !list.some(([k]) => k === key) || !has(key)) return null;
      const scene = buildScene("single", { key, once: DEBUG_ONCE.has(id) }, resolve, random);
      return scene ? { scene } : null;
    }
    switch (id) {
      case "fakeNap": {
        const scene = buildScene("fakeNap", {}, resolve, random);
        return scene ? { scene } : null;
      }
      case "work": {
        if (!variant || !workFiles(theme).some((entry) => entry.file === variant)) return null;
        const scene = buildScene("single", { key: "work" }, (key) => (key === "work" ? { file: variant, duration: null } : null), random);
        return scene ? { scene } : null;
      }
      case "walk":
        return variant && DEBUG_WALKS.some(([k]) => k === variant) && has(variant) ? { walkFile: resolve(variant).file } : null;
      case "poke": {
        if (!has("pokeLeft") && !has("pokeRight")) return null;
        if (lastCursorPoint) return { walk: { id: "poke", target: { ...lastCursorPoint } } };
        // No trusted cursor seen yet: poke in place.
        const key = has("pokeRight") ? "pokeRight" : "pokeLeft";
        const scene = buildScene("single", { key }, resolve, random);
        return scene ? { scene, inPlace: true } : null;
      }
      case "reachClose":
        return has("reachClose") ? { walk: { id } } : null;
      case "sitEdge":
        return has("sitEdge") ? { walk: { id } } : null;
      case "wall":
        if (variant && !DEBUG_WALL.some(([k]) => k === variant)) return null;
        if (variant ? !has(variant) : !DEBUG_WALL.some(([k]) => has(k))) return null;
        return { walk: { id, side, variant } };
      case "fetch": {
        if (!side || !has(sided("fetchExit", side))) return null;
        const objects = fetchObjectKeys(side, has);
        if (objects.length === 0 || (variant && !objects.includes(variant))) return null;
        return { walk: { id, side, variant } };
      }
      default:
        return null;
    }
  }

  // Drop whatever companion visual or petting session is on screen; the
  // caller's send takes the visual over (restore only when nothing follows).
  function debugTakeOver(restore) {
    clearPetTimer();
    petSession = false;
    if (playing) stopPlayback(restore);
  }

  function startDebugScene(id, opts) {
    if (disposed || !config.enabled || playing || debugBlockReason()) return false;
    if (getCurrentState() !== "idle") return false;
    const scene = buildScene(id, opts, (key) => animationFor(key, getTheme()), random);
    if (!scene) return false;
    scene.debug = true;
    scenes.start(scene);
    return true;
  }

  function debugPlay(id, opts) {
    const fail = (reason) => ({ ok: false, reason });
    if (disposed || !config.enabled) return fail("disabled");
    const plan = typeof id === "string" ? debugPlan(id, opts && typeof opts === "object" ? opts : {}) : null;
    if (!plan) return fail("missing-art");
    const blocked = debugBlockReason();
    if (blocked) return fail(blocked);
    if (plan.walk || plan.walkFile) {
      if (getIdleMode() !== "roam") return fail("no-roam");
      debugTakeOver(true);
      if (plan.walk) {
        pendingWalk = { ...plan.walk, at: now(), debug: true };
        walkingMischief = null;
        returnWalk = false;
      } else {
        debugWalkFile = plan.walkFile;
      }
      interruptRoam();
      return { ok: true };
    }
    if (isRoamAnimating()) interruptRoam();
    if (getCurrentState() !== "idle") return fail("agent-busy");
    debugTakeOver(false);
    plan.scene.debug = true;
    scenes.start(plan.scene);
    return { ok: true };
  }

  function getMoodSnapshot() {
    const current = advance(state, now(), traits);
    return {
      mood: { ...current.mood },
      label: current.label,
      personality: config.personality,
      lastInteractionAt: isNum(current.lastInteractionAt) ? current.lastInteractionAt : null,
    };
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
    debugWalkFile = null;
    debugVisualWalk = false;
    collapseTwitchHit = null;
    workPicks.clear();
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
    pickWalkVisual,
    pickSleepVisual,
    pickWorkVisual,
    noteEvent,
    handleGesture,
    noteDragEnd,
    noteWalkFinished,
    onPreferredTargetDiscarded,
    noteIdleEntered,
    isAnimating: () => !disposed && isAnimating(),
    holdsRoam,
    cancel,
    reset,
    dispose,
    getMood: () => ({ ...state.mood }),
    getMoodSnapshot,
    debugCatalog,
    debugPlay,
    getRestSpot: () => (restSpot ? { ...restSpot } : null),
  };
}

module.exports = { createCompanionRuntime };
