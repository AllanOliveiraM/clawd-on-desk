"use strict";

// Pure personality and mood model for the opt-in "Clawd Alive" companion.
// No I/O, no timers: every function takes `now` explicitly and returns new objects.

const PERSONALITY_IDS = ["balanced", "playful", "curious", "calm", "shy"];

const PERSONALITY_TRAITS = Object.freeze({
  balanced: Object.freeze({ activity: 0.5, curiosity: 0.5, sociability: 0.5, sensitivity: 0.5, calm: 0.5 }),
  playful: Object.freeze({ activity: 0.8, curiosity: 0.5, sociability: 0.8, sensitivity: 0.8, calm: 0.2 }),
  curious: Object.freeze({ activity: 0.65, curiosity: 0.9, sociability: 0.5, sensitivity: 0.5, calm: 0.5 }),
  calm: Object.freeze({ activity: 0.25, curiosity: 0.35, sociability: 0.5, sensitivity: 0.25, calm: 0.85 }),
  shy: Object.freeze({ activity: 0.4, curiosity: 0.5, sociability: 0.15, sensitivity: 0.8, calm: 0.5 }),
});

const DEFAULT_MOOD = Object.freeze({ energy: 70, contentment: 55, familiarity: 0 });
const EVENT_KINDS = ["pet", "click", "clickBurst", "drag", "dragLong", "walk", "beat", "hoverGreet"];
const LABELS = ["tired", "grumpy", "content", "neutral"];

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const MAX_ELAPSED_MS = 7 * 24 * HOUR_MS;
const REST_MIN_GAP_MS = 10 * MINUTE_MS;
const STREAK_WINDOW_MS = 30 * 1000;
const MIN_STREAK_FACTOR = 0.15;
// Awake recovery toward the 70 baseline. advance() runs every few seconds while
// the pet roams, so this (not the >=10 min rest branch) is what offsets walking.
const AWAKE_ENERGY_RECOVERY_PER_HOUR = 40;
const INTERACTION_KINDS = new Set(["pet", "click", "hoverGreet"]);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const clamp100 = (v) => clamp(v, 0, 100);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

function normalizePersonality(id) {
  return PERSONALITY_IDS.includes(id) ? id : "balanced";
}

function getTraits(id) {
  return { ...PERSONALITY_TRAITS[normalizePersonality(id)] };
}

function createInitialState() {
  return {
    mood: { ...DEFAULT_MOOD },
    label: "neutral",
    streak: null,
    lastAdvanceAt: null,
    lastInteractionAt: null,
  };
}

function sanitizeValue(v, fallback) {
  return isNum(v) ? clamp100(v) : fallback;
}

function sanitizeState(raw, now) {
  const base = createInitialState();
  if (!raw || typeof raw !== "object") return base;
  const mood = raw.mood && typeof raw.mood === "object" ? raw.mood : {};
  const out = {
    mood: {
      energy: sanitizeValue(mood.energy, DEFAULT_MOOD.energy),
      contentment: sanitizeValue(mood.contentment, DEFAULT_MOOD.contentment),
      familiarity: sanitizeValue(mood.familiarity, DEFAULT_MOOD.familiarity),
    },
    label: LABELS.includes(raw.label) ? raw.label : "neutral",
    streak: null,
    lastAdvanceAt: null,
    lastInteractionAt: null,
  };
  const s = raw.streak;
  if (s && typeof s === "object" && typeof s.kind === "string" && isNum(s.count) && s.count >= 1 && isNum(s.at)) {
    out.streak = { kind: s.kind, count: Math.floor(s.count), at: s.at };
  }
  // Timestamps from the future are clamped to `now` so a bad clock cannot freeze recovery.
  const cap = (t) => (isNum(t) ? (isNum(now) ? Math.min(t, now) : t) : null);
  out.lastAdvanceAt = cap(raw.lastAdvanceAt);
  out.lastInteractionAt = cap(raw.lastInteractionAt);
  return out;
}

