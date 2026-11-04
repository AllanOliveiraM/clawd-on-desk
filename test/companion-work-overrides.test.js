"use strict";

// Settings → Animation & sound → Clawd Alive → Work: replacing the files of the
// theme's companionWorkTiers ladder. Overrides live in
// themeOverrides[themeId].companionWorkTiers[group][originalFile] and ride the
// same applyUserOverridesPatch pipeline as the companion animation cards.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const themeLoader = require("../src/theme-loader");
const { applyUserOverridesPatch, VARIANT_ALLOWED_KEYS } = require("../src/theme-variants");
const { collectRequiredAssetFiles, projectThemeVisualUsages } = require("../src/theme-schema");
const { normalizeThemeOverrides } = require("../src/prefs");
const { createCompanionRuntime } = require("../src/companion-runtime");
const { getWorkingSvg } = require("../src/state-visual-resolver");
const themeOverrideCommands = require("../src/settings-actions-theme-overrides");
const {
  listCompanionWorkTierCards,
  companionWorkCardLabelKey,
  COMPANION_WORK_SECTION_ID,
} = require("../src/companion-override-slots");

themeLoader.init(path.join(__dirname, "..", "src"));

const RAW = {
  companionWorkTiers: {
    working: [
      { minSessions: 4, files: ["control.svg"] },
      { minSessions: 1, variants: ["coffee.svg"] },
      { minSessions: 2, files: ["dual-a.svg", "dual-b.svg"], variants: ["coffee.svg"] },
    ],
    juggling: [{ minSessions: 3, files: ["laptops.svg"] }],
  },
};

test("work tier cards list every ladder file once, by group then ascending tier", () => {
  const cards = listCompanionWorkTierCards(require("../src/theme-schema").normalizeCompanionWorkTiers(RAW.companionWorkTiers));
  assert.deepStrictEqual(cards, [
    { tierGroup: "working", originalFile: "coffee.svg", minSessions: 1, tierKind: "variants", topTier: false },
    { tierGroup: "working", originalFile: "dual-a.svg", minSessions: 2, tierKind: "files", topTier: false },
    { tierGroup: "working", originalFile: "dual-b.svg", minSessions: 2, tierKind: "files", topTier: false },
    { tierGroup: "working", originalFile: "control.svg", minSessions: 4, tierKind: "files", topTier: true },
    { tierGroup: "juggling", originalFile: "laptops.svg", minSessions: 3, tierKind: "files", topTier: true },
  ]);
  assert.deepStrictEqual(listCompanionWorkTierCards(null), []);
  assert.deepStrictEqual(listCompanionWorkTierCards({ working: "x" }), []);
  assert.strictEqual(COMPANION_WORK_SECTION_ID, "companionWork");
  assert.strictEqual(companionWorkCardLabelKey("clawd-alive-work-control-room.svg"), "animCompanionWorkControlRoom");
  assert.strictEqual(companionWorkCardLabelKey("clawd-alive-juggle-laptops.svg"), "animCompanionJuggleLaptops");
  assert.strictEqual(companionWorkCardLabelKey("my file.svg"), "animCompanionMyFile");
});

test("user overrides replace a ladder file wherever it appears in its group", () => {
  const patched = applyUserOverridesPatch(RAW, {
    companionWorkTiers: {
      working: { "coffee.svg": { file: "my-coffee.svg" }, "control.svg": { file: "my-control.svg" } },
      juggling: { "not-declared.svg": { file: "x.svg" } },
      sideways: { "control.svg": { file: "y.svg" } },
    },
  });
  assert.deepStrictEqual(patched.companionWorkTiers.working, [
    { minSessions: 4, files: ["my-control.svg"] },
    { minSessions: 1, variants: ["my-coffee.svg"] },
    { minSessions: 2, files: ["dual-a.svg", "dual-b.svg"], variants: ["my-coffee.svg"] },
  ]);
  // Only files the theme declares in that group are customizable.
  assert.deepStrictEqual(patched.companionWorkTiers.juggling, RAW.companionWorkTiers.juggling);
  assert.strictEqual(patched.companionWorkTiers.sideways, undefined);
  // The raw theme is never mutated.
  assert.deepStrictEqual(RAW.companionWorkTiers.working[0], { minSessions: 4, files: ["control.svg"] });
  // Without the block in the theme nothing is invented.
  assert.strictEqual(applyUserOverridesPatch({}, { companionWorkTiers: { working: { "a.svg": { file: "b.svg" } } } })
    .companionWorkTiers, undefined);
  assert.strictEqual(VARIANT_ALLOWED_KEYS.has("companionWorkTiers"), false);
});

