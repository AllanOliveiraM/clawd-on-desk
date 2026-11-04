"use strict";

// Clawd Alive companion animations customized from Settings → Animation &
// sound: user overrides reach the effective theme through the same
// applyUserOverridesPatch pipeline as states / reactions / idle animations,
// so the asset whitelist and visual usages pick the replacement up for free.

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const themeLoader = require("../src/theme-loader");
const { applyUserOverridesPatch, VARIANT_ALLOWED_KEYS } = require("../src/theme-variants");
const {
  collectRequiredAssetFiles,
  projectThemeVisualUsages,
  COMPANION_ANIMATION_KEYS,
} = require("../src/theme-schema");
const { normalizeThemeOverrides } = require("../src/prefs");
const { createCompanionRuntime } = require("../src/companion-runtime");
const {
  COMPANION_OVERRIDE_SECTIONS,
  COMPANION_NO_DURATION_KEYS,
} = require("../src/companion-override-slots");

themeLoader.init(path.join(__dirname, "..", "src"));

const RAW = {
  companionAnimations: {
    greet: { file: "greet.svg", duration: 2500 },
    sleepTwitch: { files: ["twitch-a.svg", "twitch-b.svg"], duration: 18000 },
  },
};

test("companion override slots cover every companion key exactly once, in the Settings order", () => {
  const keys = COMPANION_OVERRIDE_SECTIONS.flatMap((section) => section.keys);
  assert.deepStrictEqual([...keys].sort(), [...COMPANION_ANIMATION_KEYS].sort());
  assert.strictEqual(new Set(keys).size, keys.length);
  assert.deepStrictEqual(COMPANION_OVERRIDE_SECTIONS.map((section) => section.id), [
    "companionMoods", "companionCatch", "companionMischief",
    "companionWalks", "companionSleep", "companionTransitions",
  ]);
  for (const key of ["walkBouncy", "walkTired", "walkCurious", "sleepTwitch", "collapseSleepTwitch", "petting"]) {
    assert.ok(COMPANION_NO_DURATION_KEYS.has(key), key);
  }
});

test("user overrides replace a companion file pool and duration", () => {
  const patched = applyUserOverridesPatch(RAW, {
    companionAnimations: {
      greet: { file: "my-greet.svg", durationMs: 1800 },
      sleepTwitch: { file: "my-twitch.svg" },
      content: { file: "not-declared.svg" },
    },
  });
  assert.deepStrictEqual(patched.companionAnimations.greet, { files: ["my-greet.svg"], duration: 1800 });
  assert.deepStrictEqual(patched.companionAnimations.sleepTwitch, { files: ["my-twitch.svg"], duration: 18000 });
  // Only keys the theme declares are customizable, like reactions.
  assert.strictEqual(patched.companionAnimations.content, undefined);
  // The raw theme is never mutated.
  assert.deepStrictEqual(RAW.companionAnimations.greet, { file: "greet.svg", duration: 2500 });
  // Variants still may not touch companionAnimations.
  assert.strictEqual(VARIANT_ALLOWED_KEYS.has("companionAnimations"), false);
});

test("override files join the asset whitelist and visual usages", () => {
  const theme = themeLoader.loadTheme("clawd", {
    strict: true,
    overrides: { companionAnimations: { greet: { file: "clawd-alive-content.svg" } } },
  });
  assert.deepStrictEqual(theme.companionAnimations.greet.files, ["clawd-alive-content.svg"]);
  assert.ok(collectRequiredAssetFiles(theme).includes("clawd-alive-content.svg"));
  assert.ok(projectThemeVisualUsages(theme).some((usage) =>
    usage.stateFamily === "companion:greet" && usage.file === "clawd-alive-content.svg"));
  // The base (pre-override) companion files stay readable for the Settings cards.
  assert.deepStrictEqual(theme._baseCompanionAnimations.greet.files, ["clawd-alive-greet.svg"]);
});

test("path segments in a companion override are stripped before reaching the theme", () => {
  const theme = themeLoader.loadTheme("clawd", {
    strict: true,
    overrides: { companionAnimations: { greet: { file: "../../outside/clawd-alive-boo.svg" } } },
  });
  assert.deepStrictEqual(theme.companionAnimations.greet.files, ["clawd-alive-boo.svg"]);
  assert.ok(!collectRequiredAssetFiles(theme).some((file) => /[\\/]/.test(file)));
});

test("prefs keep companion overrides and drop unknown keys, transitions and unsafe files", () => {
  const out = normalizeThemeOverrides({
    clawd: {
      companionAnimations: {
        greet: { file: "a/b/my-greet.svg", durationMs: 1800, transition: { in: 1, out: 2 }, disabled: true },
        nope: { file: "x.svg" },
        boo: { file: ".." },
        shy: "bad",
      },
    },
  }, {});
  assert.deepStrictEqual(out, { clawd: { companionAnimations: { greet: { file: "my-greet.svg", durationMs: 1800 } } } });
  // A theme map with only companion overrides is not mistaken for legacy states.
  assert.strictEqual(out.clawd.states, undefined);
});

test("the companion runtime plays the overridden file after a live reload", () => {
  let theme = themeLoader.loadTheme("clawd", { strict: true });
  const rt = createCompanionRuntime({
    getTheme: () => theme,
    random: () => 0,
  });
  rt.configure({ enabled: true, memory: false });
  assert.strictEqual(rt.pickSleepVisual("sleeping"), "clawd-alive-sleep-twitch.svg");

  // What setAnimationOverride → activateTheme does: reload with the new map.
  theme = themeLoader.loadTheme("clawd", {
    strict: true,
    overrides: {
      companionAnimations: {
        sleepTwitch: { file: "clawd-alive-collapse-sleep-twitch.svg" },
        collapseSleepTwitch: { file: "clawd-alive-sleep-twitch.svg" },
      },
    },
  });
  assert.strictEqual(rt.pickSleepVisual("sleeping"), "clawd-alive-collapse-sleep-twitch.svg");
  assert.strictEqual(rt.pickSleepVisual("collapsing"), "clawd-alive-sleep-twitch.svg");
  rt.dispose();
});

test("a companion override naming a missing asset fails theme validation like other overrides", () => {
  const ok = themeLoader.validateThemeShape("clawd", {
    overrides: { companionAnimations: { greet: { file: "clawd-alive-content.svg" } } },
  });
  assert.strictEqual(ok.ok, true, ok.errors.join("; "));
  const missing = themeLoader.validateThemeShape("clawd", {
    overrides: { companionAnimations: { greet: { file: "no-such-companion.svg" } } },
  });
  assert.strictEqual(missing.ok, false);
  assert.ok(missing.errors.some((error) => error.includes("missing asset: no-such-companion.svg")), missing.errors.join("; "));
  const reaction = themeLoader.validateThemeShape("clawd", {
    overrides: { reactions: { clickLeft: { file: "no-such-companion.svg" } } },
  });
  assert.strictEqual(reaction.ok, false, "the same check applies to existing override kinds");
});