function moodLabel(mood, previousLabel) {
  const { energy, contentment } = mood;
  if (energy < 25 || (previousLabel === "tired" && energy <= 35)) return "tired";
  if (contentment < 25 || (previousLabel === "grumpy" && contentment <= 35)) return "grumpy";
  if (contentment > 75 || (previousLabel === "content" && contentment >= 65)) return "content";
  return "neutral";
}

// Move `value` toward `target` by `amount` without passing it.
function approach(value, target, amount) {
  if (value < target) return Math.min(target, value + amount);
  if (value > target) return Math.max(target, value - amount);
  return value;
}

function advance(state, now, traits) {
  if (!isNum(now)) return state;
  if (!isNum(state.lastAdvanceAt)) return { ...state, mood: { ...state.mood }, lastAdvanceAt: now };
  const elapsed = clamp(now - state.lastAdvanceAt, 0, MAX_ELAPSED_MS);
  if (elapsed === 0) {
    // Negative or zero time: leave mood alone; never move the clock backwards.
    const lastAdvanceAt = Math.max(state.lastAdvanceAt, now);
    return { ...state, mood: { ...state.mood }, lastAdvanceAt };
  }
  const hours = elapsed / HOUR_MS;
  const interacted = isNum(state.lastInteractionAt) && state.lastInteractionAt > state.lastAdvanceAt;
  const isRest = elapsed >= REST_MIN_GAP_MS && !interacted;
  const calm = traits && isNum(traits.calm) ? traits.calm : 0.5;
  const mood = {
    energy: isRest
      ? approach(state.mood.energy, 100, 30 * hours)
      : approach(state.mood.energy, 70, AWAKE_ENERGY_RECOVERY_PER_HOUR * hours),
    contentment: approach(state.mood.contentment, 55, (8 + 12 * calm) * hours),
    familiarity: state.mood.familiarity,
  };
  return {
    ...state,
    mood,
    label: moodLabel(mood, state.label),
    lastAdvanceAt: now,
  };
}

function applyEvent(state, event, traits, now) {
  const advanced = advance(state, now, traits);
  const kind = event && event.kind;
  if (!EVENT_KINDS.includes(kind)) return advanced;

  // A non-finite clock leaves every timestamp (and the streak) as it was.
  const timed = isNum(now);
  const prev = advanced.streak;
  const count = prev && prev.kind === kind && now - prev.at < STREAK_WINDOW_MS && now >= prev.at
    ? prev.count + 1
    : 1;
  const r = Math.max(MIN_STREAK_FACTOR, 1 / count);
  const s = 0.5 + traits.sensitivity;
  const soc = 0.5 + traits.sociability;

  let dE = 0;
  let dC = 0;
  let dF = 0;
  switch (kind) {
    case "pet": dC = 4 * s * r; dF = 1 * soc * r; break;
    case "click": dC = 1 * r; dF = 0.2 * r; break;
    case "clickBurst": dC = -6 * s; break;
    case "drag": dC = -0.5 * s; break;
    case "dragLong": dE = -3; dC = -2 * s; break;
    case "walk": dE = -0.5 * r; break;
    case "beat": dE = -0.5; break;
    case "hoverGreet": dC = 0.5; dF = 0.2 * r; break;
    default: break;
  }

  const mood = {
    energy: clamp100(advanced.mood.energy + dE),
    contentment: clamp100(advanced.mood.contentment + dC),
    familiarity: clamp100(advanced.mood.familiarity + dF),
  };
  return {
    ...advanced,
    mood,
    label: moodLabel(mood, advanced.label),
    streak: timed ? { kind, count, at: now } : advanced.streak,
    lastInteractionAt: timed && INTERACTION_KINDS.has(kind) ? now : advanced.lastInteractionAt,
  };
}

module.exports = {
  PERSONALITY_IDS,
  PERSONALITY_TRAITS,
  DEFAULT_MOOD,
  EVENT_KINDS,
  normalizePersonality,
  getTraits,
  createInitialState,
  sanitizeState,
  applyEvent,
  advance,
  moodLabel,
};
