"use strict";

// Settings → Animation & sound: how the Clawd Alive companion animations
// (theme.companionAnimations) are grouped into customizable cards, and which
// of them have a duration the user may tune. Shared by the main-process card
// builder and the override command so both agree on the slot surface.

const { COMPANION_ANIMATION_KEYS } = require("./theme-schema");

const COMPANION_OVERRIDE_SECTIONS = Object.freeze([
  Object.freeze({
    id: "companionMoods",
    keys: Object.freeze([
      "petting", "content", "tired", "shy", "grumpy", "curious", "greet", "greetLeft", "shyRight",
    ]),
  }),
  Object.freeze({
    id: "companionCatch",
    keys: Object.freeze([
      "catch", "catchHigh", "catchBody", "catchLow", "catchLeft", "catchRight",
      "catchMiss", "catchMissHigh", "catchMissBody", "catchMissLow", "catchMissLeft", "catchMissRight",
    ]),
  }),
  Object.freeze({
    id: "companionMischief",
    keys: Object.freeze([
      "pounceLeft", "pounceRight", "pounceStrikeLeft", "pounceStrikeRight",
      "fakeNap", "boo", "pokeLeft", "pokeRight", "reachClose", "reachCloseLeft",
      "wallPushLeft", "wallPushRight", "wallPeekLeft", "wallPeekRight",
      "sitEdge", "morningStretch", "coffee", "nightSleepy", "welcome", "stretchBack",
      "toyBall", "toyYoyo", "toyPlane",
    ]),
  }),
  Object.freeze({
    id: "companionWalks",
    keys: Object.freeze(["walkBouncy", "walkTired", "walkCurious"]),
  }),
  Object.freeze({
    id: "companionSleep",
    keys: Object.freeze(["sleepTwitch", "collapseSleepTwitch"]),
  }),
  Object.freeze({
    id: "companionTransitions",
    keys: Object.freeze(["sitDown", "standUp", "fakeNapIn", "fakeNapOut", "pettingIn", "pettingOut"]),
  }),
]);

// Visuals whose length the runtime never reads: petting is held while the
// cursor strokes, walks last as long as the roam, and the dreamy sleep files
// replace the sleeping / collapse visual for the whole phase.
const COMPANION_NO_DURATION_KEYS = new Set([
  "petting", "walkBouncy", "walkTired", "walkCurious", "sleepTwitch", "collapseSleepTwitch",
]);

// The themes author intros as short as 250 ms, below the 500 ms floor of the
// state / idle / reaction cards; the runtime clamps beats to 8 s.
const COMPANION_DURATION_MIN_MS = 100;
const COMPANION_DURATION_MAX_MS = 8000;

const COMPANION_KEY_SET = new Set(COMPANION_ANIMATION_KEYS);

function isCompanionAnimationKey(key) {
  return typeof key === "string" && COMPANION_KEY_SET.has(key);
}

function capitalize(value) {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

function companionCardLabelKey(key) {
  return `animCompanion${capitalize(key)}`;
}

function companionSectionLabelKey(sectionId) {
  return `animOverridesSection${capitalize(sectionId)}`;
}

module.exports = {
  COMPANION_OVERRIDE_SECTIONS,
  COMPANION_NO_DURATION_KEYS,
  COMPANION_DURATION_MIN_MS,
  COMPANION_DURATION_MAX_MS,
  isCompanionAnimationKey,
  companionCardLabelKey,
  companionSectionLabelKey,
};
