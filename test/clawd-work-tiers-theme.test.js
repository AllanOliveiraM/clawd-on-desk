"use strict";

// Clawd Alive work escalation art as the built-in clawd theme declares it:
// the companionWorkTiers ladder (Ruling P13) and the registrations each new
// file needs to render like the original working sprites.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const themeLoader = require("../src/theme-loader");
const { createCompanionRuntime } = require("../src/companion-runtime");
const {
  BUILTIN_ACCESSORY_MOTION_PADDING,
  BUILTIN_MOUTH_ACCESSORY_MOTION_PADDING,
} = require("../src/pet-accessory-hitbox");
const { SVG_GIF } = require("../src/discord-presence-rpc");

const ROOT = path.join(__dirname, "..");
themeLoader.init(path.join(ROOT, "src"));

const WORK_FILES = Object.freeze([
  "clawd-alive-work-coffee.svg",
  "clawd-alive-work-dual.svg",
  "clawd-alive-work-trio.svg",
  "clawd-alive-work-control-room.svg",
  "clawd-alive-work-swamped.svg",
  "clawd-alive-work-chaos.svg",
]);
const JUGGLE_FILES = Object.freeze([
  "clawd-alive-juggle-laptops.svg",
  "clawd-alive-juggle-chaos.svg",
]);
const ALL_FILES = Object.freeze([...WORK_FILES, ...JUGGLE_FILES]);
// The headset (trio) and the rubber duck on his head (juggle chaos) already
// occupy the head, like the headphones sprite: no hat on those two.
const HATLESS = new Set(["clawd-alive-work-trio.svg", "clawd-alive-juggle-chaos.svg"]);
// The work chaos tier hops and flips, so it hides both accessories to keep the
// click area from widening.
const ACCESSORIES_HIDDEN = new Set(["clawd-alive-work-chaos.svg"]);

function readRaw() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "themes", "clawd", "theme.json"), "utf8"));
}

test("clawd declares the work escalation ladder: variants at tiers 1-3, files from 4 sessions / 3 subagents", () => {
  const raw = readRaw();
  assert.deepStrictEqual(raw.companionWorkTiers, {
    working: [
      { minSessions: 6, files: ["clawd-alive-work-chaos.svg"] },
      { minSessions: 5, files: ["clawd-alive-work-swamped.svg"] },
      { minSessions: 4, files: ["clawd-alive-work-control-room.svg"] },
      { minSessions: 3, variants: ["clawd-alive-work-trio.svg"] },
      { minSessions: 2, variants: ["clawd-alive-work-dual.svg"] },
      { minSessions: 1, variants: ["clawd-alive-work-coffee.svg"] },
    ],
    juggling: [
      { minSessions: 4, files: ["clawd-alive-juggle-chaos.svg"] },
      { minSessions: 3, files: ["clawd-alive-juggle-laptops.svg"] },
    ],
  });
  const theme = themeLoader.loadTheme("clawd", { strict: true });
  assert.deepStrictEqual(theme.companionWorkTiers.working.map((tier) => tier.minSessions), [6, 5, 4, 3, 2, 1]);
  assert.deepStrictEqual(theme.companionWorkTiers.juggling.map((tier) => tier.minSessions), [4, 3]);
  // The original ladders stay exactly as they were (Ruling P11).
  assert.deepStrictEqual(raw.workingTiers.map((tier) => tier.file), [
    "clawd-working-building.svg", "clawd-headphones-groove.svg", "clawd-working-typing.svg",
  ]);
  assert.deepStrictEqual(raw.jugglingTiers.map((tier) => tier.file), [
    "clawd-working-juggling.svg", "clawd-headphones-groove.svg",
  ]);
});

