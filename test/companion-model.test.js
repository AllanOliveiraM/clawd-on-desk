"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const model = require("../src/companion-model");
const {
  PERSONALITY_IDS, PERSONALITY_TRAITS, DEFAULT_MOOD, EVENT_KINDS,
  normalizePersonality, getTraits, createInitialState, sanitizeState,
  applyEvent, advance, moodLabel,
} = model;

const HOUR = 3600 * 1000;
const T0 = 1_000_000;

function stateWith(mood, extra) {
  return { ...createInitialState(), mood: { ...DEFAULT_MOOD, ...mood }, ...extra };
}

function deepFreeze(obj) {
  for (const v of Object.values(obj)) if (v && typeof v === "object") deepFreeze(v);
  return Object.freeze(obj);
}

test("exports expected constants", () => {
  assert.deepEqual(PERSONALITY_IDS, ["balanced", "playful", "curious", "calm", "shy"]);
  assert.ok(Object.isFrozen(PERSONALITY_TRAITS));
  assert.equal(EVENT_KINDS.length, 8);
});

test("normalizePersonality rejects unknown ids", () => {
  assert.equal(normalizePersonality("x"), "balanced");
  assert.equal(normalizePersonality(null), "balanced");
  assert.equal(normalizePersonality("shy"), "shy");
});

test("getTraits returns fresh copies", () => {
  const a = getTraits("playful");
  a.activity = 0;
  assert.equal(getTraits("playful").activity, 0.8);
  assert.equal(getTraits("bogus").calm, 0.5);
});

test("createInitialState matches defaults", () => {
  const s = createInitialState();
  assert.deepEqual(s.mood, DEFAULT_MOOD);
  assert.notEqual(s.mood, DEFAULT_MOOD);
  assert.equal(s.label, "neutral");
  assert.equal(s.streak, null);
  assert.equal(s.lastAdvanceAt, null);
  assert.equal(s.lastInteractionAt, null);
});

test("sanitizeState clamps and repairs", () => {
  const s = sanitizeState({ mood: { energy: 999, contentment: "x", familiarity: -4 } }, T0);
  assert.deepEqual(s.mood, { energy: 100, contentment: 55, familiarity: 0 });
  assert.deepEqual(sanitizeState(null, T0), createInitialState());
  assert.equal(sanitizeState({ label: "bogus" }, T0).label, "neutral");
});

test("pet raises contentment more for playful than calm", () => {
  const gain = (id) => applyEvent(createInitialState(), { kind: "pet" }, getTraits(id), T0).mood.contentment - 55;
  assert.ok(gain("playful") > gain("calm"));
});

test("repeated pets have diminishing returns", () => {
  const traits = getTraits("balanced");
  let s = createInitialState();
  const gains = [];
  for (let i = 0; i < 5; i++) {
    const before = advance(s, T0 + i * 1000, traits).mood.contentment;
    s = applyEvent(s, { kind: "pet" }, traits, T0 + i * 1000);
    gains.push(s.mood.contentment - before);
  }
  assert.ok(gains[4] < gains[0] * 0.3);
  const before = advance(s, T0 + 35000, traits).mood.contentment;
  const later = applyEvent(s, { kind: "pet" }, traits, T0 + 35000);
  assert.ok(Math.abs(later.mood.contentment - before - gains[0]) < 0.01);
});

test("clickBurst lowers contentment and can reach grumpy", () => {
  const traits = getTraits("shy");
  let s = createInitialState();
  for (let i = 0; i < 6; i++) s = applyEvent(s, { kind: "clickBurst" }, traits, T0 + i * 100);
  assert.ok(s.mood.contentment < 55);
  assert.equal(s.label, "grumpy");
});

test("hysteresis prevents flapping", () => {
  assert.equal(moodLabel({ energy: 70, contentment: 24, familiarity: 0 }, "neutral"), "grumpy");
  assert.equal(moodLabel({ energy: 70, contentment: 30, familiarity: 0 }, "grumpy"), "grumpy");
  assert.equal(moodLabel({ energy: 70, contentment: 36, familiarity: 0 }, "grumpy"), "neutral");
  assert.equal(moodLabel({ energy: 20, contentment: 20, familiarity: 0 }, "neutral"), "tired");
  assert.equal(moodLabel({ energy: 30, contentment: 80, familiarity: 0 }, "tired"), "tired");
  assert.equal(moodLabel({ energy: 70, contentment: 70, familiarity: 0 }, "content"), "content");
  assert.equal(moodLabel({ energy: 70, contentment: 70, familiarity: 0 }, "neutral"), "neutral");
});

test("advance recovers toward baselines without overshoot", () => {
  const s = stateWith({ contentment: 20 }, { lastAdvanceAt: T0 });
  const out = advance(s, T0 + 10 * HOUR, getTraits("balanced"));
  assert.equal(out.mood.contentment, 55);
  const hi = stateWith({ contentment: 90 }, { lastAdvanceAt: T0 });
  assert.equal(advance(hi, T0 + 10 * HOUR, getTraits("balanced")).mood.contentment, 55);
});

