"use strict";

// Pure intent selection for the opt-in "Clawd Alive" companion.
// No I/O, no timers: the runtime arbiter injects state, clock and random.

const INTENTS = ["observe", "content", "tired", "grumpy", "curious", "shy", "greet", "themeActivity"];

// Intents that need a companion animation present in the theme.
const ANIMATION_KEY_BY_INTENT = {
  content: "content",
  tired: "tired",
  grumpy: "grumpy",
  curious: "curious",
  shy: "shy",
  greet: "greet",
};

const INTENT_COOLDOWN_MS = {
  greet: 900000,
  shy: 300000,
  content: 180000,
  curious: 180000,
  tired: 240000,
  grumpy: 240000,
};

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function rawWeights(traits, state, mode) {
  const mood = (state && state.mood) || {};
  const label = state && state.label;
  const energy = Number.isFinite(mood.energy) ? mood.energy : 50;
  const familiarity = Number.isFinite(mood.familiarity) ? mood.familiarity : 0;
  return {
    observe: 3 + 3 * traits.calm,
    content: (label === "content" ? 3 : 1) * (0.5 + traits.activity),
    tired: label === "tired" ? 4 : (energy < 50 ? 1 : 0),
    grumpy: label === "grumpy" ? 3 : 0,
    curious: 2 * traits.curiosity,
    shy: familiarity < 40 ? 1.5 * (1 - traits.sociability) : 0,
    greet: traits.sociability >= 0.6 && familiarity >= 10 ? traits.sociability : 0,
    themeActivity: mode === "activities" ? 2 : 0,
  };
}

function intentWeights({ traits, state, mode, available, cooldownUntil, now }) {
  const weights = rawWeights(traits, state, mode);
  const cooldowns = cooldownUntil || {};
  for (const intent of INTENTS) {
    const key = ANIMATION_KEY_BY_INTENT[intent];
    if (key && !(available && available.has(key))) weights[intent] = 0;
    if (now < cooldowns[intent]) weights[intent] = 0;
  }
  return weights;
}

function chooseIntent(args) {
  const random = typeof args.random === "function" ? args.random : Math.random;
  const weights = intentWeights(args);
  let total = 0;
  for (const intent of INTENTS) total += weights[intent];
  if (!(total > 0)) return "observe";
  const target = random() * total;
  let acc = 0;
  let last = "observe";
  for (const intent of INTENTS) {
    if (!(weights[intent] > 0)) continue;
    acc += weights[intent];
    last = intent;
    if (acc > target) return intent;
  }
  return last;
}

function cooldownFor(intent, traits) {
  const base = INTENT_COOLDOWN_MS[intent] || 0;
  return base * (0.75 + 0.5 * traits.calm);
}

function beatDelayMs(traits, mood, random) {
  const rnd = typeof random === "function" ? random : Math.random;
  const base = 60000 + rnd() * 120000;
  const lowEnergy = mood && mood.energy < 25 ? 1.5 : 1;
  return clamp(base * (1.5 - traits.activity) * lowEnergy, 30000, 360000);
}

// isFirst is part of the arbiter's hook signature; the formula does not use it.
// With the companion on the pet never walks more often than plain roam: the
// pause is at least 1.2x base and stretches for calmer (less active) pets up
// to 2.7x, x1.5 more when tired, never past 3x base. One-off walks (pending
// mischief, the walk back from an edge) are shortened by the runtime instead.
const ROAM_DELAY_MIN_FACTOR = 1.2;
const ROAM_DELAY_CALM_SPAN = 1.5;
const ROAM_DELAY_MAX_FACTOR = 2.7;
const ROAM_DELAY_TIRED_FACTOR = 1.5;

function roamDelayMs(isFirst, baseMs, traits, mood) {
  const activity = traits && Number.isFinite(traits.activity) ? traits.activity : 0.5;
  const factor = clamp(ROAM_DELAY_MIN_FACTOR + (1 - activity) * ROAM_DELAY_CALM_SPAN, ROAM_DELAY_MIN_FACTOR, ROAM_DELAY_MAX_FACTOR);
  const lowEnergy = mood && mood.energy < 25 ? ROAM_DELAY_TIRED_FACTOR : 1;
  return clamp(baseMs * factor * lowEnergy, baseMs, 3 * baseMs);
}

module.exports = {
  INTENTS,
  ANIMATION_KEY_BY_INTENT,
  INTENT_COOLDOWN_MS,
  intentWeights,
  chooseIntent,
  cooldownFor,
  beatDelayMs,
  roamDelayMs,
};
