"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const intent = require("../src/companion-intent");
const { PERSONALITY_IDS, DEFAULT_MOOD, createInitialState, getTraits } = require("../src/companion-model");
const {
  INTENTS, ANIMATION_KEY_BY_INTENT, INTENT_COOLDOWN_MS,
  intentWeights, chooseIntent, cooldownFor, beatDelayMs, roamDelayMs,
} = intent;

const NOW = 1_000_000;
const ALL = new Set(Object.values(ANIMATION_KEY_BY_INTENT));

function stateWith(mood, label) {
  const s = createInitialState();
  return { ...s, mood: { ...DEFAULT_MOOD, ...mood }, label: label || s.label };
}

function weights(over) {
  return intentWeights({
    traits: getTraits("balanced"), state: stateWith({}), mode: "roam",
    available: ALL, cooldownUntil: {}, now: NOW, ...over,
  });
}

test("exports expected constants", () => {
  assert.deepEqual(INTENTS, ["observe", "content", "tired", "grumpy", "curious", "shy", "greet", "themeActivity"]);
  assert.equal(INTENT_COOLDOWN_MS.greet, 900000);
  assert.equal(ANIMATION_KEY_BY_INTENT.greet, "greet");
});

test("observe is chosen when nothing is available", () => {
  for (const r of [0, 0.5, 0.999999]) {
    const got = chooseIntent({
      traits: getTraits("playful"), state: stateWith({}, "content"), mode: "roam",
      available: new Set(), cooldownUntil: {}, now: NOW, random: () => r,
    });
    assert.equal(got, "observe");
  }
});

test("themeActivity weight is mood independent", () => {
  const a = weights({ mode: "activities", state: stateWith({ contentment: 10 }) });
  const b = weights({ mode: "activities", state: stateWith({ contentment: 95 }) });
  assert.equal(a.themeActivity, 2);
  assert.equal(a.themeActivity, b.themeActivity);
});

test("themeActivity only exists in activities mode", () => {
  assert.equal(weights({ mode: "roam" }).themeActivity, 0);
});

test("grumpy only when label is grumpy", () => {
  assert.equal(weights({ state: stateWith({}, "neutral") }).grumpy, 0);
  assert.equal(weights({ state: stateWith({}, "grumpy") }).grumpy, 3);
});

test("greet requires sociable and familiar", () => {
  const social = { ...getTraits("balanced"), sociability: 0.8 };
  const shyT = { ...getTraits("balanced"), sociability: 0.4 };
  assert.equal(weights({ traits: social, state: stateWith({ familiarity: 20 }) }).greet, 0.8);
  assert.equal(weights({ traits: social, state: stateWith({ familiarity: 5 }) }).greet, 0);
  assert.equal(weights({ traits: shyT, state: stateWith({ familiarity: 50 }) }).greet, 0);
});

test("shy needs low familiarity", () => {
  assert.ok(weights({ state: stateWith({ familiarity: 10 }) }).shy > 0);
  assert.equal(weights({ state: stateWith({ familiarity: 40 }) }).shy, 0);
});

test("missing animation zeroes the intent but not observe", () => {
  const w = weights({ available: new Set(["content"]), state: stateWith({}, "grumpy") });
  assert.equal(w.grumpy, 0);
  assert.ok(w.content > 0);
  assert.ok(w.observe > 0);
});

test("cooldown suppresses intent", () => {
  assert.ok(weights().content > 0);
  assert.equal(weights({ cooldownUntil: { content: NOW + 1 } }).content, 0);
  assert.ok(weights({ cooldownUntil: { content: NOW } }).content > 0);
});

test("calm observes more than playful", () => {
  const share = (id) => {
    const w = weights({ traits: getTraits(id) });
    return w.observe / Object.values(w).reduce((a, b) => a + b, 0);
  };
  assert.ok(share("calm") > share("playful"));
});

test("chooseIntent is deterministic with injected random", () => {
  const args = {
    traits: getTraits("balanced"), state: stateWith({}, "tired"), mode: "activities",
    available: ALL, cooldownUntil: {}, now: NOW,
  };
  const w = intentWeights(args);
  const positive = INTENTS.filter((i) => w[i] > 0);
  assert.equal(chooseIntent({ ...args, random: () => 0 }), positive[0]);
  assert.equal(chooseIntent({ ...args, random: () => 0.999999 }), positive[positive.length - 1]);
});

test("cooldownFor scales with calm", () => {
  assert.equal(cooldownFor("greet", { calm: 0.5 }), 900000);
  assert.equal(cooldownFor("shy", { calm: 1 }), 300000 * 1.25);
  assert.equal(cooldownFor("observe", { calm: 0.5 }), 0);
});

test("roamDelayMs never walks more often than plain roam and slows calm pets", () => {
  // multiplier = clamp(1.2 + (1 - activity) * 1.5, 1.2, 2.7), x1.5 below 25 energy, <= 3x base.
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} vs ${b}`);
  near(roamDelayMs(false, 8000, { activity: 1 }, { energy: 80 }), 9600);
  near(roamDelayMs(false, 8000, { activity: 0.8 }, { energy: 80 }), 12000); // playful 1.5x
  near(roamDelayMs(false, 8000, { activity: 0.5 }, { energy: 80 }), 15600); // balanced 1.95x
  near(roamDelayMs(false, 8000, { activity: 0.25 }, { energy: 80 }), 18600); // calm 2.325x
  near(roamDelayMs(false, 4000, { activity: 0 }, { energy: 80 }), 10800); // capped at 2.7x
  near(roamDelayMs(false, 8000, { activity: 0.8 }, { energy: 10 }), 18000); // tired playful
  near(roamDelayMs(false, 4000, { activity: 0 }, { energy: 10 }), 12000); // <= 3x base
  for (const activity of [0, 0.25, 0.4, 0.5, 0.65, 0.8, 1, 1.5]) {
    assert.ok(roamDelayMs(true, 8000, { activity }, { energy: 50 }) >= 8000 * 1.2 - 1e-6, String(activity));
  }
});

test("beatDelayMs stays within bounds", () => {
  for (const id of PERSONALITY_IDS) {
    for (const energy of [5, 80]) {
      for (const r of [0, 0.999999]) {
        const x = beatDelayMs(getTraits(id), { energy }, () => r);
        assert.ok(x >= 30000 && x <= 360000, `${id} ${energy} ${r} -> ${x}`);
      }
    }
  }
});
