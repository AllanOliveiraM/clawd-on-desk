"use strict";

// Clawd Alive work escalation ladder: theme schema block + companion hook.
const { describe, it, mock, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const schema = require("../src/theme-schema");
const { applyVariantPatch, VARIANT_ALLOWED_KEYS } = require("../src/theme-variants");
const { createCompanionRuntime } = require("../src/companion-runtime");

afterEach(() => mock.restoreAll());

function validThemeJson(overrides = {}) {
  return {
    schemaVersion: 1,
    name: "Test",
    version: "1.0.0",
    viewBox: { x: 0, y: 0, width: 100, height: 100 },
    states: {
      idle: ["idle.svg"], yawning: ["yawning.svg"], dozing: ["dozing.svg"],
      collapsing: ["collapsing.svg"], thinking: ["thinking.svg"], working: ["working.svg"],
      sleeping: ["sleeping.svg"], waking: ["waking.svg"],
    },
    ...overrides,
  };
}

const LADDER = {
  working: [
    { minSessions: 1, files: ["typing.svg"], variants: ["coffee.svg"] },
    { minSessions: 2, files: ["headphones.svg"], variants: ["dual.svg"] },
    { minSessions: 3, files: ["building.svg"], variants: ["trio.svg"] },
    { minSessions: 4, files: ["control-room.svg"] },
    { minSessions: 5, files: ["swamped.svg"] },
    { minSessions: 6, files: ["chaos.svg"] },
  ],
  juggling: [
    { minSessions: 1, files: ["headphones.svg"] },
    { minSessions: 2, files: ["juggling.svg"] },
    { minSessions: 3, files: ["juggle-laptops.svg"] },
    { minSessions: 4, files: ["juggle-chaos.svg"] },
  ],
};

describe("theme companionWorkTiers block", () => {
  it("normalizes, sorts descending and basenames files and variants", () => {
    const theme = schema.mergeDefaults(validThemeJson({
      companionWorkTiers: {
        working: [
          { minSessions: 1, files: ["../../evil/typing.svg"], variants: ["C:\\x\\coffee.svg", 7, ""] },
          { minSessions: 3, file: "building.svg" },
          { minSessions: 2, variants: ["dual.svg"] },
          { minSessions: 0, files: ["zero.svg"] },
          { minSessions: "4", files: ["bad.svg"] },
          { minSessions: 5, files: [] },
          "junk",
        ],
        juggling: [{ minSessions: 2, files: ["juggling.svg"] }],
        bogus: [{ minSessions: 1, files: ["x.svg"] }],
      },
    }), "test", false);
    assert.deepStrictEqual(theme.companionWorkTiers, {
      working: [
        { minSessions: 3, files: ["building.svg"], variants: [] },
        { minSessions: 2, files: [], variants: ["dual.svg"] },
        { minSessions: 1, files: ["typing.svg"], variants: ["coffee.svg"] },
      ],
      juggling: [{ minSessions: 2, files: ["juggling.svg"], variants: [] }],
    });
  });

  it("is optional and tolerates garbage", () => {
    for (const value of [undefined, null, 3, "x", [], { working: "x" }]) {
      const theme = schema.mergeDefaults(validThemeJson(value === undefined ? {} : { companionWorkTiers: value }), "test", false);
      assert.deepStrictEqual(theme.companionWorkTiers, { working: [], juggling: [] }, JSON.stringify(value));
    }
  });

  it("files and variants are required assets and visual usages", () => {
    const theme = schema.mergeDefaults(validThemeJson({ companionWorkTiers: LADDER }), "test", false);
    const files = schema.collectRequiredAssetFiles(theme);
    for (const file of ["typing.svg", "coffee.svg", "trio.svg", "chaos.svg", "juggle-laptops.svg", "juggle-chaos.svg"]) {
      assert.ok(files.includes(file), file);
    }
    const usages = schema.projectThemeVisualUsages(theme);
    assert.ok(usages.some((u) => u.file === "coffee.svg" && u.stateFamily === "companion:workTiers.working"));
    assert.ok(usages.some((u) => u.file === "juggle-chaos.svg" && u.stateFamily === "companion:workTiers.juggling"));
    // Raw (unnormalized) theme objects project the same way.
    assert.ok(schema.collectRequiredAssetFiles(validThemeJson({ companionWorkTiers: LADDER })).includes("dual.svg"));
  });

  it("theme variants cannot override companionWorkTiers", () => {
    assert.equal(VARIANT_ALLOWED_KEYS.has("companionWorkTiers"), false);
    const warn = mock.method(console, "warn", () => {});
    const raw = validThemeJson({ companionWorkTiers: LADDER });
    const patched = applyVariantPatch(raw, {
      companionWorkTiers: { working: [{ minSessions: 1, files: ["hijack.svg"] }] },
    }, "test", "alt");
    assert.deepStrictEqual(patched.companionWorkTiers, LADDER);
    assert.ok(warn.mock.calls.length >= 1);
  });
});

function runtime({ theme = { companionWorkTiers: schema.normalizeCompanionWorkTiers(LADDER) }, rolls, enabled = true } = {}) {
  const counter = { rolls: 0 };
  const queue = Array.isArray(rolls) ? [...rolls] : null;
  const rt = createCompanionRuntime({
    getTheme: () => theme,
    random: () => {
      counter.rolls += 1;
      if (queue) return queue.length ? queue.shift() : 0.99;
      return typeof rolls === "function" ? rolls() : 0.99;
    },
    store: { load: () => ({ state: null, restSpot: null }), schedule() {}, flush() {}, remove() {}, dispose() {} },
  });
  if (enabled !== null) rt.configure({ enabled, personality: "balanced", autonomy: true, interactions: true, memory: false });
  return { rt, counter };
}

describe("companion pickWorkVisual", () => {
  it("picks the highest tier whose minSessions fits the count", () => {
    const { rt } = runtime();
    const cases = [
      ["working", 1, "typing.svg"], ["working", 2, "headphones.svg"], ["working", 3, "building.svg"],
      ["working", 4, "control-room.svg"], ["working", 5, "swamped.svg"], ["working", 6, "chaos.svg"],
      ["working", 11, "chaos.svg"],
      ["juggling", 1, "headphones.svg"], ["juggling", 2, "juggling.svg"],
      ["juggling", 3, "juggle-laptops.svg"], ["juggling", 9, "juggle-chaos.svg"],
    ];
    let episode = 0;
    for (const [state, count, file] of cases) {
      episode += 1;
      const info = state === "working"
        ? { sessions: count, subagents: 0, baseFile: "base.svg", episode }
        : { sessions: 1, subagents: count, baseFile: "base.svg", episode };
      assert.equal(rt.pickWorkVisual(state, info), file, `${state} ${count}`);
    }
  });

  it("uses a variant ~35% of the time with the injected random", () => {
    for (const [roll, file] of [[0, "coffee.svg"], [0.34, "coffee.svg"], [0.35, "typing.svg"], [0.9, "typing.svg"]]) {
      const { rt } = runtime({ rolls: [roll, 0] });
      assert.equal(rt.pickWorkVisual("working", { sessions: 1, subagents: 0, baseFile: "b.svg", episode: 1 }), file, `roll ${roll}`);
    }
    let seed = 4242;
    const { rt } = runtime({ rolls: () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; } });
    let hits = 0;
    for (let n = 0; n < 1000; n += 1) {
      if (rt.pickWorkVisual("working", { sessions: 2, subagents: 0, baseFile: "b.svg", episode: n }) === "dual.svg") hits += 1;
    }
    assert.ok(hits > 300 && hits < 400, `hits ${hits}`);
  });

  it("a tier without variants never rolls the variant chance", () => {
    const { rt, counter } = runtime({ rolls: () => 0 });
    assert.equal(rt.pickWorkVisual("working", { sessions: 4, subagents: 0, baseFile: "b.svg", episode: 1 }), "control-room.svg");
    assert.equal(counter.rolls, 0, "single file, no variants: no randomness");
  });

  it("a tier without files falls back to the theme's own tier file unless the variant hits", () => {
    const theme = { companionWorkTiers: schema.normalizeCompanionWorkTiers({ working: [{ minSessions: 1, variants: ["coffee.svg"] }] }) };
    assert.equal(runtime({ theme, rolls: [0.9] }).rt.pickWorkVisual("working", { sessions: 1, subagents: 0, baseFile: "base.svg", episode: 1 }), null);
    assert.equal(runtime({ theme, rolls: [0.1, 0] }).rt.pickWorkVisual("working", { sessions: 1, subagents: 0, baseFile: "base.svg", episode: 1 }), "coffee.svg");
  });

  it("holds its choice while the tier and episode stay the same", () => {
    const { rt, counter } = runtime({ rolls: [0.1, 0.9, 0.9, 0.1] });
    const ask = (sessions, episode) => rt.pickWorkVisual("working", { sessions, subagents: 0, baseFile: "b.svg", episode });
    assert.equal(ask(1, 1), "coffee.svg");
    for (let n = 0; n < 20; n += 1) assert.equal(ask(1, 1), "coffee.svg", "stable on repeated working events");
    assert.equal(counter.rolls, 1);
    assert.equal(ask(2, 1), "headphones.svg", "tier change re-rolls");
    assert.equal(ask(2, 1), "headphones.svg");
    assert.equal(ask(1, 1), "coffee.svg", "back to tier 1 keeps its pick within the episode");
    assert.equal(ask(2, 1), "headphones.svg", "and tier 2 keeps its pick");
    assert.equal(counter.rolls, 2, "1-2-1 oscillation never re-rolls");
    assert.equal(ask(1, 2), "typing.svg", "re-entering working re-rolls");
    assert.equal(ask(2, 2), "dual.svg", "a new episode re-rolls every tier");
    assert.equal(counter.rolls, 4);
  });

  it("working and juggling hold separate choices", () => {
    const { rt } = runtime({ rolls: [0.9, 0] });
    assert.equal(rt.pickWorkVisual("working", { sessions: 3, subagents: 3, baseFile: "b.svg", episode: 1 }), "building.svg");
    assert.equal(rt.pickWorkVisual("juggling", { sessions: 3, subagents: 3, baseFile: "b.svg", episode: 1 }), "juggle-laptops.svg");
    assert.equal(rt.pickWorkVisual("working", { sessions: 3, subagents: 3, baseFile: "b.svg", episode: 1 }), "building.svg");
  });

  it("feature off, disposed or never configured keeps the original tier file", () => {
    const info = { sessions: 6, subagents: 0, baseFile: "b.svg", episode: 1 };
    for (const enabled of [null, false]) {
      const { rt, counter } = runtime({ enabled, rolls: () => 0 });
      assert.equal(rt.pickWorkVisual("working", info), null, String(enabled));
      assert.equal(counter.rolls, 0);
    }
    const { rt } = runtime();
    rt.dispose();
    assert.equal(rt.pickWorkVisual("working", info), null, "disposed");
  });

  it("a theme without the block, without a matching tier or another state keeps the original", () => {
    for (const theme of [null, {}, { companionWorkTiers: { working: [], juggling: [] } }, { companionWorkTiers: "x" }]) {
      const { rt, counter } = runtime({ theme, rolls: () => 0 });
      assert.equal(rt.pickWorkVisual("working", { sessions: 3, subagents: 0, baseFile: "b.svg", episode: 1 }), null);
      assert.equal(counter.rolls, 0);
    }
    const { rt } = runtime();
    assert.equal(rt.pickWorkVisual("working", { sessions: 0, subagents: 0, baseFile: "b.svg", episode: 1 }), null, "below every tier");
    assert.equal(rt.pickWorkVisual("thinking", { sessions: 3, subagents: 0, baseFile: "b.svg", episode: 1 }), null);
    assert.equal(rt.pickWorkVisual("working"), null, "no info");
  });
});