test("long unattended gap counts as rest", () => {
  const traits = getTraits("balanced");
  const rest = advance(stateWith({ energy: 20 }, { lastAdvanceAt: T0 }), T0 + 2 * HOUR, traits);
  assert.equal(rest.mood.energy, 80);
  const busy = advance(stateWith({ energy: 20 }, { lastAdvanceAt: T0, lastInteractionAt: T0 + HOUR / 4 }), T0 + HOUR / 2, traits);
  assert.equal(busy.mood.energy, 40);
});

test("familiarity never decays", () => {
  const s = stateWith({ familiarity: 40 }, { lastAdvanceAt: T0 });
  assert.equal(advance(s, T0 + 30 * 24 * HOUR, getTraits("balanced")).mood.familiarity, 40);
});

test("elapsed is capped and negative time is ignored", () => {
  const s = stateWith({ energy: 20, contentment: 30 }, { lastAdvanceAt: T0 });
  const out = advance(s, T0 - HOUR, getTraits("balanced"));
  assert.deepEqual(out.mood, s.mood);
  const capped = advance(stateWith({ energy: 0 }, { lastAdvanceAt: T0 }), T0 + 365 * 24 * HOUR, getTraits("balanced"));
  assert.equal(capped.mood.energy, 100);
  const first = advance(createInitialState(), T0, getTraits("balanced"));
  assert.equal(first.lastAdvanceAt, T0);
  assert.deepEqual(first.mood, DEFAULT_MOOD);
});

test("applyEvent is pure and updates interaction time", () => {
  const frozen = deepFreeze(stateWith({}, { lastAdvanceAt: T0 }));
  const out = applyEvent(frozen, { kind: "pet" }, getTraits("balanced"), T0 + 1000);
  assert.equal(out.lastInteractionAt, T0 + 1000);
  assert.equal(out.streak.count, 1);
  assert.equal(applyEvent(frozen, { kind: "walk" }, getTraits("balanced"), T0 + 1000).lastInteractionAt, null);
});

test("awake recovery moves energy toward 70 at 40 per hour", () => {
  const traits = getTraits("balanced");
  // Short gaps never count as rest, so recovery accumulates at the awake rate.
  let s = stateWith({ energy: 20 }, { lastAdvanceAt: T0 });
  for (let i = 1; i <= 90; i++) s = advance(s, T0 + i * 10 * 1000, traits); // 15 minutes
  assert.ok(Math.abs(s.mood.energy - 30) < 1e-9, `energy ${s.mood.energy}`);
  const high = advance(stateWith({ energy: 90 }, { lastAdvanceAt: T0, lastInteractionAt: T0 + 1 }), T0 + HOUR / 4, traits);
  assert.equal(high.mood.energy, 80);
});

test("walk costs 0.5 energy with diminishing returns inside the streak window", () => {
  const traits = getTraits("balanced");
  let s = stateWith({ energy: 50 }, { lastAdvanceAt: T0 });
  s = applyEvent(s, { kind: "walk" }, traits, T0);
  assert.equal(s.mood.energy, 49.5);
  // Second walk 0 ms later in the streak: r = 1/2.
  s = applyEvent(s, { kind: "walk" }, traits, T0);
  assert.equal(s.mood.energy, 49.25);
  for (let i = 0; i < 20; i++) s = applyEvent(s, { kind: "walk" }, traits, T0);
  // Floor of the streak factor: 0.5 * 0.15.
  const before = s.mood.energy;
  s = applyEvent(s, { kind: "walk" }, traits, T0);
  assert.ok(Math.abs(before - s.mood.energy - 0.075) < 1e-9);
});

test("applyEvent with a non-finite now keeps the timestamps unchanged", () => {
  const base = stateWith({}, { lastAdvanceAt: T0, lastInteractionAt: T0 - 5, streak: { kind: "pet", count: 2, at: T0 - 10 } });
  for (const bad of [NaN, Infinity, undefined, null, "x"]) {
    const out = applyEvent(base, { kind: "pet" }, getTraits("balanced"), bad);
    assert.equal(out.lastAdvanceAt, T0, String(bad));
    assert.equal(out.lastInteractionAt, T0 - 5, String(bad));
    assert.ok(Number.isFinite(out.streak.at), String(bad));
    assert.equal(out.streak.at, T0 - 10);
    assert.ok(Object.values(out.mood).every(Number.isFinite));
  }
  const fresh = applyEvent(createInitialState(), { kind: "pet" }, getTraits("balanced"), NaN);
  assert.equal(fresh.lastInteractionAt, null);
  assert.equal(fresh.lastAdvanceAt, null);
  assert.ok(fresh.streak === null || Number.isFinite(fresh.streak.at));
});
