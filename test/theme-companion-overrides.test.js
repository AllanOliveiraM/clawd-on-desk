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
  FETCH_ANIMATION_KEYS,
  SEARCH_MOUSE_ANIMATION_KEYS,
} = require("../src/theme-schema");
const { normalizeThemeOverrides } = require("../src/prefs");
const { createCompanionRuntime } = require("../src/companion-runtime");
const fs = require("node:fs");
const {
  COMPANION_OVERRIDE_SECTIONS,
  COMPANION_NO_DURATION_KEYS,
  COMPANION_DURATION_MIN_MS,
  COMPANION_DURATION_MAX_MS,
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
    "companionMoods", "companionCatch", "companionMischief", "companionFetch",
    "companionWalks", "companionSleep", "companionTransitions",
  ]);
  // "Fetch" holds every fetch part in schema order; searchMouse is mischief.
  const byId = Object.fromEntries(COMPANION_OVERRIDE_SECTIONS.map((section) => [section.id, section.keys]));
  assert.deepStrictEqual([...byId.companionFetch], [...FETCH_ANIMATION_KEYS]);
  for (const key of SEARCH_MOUSE_ANIMATION_KEYS) assert.ok(byId.companionMischief.includes(key), key);
  for (const key of [...FETCH_ANIMATION_KEYS, ...SEARCH_MOUSE_ANIMATION_KEYS]) {
    assert.strictEqual(COMPANION_NO_DURATION_KEYS.has(key), false, `${key} keeps its duration`);
  }
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
  // Durations outside the Settings range, or on keys whose length the
  // runtime never reads, never reach the theme.
  const bounded = applyUserOverridesPatch({
    companionAnimations: {
      petting: { file: "pet.svg" },
      greet: { file: "greet.svg", duration: 2500 },
      walkTired: { file: "walk.svg" },
    },
  }, {
    companionAnimations: {
      petting: { durationMs: 1e10 },
      greet: { durationMs: 1e10 },
      walkTired: { durationMs: 2000 },
    },
  });
  assert.strictEqual(bounded.companionAnimations.petting.duration, undefined);
  assert.strictEqual(bounded.companionAnimations.greet.duration, 2500);
  assert.strictEqual(bounded.companionAnimations.walkTired.duration, undefined);
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
        petting: { durationMs: 1e10 },
        content: { durationMs: 1e10 },
        tired: { durationMs: 4000 },
        sleepTwitch: { file: "t.svg", durationMs: 4000 },
      },
    },
  }, {});
  assert.deepStrictEqual(out, { clawd: { companionAnimations: {
    greet: { file: "my-greet.svg", durationMs: 1800 },
    tired: { durationMs: 4000 },
    sleepTwitch: { file: "t.svg" },
  } } });
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

test("the Settings renderer copies the companion duration range from the slot module", () => {
  assert.strictEqual(COMPANION_DURATION_MIN_MS, 100);
  assert.strictEqual(COMPANION_DURATION_MAX_MS, 8000);
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "settings-tab-anim-overrides.js"), "utf8");
  const min = /const COMPANION_DURATION_MIN_MS = (\d+);/.exec(source);
  const max = /const COMPANION_DURATION_MAX_MS = (\d+);/.exec(source);
  assert.ok(min && max, "renderer declares both constants");
  assert.strictEqual(Number(min[1]), COMPANION_DURATION_MIN_MS);
  assert.strictEqual(Number(max[1]), COMPANION_DURATION_MAX_MS);
});