test("override files join the asset whitelist; the base ladder stays readable for the cards", () => {
  const theme = themeLoader.loadTheme("clawd", {
    strict: true,
    overrides: { companionWorkTiers: { working: { "clawd-alive-work-control-room.svg": { file: "../x/clawd-alive-work-swamped.svg" } } } },
  });
  const tier4 = theme.companionWorkTiers.working.find((tier) => tier.minSessions === 4);
  assert.deepStrictEqual(tier4.files, ["clawd-alive-work-swamped.svg"]);
  assert.ok(collectRequiredAssetFiles(theme).every((file) => !/[\\/]/.test(file)));
  assert.ok(projectThemeVisualUsages(theme).some((usage) => usage.file === "clawd-alive-work-swamped.svg"));
  const base4 = theme._baseCompanionWorkTiers.working.find((tier) => tier.minSessions === 4);
  assert.deepStrictEqual(base4.files, ["clawd-alive-work-control-room.svg"]);

  const missing = themeLoader.validateThemeShape("clawd", {
    overrides: { companionWorkTiers: { juggling: { "clawd-alive-juggle-chaos.svg": { file: "no-such-work.svg" } } } },
  });
  assert.strictEqual(missing.ok, false);
  assert.ok(missing.errors.some((error) => error.includes("missing asset: no-such-work.svg")), missing.errors.join("; "));
});

test("prefs keep work tier overrides and drop unknown groups, timing and unsafe names", () => {
  const out = normalizeThemeOverrides({
    clawd: {
      companionWorkTiers: {
        working: {
          "clawd-alive-work-coffee.svg": { file: "a/b/mine.svg", durationMs: 1800, transition: { in: 1, out: 2 }, disabled: true },
          "../evil.svg": { file: "x.svg" },
          "clawd-alive-work-dual.svg": { file: ".." },
          "clawd-alive-work-trio.svg": "bad",
        },
        juggling: { "clawd-alive-juggle-chaos.svg": { file: "j.svg", sourceThemeId: "calico" } },
        sideways: { "a.svg": { file: "b.svg" } },
      },
    },
  }, {});
  assert.deepStrictEqual(out, {
    clawd: {
      companionWorkTiers: {
        working: { "clawd-alive-work-coffee.svg": { file: "mine.svg" } },
        juggling: { "clawd-alive-juggle-chaos.svg": { file: "j.svg", sourceThemeId: "calico" } },
      },
    },
  });
  assert.strictEqual(out.clawd.states, undefined, "not mistaken for legacy state entries");
});

test("the companion picks the replaced ladder file after a live reload", () => {
  let theme = themeLoader.loadTheme("clawd", { strict: true });
  const rt = createCompanionRuntime({ getTheme: () => theme, random: () => 0 });
  rt.configure({ enabled: true, memory: false });
  assert.strictEqual(rt.pickWorkVisual("working", { sessions: 1, subagents: 0, episode: 0 }), "clawd-alive-work-coffee.svg");
  theme = themeLoader.loadTheme("clawd", {
    strict: true,
    overrides: { companionWorkTiers: { working: { "clawd-alive-work-coffee.svg": { file: "clawd-alive-coffee.svg" } } } },
  });
  assert.strictEqual(rt.pickWorkVisual("working", { sessions: 1, subagents: 0, episode: 1 }), "clawd-alive-coffee.svg");
  rt.dispose();
});

test("a Settings override of the theme tier still wins over a replaced ladder file (P14)", () => {
  const theme = themeLoader.loadTheme("clawd", {
    strict: true,
    overrides: {
      tiers: { workingTiers: { "clawd-working-building.svg": { file: "clawd-working-debugger.svg" } } },
      companionWorkTiers: { working: { "clawd-alive-work-control-room.svg": { file: "clawd-alive-work-swamped.svg" } } },
    },
  });
  const rt = createCompanionRuntime({ getTheme: () => theme, random: () => 0.9 });
  rt.configure({ enabled: true, memory: false });
  const sessions = (n) => new Map(Array.from({ length: n }, (_, i) => [`s${i}`, { state: "working" }]));
  const resolve = (n) => getWorkingSvg({
    sessions: sessions(n),
    theme,
    stateSvgs: theme.states,
    pickWorkVisual: (state, info) => rt.pickWorkVisual(state, { ...info, episode: 0 }),
  });
  // 4 sessions reach the user-overridden 3+ theme tier: the user's file wins.
  assert.strictEqual(resolve(4), "clawd-working-debugger.svg");
  // Without that tier override the replaced ladder file plays.
  const plain = themeLoader.loadTheme("clawd", {
    strict: true,
    overrides: { companionWorkTiers: { working: { "clawd-alive-work-control-room.svg": { file: "clawd-alive-work-swamped.svg" } } } },
  });
  const rt2 = createCompanionRuntime({ getTheme: () => plain, random: () => 0.9 });
  rt2.configure({ enabled: true, memory: false });
  assert.strictEqual(getWorkingSvg({
    sessions: sessions(4),
    theme: plain,
    stateSvgs: plain.states,
    pickWorkVisual: (state, info) => rt2.pickWorkVisual(state, { ...info, episode: 0 }),
  }), "clawd-alive-work-swamped.svg");
  rt.dispose();
  rt2.dispose();
});

