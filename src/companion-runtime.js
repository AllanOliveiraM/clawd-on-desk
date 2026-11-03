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
const GRID_SIZE = 3;
const GRID_DECAY = 0.9;
const GESTURES = new Set(["pet-start", "pet-continue", "pet-end", "hover-dwell"]);

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

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
    getDisplayWorkArea = null,
    store = null,
    random = Math.random,
    now = Date.now,
    setTimeout: setTimer = setTimeout,
    clearTimeout: clearTimer = clearTimeout,
  } = options;

  const config = { enabled: false, personality: "balanced", autonomy: true, interactions: true, memory: true };
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
  let disposed = false;

  const memoryOn = () => config.enabled && config.memory;
  const autonomous = () => config.enabled && config.autonomy;

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
    const shouldRestore = restore && isAnimating() && getCurrentState() === "idle";
    const wasBeat = playing && playing.kind === "beat";
    clearPlayTimer();
    playing = null;
    if (shouldRestore) restoreIdleVisual();
    if (wasBeat && autonomous()) scheduleBeat();
  }

  function abandon() {
    stopPlayback(false);
  }

  function finish(attempt) {
    clearPlayTimer();
    if (playing !== attempt) return;
    const stillOurs = getCurrentState() === "idle" && isVisualGenerationCurrent(attempt.visualGeneration);
    if (attempt.kind === "petting" && petSession) {
      // Loop the same file while the session lasts; a newer visual ends the loop.
      playing = null;
      if (stillOurs) play("petting", attempt.file, attempt.duration);
      return;
    }
    playing = null;
    if (stillOurs) restoreIdleVisual();
    if (attempt.kind === "beat" && autonomous()) scheduleBeat();
  }

  function play(kind, file, duration) {
    const attempt = { kind, file, duration, visualGeneration: null, committed: false };
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

  // ---- beats and choosers ----

  function markIntentPlayed(intent) {
    cooldownUntil[intent] = now() + cooldownFor(intent, traits);
    setMood(applyEvent(state, { kind: "beat" }, traits, now()));
  }

  function tick() {
    if (disposed || !autonomous() || getIdleMode() !== "roam") return;
    if (playing || getCurrentState() !== "idle") return;
    // Arm the clock even while a gate is closed so the beat is ready when it opens.
    if (nextBeatAt == null) {
      scheduleBeat();
      return;
    }
    if (isRoamAnimating() || !canPlay() || now() < nextBeatAt) return;
    advanceMood();
    const theme = getTheme();
    const available = availableKeys(theme);
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
    if (disposed || !autonomous() || getIdleMode() !== "activities") return null;
    if (playing) return { skip: true }; // never fight our own petting/hover visual
    const theme = (args && args.theme) || getTheme();
    advanceMood();
    const available = availableKeys(theme);
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

    advanceMood();
    if (state.mood.energy < REST_ENERGY_THRESHOLD && restSpot) {
      const restArea = (typeof getDisplayWorkArea === "function" && validArea(getDisplayWorkArea(restSpot.displayId)))
        || area;
      return toTarget(restArea.x + restSpot.x * restArea.width, restArea.y + restSpot.y * restArea.height, true);
    }
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

  function noteWalkFinished(info) {
    if (disposed || !config.enabled) return;
    if (pendingWalkCell) {
      pendingWalkCell.grid[pendingWalkCell.cell] += 1;
      pendingWalkCell = null;
    }
    setMood(applyEvent(state, { kind: "walk" }, traits, now()));
    if (info && info.preferred && autonomous() && state.mood.energy < FORCED_TIRED_ENERGY_THRESHOLD) {
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

  function handleHover() {
    if (now() < hoverReadyAt || !visualGateOpen()) return;
    const key = traits.sociability >= 0.6 ? "greet" : (traits.sociability < 0.3 ? "shy" : null);
    const anim = key && animationFor(key, getTheme());
    if (!anim) return;
    hoverReadyAt = now() + HOVER_COOLDOWN_MS;
    cooldownUntil[key] = Math.max(cooldownUntil[key] || 0, now() + cooldownFor(key, traits));
    setMood(applyEvent(state, { kind: "hoverGreet" }, traits, now()));
    play("hover", anim.file, beatDuration(anim));
  }

  function handleGesture(kind) {
    if (disposed || !config.enabled || !config.interactions || !GESTURES.has(kind)) return;
    if (kind === "hover-dwell") {
      handleHover();
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
  }

  function stopEverything() {
    clearPetTimer();
    petSession = false;
    stopPlayback(true);
    nextBeatAt = null;
    forcedIntent = null;
  }

  function configure(next = {}) {
    if (disposed) return;
    const prev = { ...config };
    if (typeof next.enabled === "boolean") config.enabled = next.enabled;
    if (next.personality !== undefined) config.personality = normalizePersonality(next.personality);
    for (const key of ["autonomy", "interactions", "memory"]) {
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
    if (store) store.remove();
  }

  function dispose() {
    if (disposed) return;
    clearPetTimer();
    clearPlayTimer();
    petSession = false;
    playing = null;
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
    isAnimating: () => !disposed && isAnimating(),
    cancel,
    reset,
    dispose,
    getMood: () => ({ ...state.mood }),
    getRestSpot: () => (restSpot ? { ...restSpot } : null),
  };
}

module.exports = { createCompanionRuntime };