// ---- gap hunting (settings): applyUserOverridesPatch + prefs normalizer edges ----
test("applyUserOverridesPatch companion edges", () => {
  const raw = {
    companionAnimations: {
      greet: { file: "greet.svg", duration: 2500 },
      sleepTwitch: { file: "t.svg", duration: 18000 },
      fetchDuckLeft: { file: "duck-l.svg" },
      fetchDuckRight: { file: "duck-r.svg" },
      pool: { files: ["a.svg", "b.svg", "c.svg"] },
    },
  };
  const snapshot = JSON.stringify(raw);
  // theme without companionAnimations gets none
  assert.strictEqual(applyUserOverridesPatch({}, { companionAnimations: { greet: { file: "x.svg" } } }).companionAnimations, undefined);
  // non-object raw entry in overrides is skipped; empty file ignored
  const p1 = applyUserOverridesPatch(raw, { companionAnimations: { greet: "bad", fetchDuckLeft: { file: "" } } });
  assert.deepStrictEqual(p1.companionAnimations.greet, raw.companionAnimations.greet);
  assert.deepStrictEqual(p1.companionAnimations.fetchDuckLeft, { file: "duck-l.svg" });
  // durationMs on a NO_DURATION key never lands
  const p2 = applyUserOverridesPatch(raw, { companionAnimations: { sleepTwitch: { durationMs: 2000 } } });
  assert.strictEqual(p2.companionAnimations.sleepTwitch.duration, 18000);
  // prototype keys are ignored
  const evil = JSON.parse('{"companionAnimations":{"__proto__":{"file":"x.svg"},"constructor":{"file":"y.svg"}}}');
  const p3 = applyUserOverridesPatch(raw, evil);
  assert.deepStrictEqual(Object.keys(p3.companionAnimations).sort(), Object.keys(raw.companionAnimations).sort());
  assert.strictEqual({}.file, undefined);
  // files:[file] replaces a multi-file pool
  const p4 = applyUserOverridesPatch(raw, { companionAnimations: { pool: { file: "mine.svg" } } });
  assert.deepStrictEqual(p4.companionAnimations.pool, { files: ["mine.svg"] });
  const multi = applyUserOverridesPatch({ companionAnimations: { greet: { files: ["a.svg", "b.svg"] } } },
    { companionAnimations: { greet: { file: "mine.svg" } } });
  assert.deepStrictEqual(multi.companionAnimations.greet, { files: ["mine.svg"] });
  // fetchDuckLeft override leaves Right alone
  const p5 = applyUserOverridesPatch(raw, { companionAnimations: { fetchDuckLeft: { file: "mine.svg", durationMs: 1500 } } });
  assert.deepStrictEqual(p5.companionAnimations.fetchDuckLeft, { files: ["mine.svg"], duration: 1500 });
  assert.deepStrictEqual(p5.companionAnimations.fetchDuckRight, { file: "duck-r.svg" });
  // raw never mutated
  assert.strictEqual(JSON.stringify(raw), snapshot);
});

test("applyUserOverridesPatch duration boundaries", () => {
  const raw = { companionAnimations: { greet: { file: "g.svg", duration: 2500 }, fetchExitLeft: { file: "f.svg" }, searchMouse: { file: "s.svg" } } };
  const dur = (key, durationMs) => applyUserOverridesPatch(raw, { companionAnimations: { [key]: { durationMs } } }).companionAnimations[key].duration;
  assert.strictEqual(dur("greet", 100), 100);
  assert.strictEqual(dur("greet", 8000), 8000);
  for (const bad of [99, 8001, NaN, Infinity, "500", -1]) assert.strictEqual(dur("greet", bad), 2500, String(bad));
  assert.strictEqual(dur("fetchExitLeft", 1200), 1200);
  assert.strictEqual(dur("searchMouse", 1200), 1200);
});

test("applyUserOverridesPatch work tier edges", () => {
  const raw = { companionWorkTiers: {
    working: [{ minSessions: 1, files: ["a.svg"] }, { minSessions: 2, files: ["b.svg"], variants: ["a.svg"] }],
    juggling: [{ minSessions: 1, files: ["a.svg"] }],
  } };
  const snap = JSON.stringify(raw);
  // chain A->B and B->C: no double replacement
  const chain = applyUserOverridesPatch(raw, { companionWorkTiers: { working: { "a.svg": { file: "b.svg" }, "b.svg": { file: "c.svg" } } } });
  assert.deepStrictEqual(chain.companionWorkTiers.working, [
    { minSessions: 1, files: ["b.svg"] },
    { minSessions: 2, files: ["c.svg"], variants: ["b.svg"] },
  ]);
  // other group untouched
  assert.deepStrictEqual(chain.companionWorkTiers.juggling, raw.companionWorkTiers.juggling);
  // non-array variants / missing group / no block
  const odd = applyUserOverridesPatch({ companionWorkTiers: { working: [{ minSessions: 1, files: ["a.svg"], variants: "a.svg" }] } },
    { companionWorkTiers: { working: { "a.svg": { file: "z.svg" } } } });
  assert.deepStrictEqual(odd.companionWorkTiers.working, [{ minSessions: 1, files: ["z.svg"], variants: "a.svg" }]);
  const missing = applyUserOverridesPatch({ companionWorkTiers: { juggling: [] } }, { companionWorkTiers: { working: { "a.svg": { file: "z.svg" } } } });
  assert.strictEqual(missing.companionWorkTiers.working, undefined);
  // file, files and variants at once
  const all = applyUserOverridesPatch({ companionWorkTiers: { working: [{ minSessions: 1, file: "a.svg", files: ["a.svg"], variants: ["a.svg"] }] } },
    { companionWorkTiers: { working: { "a.svg": { file: "z.svg" } } } });
  assert.deepStrictEqual(all.companionWorkTiers.working, [{ minSessions: 1, file: "z.svg", files: ["z.svg"], variants: ["z.svg"] }]);
  assert.strictEqual(JSON.stringify(raw), snap);
});

