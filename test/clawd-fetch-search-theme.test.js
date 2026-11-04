"use strict";

// Clawd Alive fetch ("vai buscar") and searchMouse art as the built-in clawd
// theme declares it: each file is registered like its companion peers, its
// declared duration is the art's own loop, and the fetch parts hide both
// accessories (he leaves the frame, so a hat or cigarette would float).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const themeLoader = require("../src/theme-loader");
const { FETCH_ANIMATION_KEYS } = require("../src/theme-schema");
const {
  BUILTIN_ACCESSORY_MOTION_PADDING,
  BUILTIN_MOUTH_ACCESSORY_MOTION_PADDING,
} = require("../src/pet-accessory-hitbox");

const ROOT = path.join(__dirname, "..");
themeLoader.init(path.join(ROOT, "src"));

function fileForKey(key) {
  if (key === "searchMouse") return "clawd-alive-search-mouse.svg";
  const match = /^fetch([A-Z][a-z]+)(Left|Right)$/.exec(key);
  return `clawd-alive-fetch-${match[1].toLowerCase()}-${match[2].toLowerCase()}.svg`;
}

// Every animation in these files shares one loop length; read it back.
function loopMs(file) {
  const text = fs.readFileSync(path.join(ROOT, "assets", "svg", file), "utf8");
  const found = new Set();
  for (const match of text.matchAll(/animation:\s*[\w-]+\s+([0-9.]+)(m?s)\b/g)) {
    found.add(match[2] === "ms" ? Number(match[1]) : Math.round(Number(match[1]) * 1000));
  }
  assert.strictEqual(found.size, 1, `${file}: one loop length, got ${[...found]}`);
  return [...found][0];
}

function readRaw() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "themes", "clawd", "theme.json"), "utf8"));
}

test("clawd declares every fetch part and searchMouse with the art's own loop length", () => {
  const raw = readRaw();
  for (const key of [...FETCH_ANIMATION_KEYS, "searchMouse"]) {
    const file = fileForKey(key);
    assert.deepStrictEqual(raw.companionAnimations[key], { file, duration: loopMs(file) }, key);
  }
  assert.strictEqual(raw.companionAnimations.fetchExitLeft.duration, 2000);
  assert.strictEqual(raw.companionAnimations.fetchCursorRight.duration, 7600);
  assert.strictEqual(raw.companionAnimations.fetchDuckLeft.duration, 7900);
  assert.strictEqual(raw.companionAnimations.fetchSockRight.duration, 8000);
  assert.strictEqual(raw.companionAnimations.searchMouse.duration, 3000);
});

test("fetch and searchMouse files render like their companion peers", () => {
  const raw = readRaw();
  const theme = themeLoader.loadTheme("clawd", { strict: true });
  const head = raw.customization.accessories.files;
  const mouth = raw.customization.mouthAccessories.files;
  const headEnvelopes = BUILTIN_ACCESSORY_MOTION_PADDING.clawd;
  const mouthEnvelopes = BUILTIN_MOUTH_ACCESSORY_MOTION_PADDING.clawd;
  for (const key of [...FETCH_ANIMATION_KEYS, "searchMouse"]) {
    const file = fileForKey(key);
    assert.ok(raw.rendering.objectChannelFiles.includes(file), `${file} object channel`);
    assert.strictEqual(raw.rendering.discreteSampling[file], 24, `${file} sampling`);
    assert.ok(theme.companionAnimations[key], `${key} normalized`);
  }
  for (const key of FETCH_ANIMATION_KEYS) {
    const file = fileForKey(key);
    assert.deepStrictEqual(head[file], { visibility: "hidden" }, `${file} head`);
    assert.deepStrictEqual(mouth[file], { visibility: "hidden" }, `${file} mouth`);
    assert.strictEqual(headEnvelopes[file], undefined, `${file} head envelope`);
    assert.strictEqual(mouthEnvelopes[file], undefined, `${file} mouth envelope`);
  }
  const search = "clawd-alive-search-mouse.svg";
  const torsoHead = { cx: 7.5, baseY: 6.5, width: 16 };
  const torsoMouth = { cx: 14, baseY: 13, width: 5 };
  assert.deepStrictEqual(head[search], { staticFrame: torsoHead, followTarget: { id: "torso", frame: torsoHead } });
  assert.deepStrictEqual(mouth[search], { staticFrame: torsoMouth, followTarget: { id: "torso", frame: torsoMouth } });
  assert.ok(headEnvelopes[search], "searchMouse head envelope");
  assert.ok(mouthEnvelopes[search], "searchMouse mouth envelope");
});