// ── setAnimationOverride (slotType "companionWorkTier") ──

function deps(snapshot, calls = []) {
  return {
    snapshot,
    activateTheme: (themeId, variantId, overrideMap) => calls.push({ themeId, variantId, overrideMap }),
  };
}

test("work tier overrides persist the file and reload the active theme", () => {
  const calls = [];
  const snapshot = { theme: "clawd", themeOverrides: { clawd: { companionAnimations: { greet: { file: "g.svg" } } } } };
  const result = themeOverrideCommands.setAnimationOverride({
    themeId: "clawd", slotType: "companionWorkTier", tierGroup: "working",
    originalFile: "clawd-alive-work-coffee.svg", file: "mine.svg",
  }, deps(snapshot, calls));
  assert.strictEqual(result.status, "ok", result.message);
  assert.deepStrictEqual(result.commit.themeOverrides.clawd, {
    companionAnimations: { greet: { file: "g.svg" } },
    companionWorkTiers: { working: { "clawd-alive-work-coffee.svg": { file: "mine.svg" } } },
  });
  assert.deepStrictEqual(calls, [{ themeId: "clawd", variantId: null, overrideMap: result.commit.themeOverrides.clawd }]);
});

test("work tier overrides reject bad groups, names and any timing", () => {
  const d = deps({ theme: "clawd", themeOverrides: {} });
  const base = { themeId: "clawd", slotType: "companionWorkTier", tierGroup: "juggling", originalFile: "clawd-alive-juggle-chaos.svg" };
  for (const payload of [
    { ...base, file: "" },
    { ...base, file: 42 },
    { ...base, tierGroup: "workingTiers", file: "x.svg" },
    { ...base, tierGroup: "__proto__", file: "x.svg" },
    { ...base, originalFile: "", file: "x.svg" },
    { ...base, originalFile: "../a.svg", file: "x.svg" },
    { ...base, originalFile: "__proto__", file: "x.svg" },
    { ...base, transition: { in: 10, out: 10 } },
    { ...base, autoReturnMs: 2000 },
    { ...base, durationMs: 1000 },
  ]) {
    assert.strictEqual(themeOverrideCommands.setAnimationOverride(payload, d).status, "error", JSON.stringify(payload));
  }
});

test("restoring a work tier card clears its entry; other commands keep the block", () => {
  const companionWorkTiers = {
    working: { "clawd-alive-work-coffee.svg": { file: "a.svg" } },
    juggling: { "clawd-alive-juggle-chaos.svg": { file: "b.svg" } },
  };
  const snapshot = { theme: "clawd", themeOverrides: { clawd: { companionWorkTiers } } };
  const restored = themeOverrideCommands.setAnimationOverride({
    themeId: "clawd", slotType: "companionWorkTier", tierGroup: "working",
    originalFile: "clawd-alive-work-coffee.svg", file: null, transition: null,
  }, deps(snapshot));
  assert.strictEqual(restored.status, "ok", restored.message);
  assert.deepStrictEqual(restored.commit.themeOverrides.clawd, {
    companionWorkTiers: { juggling: { "clawd-alive-juggle-chaos.svg": { file: "b.svg" } } },
  });
  const sound = themeOverrideCommands.setSoundOverride({ themeId: "clawd", soundName: "complete", file: "c.mp3" }, deps(snapshot));
  assert.deepStrictEqual(sound.commit.themeOverrides.clawd.companionWorkTiers, companionWorkTiers);
  const companion = themeOverrideCommands.setAnimationOverride(
    { themeId: "clawd", slotType: "companion", companionKey: "greet", file: "g.svg" }, deps(snapshot));
  assert.deepStrictEqual(companion.commit.themeOverrides.clawd.companionWorkTiers, companionWorkTiers);
  const disabled = themeOverrideCommands.setThemeOverrideDisabled(
    { themeId: "clawd", stateKey: "error", disabled: true }, deps(snapshot));
  assert.deepStrictEqual(disabled.commit.themeOverrides.clawd.companionWorkTiers, companionWorkTiers);
  assert.strictEqual(disabled.commit.themeOverrides.clawd.states.companionWorkTiers, undefined);
});