test("prefs companion normalizer shapes (items 13, 14, 18, 19)", () => {
  const n = (companionAnimations) => normalizeThemeOverrides({ clawd: { companionAnimations } }, {});
  for (const bad of [[], "str", null, 5]) assert.deepStrictEqual(n(bad), {}, JSON.stringify(bad));
  const long = `${"a".repeat(300)}.svg`;
  for (const file of ["a\\b.svg", "..", ".", long, "", 5]) {
    assert.deepStrictEqual(n({ greet: { file } }), {}, String(file));
  }
  // sourceThemeId only with a file, only as a string
  assert.deepStrictEqual(n({ greet: { file: "g.svg", sourceThemeId: "calico" } }).clawd.companionAnimations.greet, { file: "g.svg", sourceThemeId: "calico" });
  assert.deepStrictEqual(n({ greet: { file: "g.svg", sourceThemeId: 7 } }).clawd.companionAnimations.greet, { file: "g.svg" });
  assert.deepStrictEqual(n({ greet: { durationMs: 1800, sourceThemeId: "calico" } }).clawd.companionAnimations.greet, { durationMs: 1800 });
  // durations
  for (const ms of [100, 8000]) assert.strictEqual(n({ greet: { durationMs: ms } }).clawd.companionAnimations.greet.durationMs, ms);
  for (const bad of [99, 8001, NaN, Infinity, "500", -1, 0]) assert.deepStrictEqual(n({ greet: { durationMs: bad } }), {}, String(bad));
  assert.strictEqual(n({ fetchExitLeft: { durationMs: 1200 } }).clawd.companionAnimations.fetchExitLeft.durationMs, 1200);
  assert.strictEqual(n({ searchMouse: { durationMs: 1200 } }).clawd.companionAnimations.searchMouse.durationMs, 1200);
  // a corrupt theme does not drop another
  const two = normalizeThemeOverrides({ bad: { companionAnimations: "x" }, clawd: { companionAnimations: { greet: { file: "g.svg" } } } }, {});
  assert.deepStrictEqual(two, { clawd: { companionAnimations: { greet: { file: "g.svg" } } } });
  // idempotent
  const once = normalizeThemeOverrides({ clawd: { companionAnimations: { greet: { file: "a/b/g.svg", durationMs: 1800, sourceThemeId: "c" } },
    companionWorkTiers: { working: { "w.svg": { file: "x\\y.svg" }, "v.svg": { file: "ok.svg" } } } } }, {});
  assert.deepStrictEqual(normalizeThemeOverrides(once, {}), once);
  // old prefs for an old theme load
  assert.deepStrictEqual(normalizeThemeOverrides({ "old-theme": { companionAnimations: { greet: { file: "g.svg" } } } }, {}),
    { "old-theme": { companionAnimations: { greet: { file: "g.svg" } } } });
});

test("companionPersonality prefs validation (item 19)", () => {
  const prefs = require("../src/prefs");
  for (const bad of [5, null, {}, [], "Balanced", "constructor", "__proto__", "toString"]) {
    const out = prefs.validate({ ...prefs.getDefaults(), companionPersonality: bad });
    assert.strictEqual(out.companionPersonality, "balanced", String(bad));
  }
  assert.strictEqual(prefs.validate({ ...prefs.getDefaults(), companionPersonality: "shy" }).companionPersonality, "shy");
});
