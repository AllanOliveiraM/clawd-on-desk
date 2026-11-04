"use strict";

// Settings → Animation & sound: how the Clawd Alive companion animations
// (theme.companionAnimations) are grouped into customizable cards, and which
// of them have a duration the user may tune. Shared by the main-process card
// builder and the override command so both agree on the slot surface.

const { COMPANION_ANIMATION_KEYS, FETCH_ANIMATION_KEYS } = require("./theme-schema");

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
      "toyBall", "toyYoyo", "toyPlane", "searchMouse",
    ]),
  }),
  Object.freeze({
    // "Vai buscar": the exit through the side edge and every hauled object.
    id: "companionFetch",
    keys: FETCH_ANIMATION_KEYS,
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

// ---- Work escalation ladder (theme.companionWorkTiers) ----
// One "Work" card per ladder file. Overrides are keyed by group and by the
// file the theme declares: themeOverrides[themeId].companionWorkTiers
// [working | juggling][originalFile] = { file }. They are loops played for as
// long as the state lasts, so a card has no duration (and no fades).
const COMPANION_WORK_SECTION_ID = "companionWork";
const COMPANION_WORK_TIER_GROUPS = Object.freeze(["working", "juggling"]);
const COMPANION_WORK_GROUP_SET = new Set(COMPANION_WORK_TIER_GROUPS);

function isCompanionWorkTierGroup(group) {
  return typeof group === "string" && COMPANION_WORK_GROUP_SET.has(group);
}

// A bare file name a theme could declare (no path, no dot segments, no
// prototype keys, at most COMPANION_FILE_NAME_MAX chars), the same rule the
// prefs normalizer applies to the keys.
const COMPANION_FILE_NAME_MAX = 255;
function isCompanionWorkFileName(file) {
  return typeof file === "string"
    && file.length > 0
    && file.length <= COMPANION_FILE_NAME_MAX
    && file !== "__proto__"
    && file !== "constructor"
    && file !== "prototype"
    && !/[\\/]/.test(file)
    && file !== "."
    && file !== "..";
}

// Cards for a normalized companionWorkTiers block: working first, then
// juggling, each by ascending tier; a file listed twice in a group (files and
// variants, or two tiers) gets one card at its lowest tier, since one override
// replaces it everywhere in that group.
function listCompanionWorkTierCards(block) {
  const out = [];
  if (!block || typeof block !== "object") return out;
  for (const tierGroup of COMPANION_WORK_TIER_GROUPS) {
    const tiers = Array.isArray(block[tierGroup])
      ? block[tierGroup].filter((tier) => tier && typeof tier === "object" && Number.isFinite(tier.minSessions))
      : [];
    if (tiers.length === 0) continue;
    const top = Math.max(...tiers.map((tier) => tier.minSessions));
    const seen = new Set();
    const ascending = [...tiers].sort((a, b) => a.minSessions - b.minSessions);
    for (const tier of ascending) {
      for (const tierKind of ["files", "variants"]) {
        for (const file of Array.isArray(tier[tierKind]) ? tier[tierKind] : []) {
          if (!isCompanionWorkFileName(file) || seen.has(file)) continue;
          seen.add(file);
          out.push({
            tierGroup,
            originalFile: file,
            minSessions: tier.minSessions,
            tierKind,
            topTier: tier.minSessions === top,
          });
        }
      }
    }
  }
  return out;
}

// animCompanion + the file stem without the "clawd-alive-" prefix, camel
// cased: clawd-alive-work-control-room.svg -> animCompanionWorkControlRoom.
// The renderer falls back to a generic tier label when a theme's file has no
// translation.
function companionWorkCardLabelKey(file) {
  const stem = String(file || "")
    .replace(/^.*[\\/]/, "")
    .replace(/\.[^.]*$/, "")
    .replace(/^clawd-alive-/, "");
  const words = stem.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return `animCompanion${words.map(capitalize).join("")}`;
}

module.exports = {
  COMPANION_OVERRIDE_SECTIONS,
  COMPANION_WORK_SECTION_ID,
  COMPANION_WORK_TIER_GROUPS,
  isCompanionWorkTierGroup,
  isCompanionWorkFileName,
  COMPANION_FILE_NAME_MAX,
  listCompanionWorkTierCards,
  companionWorkCardLabelKey,
  COMPANION_NO_DURATION_KEYS,
  COMPANION_DURATION_MIN_MS,
  COMPANION_DURATION_MAX_MS,
  isCompanionAnimationKey,
  companionCardLabelKey,
  companionSectionLabelKey,
};