test("import round-trips work tier overrides and drops unsafe entries", () => {
  const result = themeOverrideCommands.importAnimationOverrides({
    version: 1,
    themes: {
      clawd: {
        companionWorkTiers: {
          working: { "clawd-alive-work-trio.svg": { file: "t.svg" }, "x/../y.svg": { file: "z.svg" } },
          juggling: { "clawd-alive-juggle-laptops.svg": { file: "../../evil/l.svg" } },
        },
      },
    },
  }, deps({ theme: "clawd", themeOverrides: {} }));
  assert.strictEqual(result.status, "ok", result.message);
  assert.deepStrictEqual(result.commit.themeOverrides.clawd, {
    companionWorkTiers: {
      working: { "clawd-alive-work-trio.svg": { file: "t.svg" } },
      juggling: { "clawd-alive-juggle-laptops.svg": { file: "l.svg" } },
    },
  });
});

// ---- gap hunting (settings): S6 / S7 and normalizer edges ----
test("work tier command tolerates null timing keys and a null transition (S6)", () => {
  const d = deps({ theme: "clawd", themeOverrides: {} });
  const base = { themeId: "clawd", slotType: "companionWorkTier", tierGroup: "working", originalFile: "clawd-alive-work-coffee.svg" };
  for (const extra of [{ autoReturnMs: null }, { durationMs: null }, { transition: null }, { autoReturnMs: null, durationMs: null, transition: null }]) {
    const result = themeOverrideCommands.setAnimationOverride({ ...base, file: "mine.svg", ...extra }, d);
    assert.strictEqual(result.status, "ok", `${JSON.stringify(extra)} ${result.message}`);
    assert.deepStrictEqual(result.commit.themeOverrides.clawd.companionWorkTiers.working["clawd-alive-work-coffee.svg"], { file: "mine.svg" });
  }
  // Non-null timing still refused.
  assert.strictEqual(themeOverrideCommands.setAnimationOverride({ ...base, file: "m.svg", durationMs: 1000 }, d).status, "error");
  assert.strictEqual(themeOverrideCommands.setAnimationOverride({ ...base, file: "m.svg", autoReturnMs: 1000 }, d).status, "error");
});

test("work tier command keeps an orphan originalFile override (S6, pinned)", () => {
  const d = deps({ theme: "clawd", themeOverrides: {} });
  const result = themeOverrideCommands.setAnimationOverride({
    themeId: "clawd", slotType: "companionWorkTier", tierGroup: "working",
    originalFile: "not-in-the-ladder.svg", file: "mine.svg",
  }, d);
  assert.strictEqual(result.status, "ok", result.message);
  assert.deepStrictEqual(result.commit.themeOverrides.clawd.companionWorkTiers,
    { working: { "not-in-the-ladder.svg": { file: "mine.svg" } } });
  // The patch ignores it: no ladder entry matches.
  const patched = applyUserOverridesPatch(RAW, result.commit.themeOverrides.clawd);
  const baseline = applyUserOverridesPatch(RAW, {});
  assert.deepStrictEqual(patched.companionWorkTiers, baseline.companionWorkTiers);
});

test("prefs reject backslash, dot names and over-long names for work tier files and keys (S7)", () => {
  const long = `${"a".repeat(300)}.svg`;
  const out = normalizeThemeOverrides({
    clawd: {
      companionWorkTiers: {
        working: {
          "a\\b.svg": { file: "x.svg" },
          "..": { file: "x.svg" },
          ".": { file: "x.svg" },
          [long]: { file: "x.svg" },
          "a/b.svg": { file: "x.svg" },
          "": { file: "x.svg" },
          "ok-1.svg": { file: "a\\b.svg" },
          "ok-2.svg": { file: long },
          "ok-3.svg": { file: "fine.svg" },
        },
      },
    },
  }, {});
  assert.deepStrictEqual(out, { clawd: { companionWorkTiers: { working: { "ok-3.svg": { file: "fine.svg" } } } } });
  assert.deepStrictEqual(normalizeThemeOverrides(JSON.parse('{"clawd":{"companionWorkTiers":{"working":{"__proto__":{"file":"x.svg"},"constructor":{"file":"x.svg"}}}}}'), {}), {});
});

test("prefs work tier shapes: array group, non-object entry, sourceThemeId only as string", () => {
  assert.deepStrictEqual(normalizeThemeOverrides({ clawd: { companionWorkTiers: { working: ["a.svg"] } } }, {}), {});
  assert.deepStrictEqual(normalizeThemeOverrides({ clawd: { companionWorkTiers: [] } }, {}), {});
  const out = normalizeThemeOverrides({ clawd: { companionWorkTiers: { working: {
    "a.svg": { file: "x.svg", sourceThemeId: 5 },
    "b.svg": { file: "y.svg", sourceThemeId: "calico" },
  } } } }, {});
  assert.deepStrictEqual(out.clawd.companionWorkTiers.working, { "a.svg": { file: "x.svg" }, "b.svg": { file: "y.svg", sourceThemeId: "calico" } });
});