test("the companion picks the clawd ladder files for the session / subagent count", () => {
  const theme = themeLoader.loadTheme("clawd", { strict: true });
  let roll = 0;
  const rt = createCompanionRuntime({ getTheme: () => theme, random: () => roll });
  rt.configure({ enabled: true, memory: false });
  let episode = 0;
  const pick = (state, count) => rt.pickWorkVisual(state, {
    sessions: state === "working" ? count : 0,
    subagents: state === "juggling" ? count : 0,
    episode: episode++,
  });
  roll = 0.9; // above the 35% variant chance
  assert.strictEqual(pick("working", 1), null);
  assert.strictEqual(pick("working", 3), null);
  assert.strictEqual(pick("working", 4), "clawd-alive-work-control-room.svg");
  assert.strictEqual(pick("working", 5), "clawd-alive-work-swamped.svg");
  assert.strictEqual(pick("working", 9), "clawd-alive-work-chaos.svg");
  assert.strictEqual(pick("juggling", 2), null);
  assert.strictEqual(pick("juggling", 3), "clawd-alive-juggle-laptops.svg");
  assert.strictEqual(pick("juggling", 7), "clawd-alive-juggle-chaos.svg");
  roll = 0;
  assert.strictEqual(pick("working", 1), "clawd-alive-work-coffee.svg");
  assert.strictEqual(pick("working", 2), "clawd-alive-work-dual.svg");
  assert.strictEqual(pick("working", 3), "clawd-alive-work-trio.svg");
  rt.dispose();
});

test("every work escalation file is registered like the original working sprites", () => {
  const raw = readRaw();
  const theme = themeLoader.loadTheme("clawd", { strict: true });
  const head = raw.customization.accessories.files;
  const mouth = raw.customization.mouthAccessories.files;
  const headEnvelopes = BUILTIN_ACCESSORY_MOTION_PADDING.clawd;
  const mouthEnvelopes = BUILTIN_MOUTH_ACCESSORY_MOTION_PADDING.clawd;
  const torsoHead = { cx: 7.5, baseY: 6.5, width: 16 };
  const torsoMouth = { cx: 14, baseY: 13, width: 5 };
  for (const file of ALL_FILES) {
    assert.ok(fs.existsSync(path.join(ROOT, "assets", "svg", file)), `${file} asset`);
    assert.ok(raw.rendering.objectChannelFiles.includes(file), `${file} object channel`);
    assert.strictEqual(raw.rendering.discreteSampling[file], 24, `${file} sampling`);
    if (HATLESS.has(file) || ACCESSORIES_HIDDEN.has(file)) {
      assert.deepStrictEqual(head[file], { visibility: "hidden" }, `${file} head`);
    } else {
      assert.deepStrictEqual(head[file], {
        staticFrame: torsoHead,
        followTarget: { id: "torso", frame: torsoHead },
      }, `${file} head`);
      assert.ok(headEnvelopes[file], `${file} head envelope`);
    }
    if (ACCESSORIES_HIDDEN.has(file)) {
      assert.deepStrictEqual(mouth[file], { visibility: "hidden" }, `${file} mouth`);
      assert.strictEqual(mouthEnvelopes[file], undefined, `${file} mouth envelope`);
      assert.strictEqual(headEnvelopes[file], undefined, `${file} head envelope`);
    } else {
      assert.deepStrictEqual(mouth[file], {
        staticFrame: torsoMouth,
        followTarget: { id: "torso", frame: torsoMouth },
      }, `${file} mouth`);
      assert.ok(mouthEnvelopes[file], `${file} mouth envelope`);
    }
    assert.ok(theme._capabilities.accessories);
  }
  for (const file of WORK_FILES) {
    assert.strictEqual(SVG_GIF[file], "clawd-typing.gif", `${file} Discord gif`);
    // Same desk-and-screen click zone as the typing sprite they escalate.
    assert.deepStrictEqual(raw.fileHitBoxes[file], raw.fileHitBoxes["clawd-working-typing.svg"], `${file} hit box`);
  }
  for (const file of JUGGLE_FILES) {
    assert.strictEqual(SVG_GIF[file], "clawd-juggling.gif", `${file} Discord gif`);
    assert.strictEqual(raw.fileHitBoxes[file], undefined, `${file} keeps the default hit box like juggling`);
  }
});
