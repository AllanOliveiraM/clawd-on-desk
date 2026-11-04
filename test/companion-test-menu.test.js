"use strict";

const assert = require("node:assert");
const { describe, it } = require("node:test");

const {
  TEST_MENU_LABEL,
  shouldShowCompanionTestMenu,
  resolveCompanionTestGate,
  describeTestBlockReason,
  buildCompanionTestMenuItem,
} = require("../src/companion-test-menu");

const CATALOG = [
  { group: "Moods", id: "mood.content", label: "Content" },
  { group: "Mischief", id: "fetch", label: "Fetch: ball", variant: "ball" },
  { group: "Moods", id: "mood.tired", label: "Tired" },
  { group: "Mischief", id: "fetch", label: "Fetch: sock", variant: "sock" },
  { group: "Sleep", id: "sleep.nap", label: "Nap" },
];

describe("companion test menu visibility (spec §2)", () => {
  it("dev builds always show it while Clawd Alive is on", () => {
    assert.strictEqual(shouldShowCompanionTestMenu({ isPackaged: false, shiftKey: false, companionEnabled: true }), true);
    assert.strictEqual(shouldShowCompanionTestMenu({ isPackaged: false, shiftKey: true, companionEnabled: true }), true);
  });

  it("packaged builds need Shift + right-click", () => {
    assert.strictEqual(shouldShowCompanionTestMenu({ isPackaged: true, shiftKey: false, companionEnabled: true }), false);
    assert.strictEqual(shouldShowCompanionTestMenu({ isPackaged: true, shiftKey: true, companionEnabled: true }), true);
  });

  it("never shows with Clawd Alive off", () => {
    for (const isPackaged of [true, false]) {
      for (const shiftKey of [true, false]) {
        assert.strictEqual(shouldShowCompanionTestMenu({ isPackaged, shiftKey, companionEnabled: false }), false);
      }
    }
  });

  it("only strict booleans open the gate", () => {
    assert.strictEqual(shouldShowCompanionTestMenu({ isPackaged: true, shiftKey: "yes", companionEnabled: true }), false);
    assert.strictEqual(shouldShowCompanionTestMenu({ isPackaged: false, shiftKey: false, companionEnabled: 1 }), false);
    assert.strictEqual(shouldShowCompanionTestMenu(), false);
    // Unknown packaging counts as packaged (the stricter side).
    assert.strictEqual(shouldShowCompanionTestMenu({ shiftKey: false, companionEnabled: true }), false);
  });
});

describe("companion test gate", () => {
  it("maps the blocking conditions in priority order", () => {
    assert.strictEqual(resolveCompanionTestGate({}), null);
    assert.strictEqual(resolveCompanionTestGate({ companionEnabled: false }), "disabled");
    assert.strictEqual(resolveCompanionTestGate({ agentBusy: true, permission: true, dnd: true, mini: true }), "agent-busy");
    assert.strictEqual(resolveCompanionTestGate({ permission: true, dnd: true, mini: true }), "permission");
    assert.strictEqual(resolveCompanionTestGate({ dnd: true, mini: true }), "dnd");
    assert.strictEqual(resolveCompanionTestGate({ mini: true }), "mini");
  });

  it("describes every runtime reason in English", () => {
    assert.strictEqual(describeTestBlockReason("agent-busy"), "busy: agent working");
    for (const reason of ["agent-busy", "permission", "dnd", "mini", "sleeping", "disabled", "missing-art", "no-roam"]) {
      const text = describeTestBlockReason(reason);
      assert.match(text, /^[\x20-\x7e]+$/, reason);
    }
    assert.strictEqual(describeTestBlockReason("weird"), "unavailable");
  });
});

describe("companion test submenu", () => {
  function build(overrides = {}) {
    const calls = [];
    const item = buildCompanionTestMenuItem({
      catalog: CATALOG,
      gateReason: null,
      play: (id, opts) => { calls.push([id, opts]); return { ok: true }; },
      runAfterMenuClose: (fn) => fn(),
      ...overrides,
    });
    return { item, calls };
  }

  it("groups catalog entries in first-seen order", () => {
    const { item } = build();
    assert.strictEqual(item.label, TEST_MENU_LABEL);
    assert.strictEqual(TEST_MENU_LABEL, "Test animations");
    assert.deepStrictEqual(item.submenu.map((g) => g.label), ["Moods", "Mischief", "Sleep"]);
    assert.deepStrictEqual(item.submenu[0].submenu.map((i) => i.label), ["Content", "Tired"]);
    assert.deepStrictEqual(item.submenu[1].submenu.map((i) => i.label), ["Fetch: ball", "Fetch: sock"]);
  });

  it("each item plays its id (and variant) through the after-close runner", () => {
    const deferred = [];
    const { item, calls } = build({ runAfterMenuClose: (fn) => deferred.push(fn) });
    item.submenu[1].submenu[1].click();
    item.submenu[0].submenu[0].click();
    assert.deepStrictEqual(calls, [], "nothing plays while the menu is open");
    deferred.forEach((fn) => fn());
    assert.deepStrictEqual(calls, [
      ["fetch", { variant: "sock" }],
      ["mood.content", {}],
    ]);
  });

  it("disables every item with the reason while the gate is closed", () => {
    const { item, calls } = build({ gateReason: "agent-busy" });
    for (const group of item.submenu) {
      for (const entry of group.submenu) {
        assert.strictEqual(entry.enabled, false);
        assert.match(entry.label, / \(busy: agent working\)$/);
      }
    }
    assert.deepStrictEqual(calls, []);
  });

  it("shows a single disabled placeholder when the runtime offers no catalog", () => {
    for (const catalog of [[], null, undefined, "nope"]) {
      const { item } = build({ catalog });
      assert.strictEqual(item.submenu.length, 1);
      assert.strictEqual(item.submenu[0].enabled, false);
    }
  });

  it("skips malformed catalog rows", () => {
    const { item } = build({ catalog: [null, { group: "Moods" }, { id: "x", label: "X" }, { group: "G", id: "ok", label: "Ok" }] });
    assert.deepStrictEqual(item.submenu.map((g) => g.label), ["G"]);
  });

  it("survives a throwing play", () => {
    const warnings = [];
    const { item } = build({
      play: () => { throw new Error("boom"); },
      logWarn: (msg) => warnings.push(msg),
    });
    assert.doesNotThrow(() => item.submenu[0].submenu[0].click());
    assert.strictEqual(warnings.length, 1);
  });

  it("logs a refused play with its reason", () => {
    const warnings = [];
    const { item } = build({
      play: () => ({ ok: false, reason: "missing-art" }),
      logWarn: (msg) => warnings.push(msg),
    });
    item.submenu[0].submenu[0].click();
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /missing art/);
  });

  // ── gap-hunting ──
  it("variant only travels when it is a non-empty string", () => {
    const calls = [];
    const item = buildCompanionTestMenuItem({
      catalog: [
        { group: "G", id: "a", label: "A", variant: "" },
        { group: "G", id: "b", label: "B", variant: 3 },
        { group: "G", id: "c", label: "C", variant: "ball" },
      ],
      play: (id, opts) => { calls.push([id, opts]); return { ok: true }; },
    });
    for (const entry of item.submenu[0].submenu) entry.click();
    assert.deepStrictEqual(calls, [["a", {}], ["b", {}], ["c", { variant: "ball" }]]);
  });

  it("rows sharing an id and group stay separate items", () => {
    const item = buildCompanionTestMenuItem({
      catalog: [
        { group: "G", id: "fetch", label: "Ball", variant: "ball" },
        { group: "G", id: "fetch", label: "Sock", variant: "sock" },
      ],
      play: () => ({ ok: true }),
    });
    assert.deepStrictEqual(item.submenu[0].submenu.map((e) => e.label), ["Ball", "Sock"]);
  });

  it("empty strings and non-string fields drop the row; an all-bad catalog shows the placeholder", () => {
    const item = buildCompanionTestMenuItem({
      catalog: [
        { group: "", id: "a", label: "A" },
        { group: "G", id: "", label: "B" },
        { group: "G", id: "c", label: "" },
        { group: 1, id: "d", label: "D" },
        [],
        "row",
      ],
    });
    assert.strictEqual(item.submenu.length, 1);
    assert.strictEqual(item.submenu[0].enabled, false);
    assert.strictEqual(item.submenu[0].label, "No test animations available");
  });

  it("an unknown gate reason or a refusal without a reason reads as unavailable", () => {
    const gated = buildCompanionTestMenuItem({ catalog: CATALOG, gateReason: "weird", play: () => {} });
    assert.match(gated.submenu[0].submenu[0].label, / \(unavailable\)$/);
    const warnings = [];
    const item = buildCompanionTestMenuItem({
      catalog: CATALOG,
      play: () => ({ ok: false }),
      logWarn: (m) => warnings.push(m),
    });
    item.submenu[0].submenu[0].click();
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /unavailable/);
  });

  it("a missing play and an ok result stay silent", () => {
    const warnings = [];
    const bare = buildCompanionTestMenuItem({ catalog: CATALOG, logWarn: (m) => warnings.push(m) });
    assert.doesNotThrow(() => bare.submenu[0].submenu[0].click());
    const ok = buildCompanionTestMenuItem({ catalog: CATALOG, play: () => ({ ok: true }), logWarn: (m) => warnings.push(m) });
    ok.submenu[0].submenu[0].click();
    assert.deepStrictEqual(warnings, []);
  });

  it("the runner decides when play happens", () => {
    const queued = [];
    const calls = [];
    const item = buildCompanionTestMenuItem({
      catalog: CATALOG,
      play: (id) => { calls.push(id); return { ok: true }; },
      runAfterMenuClose: (fn) => queued.push(fn),
    });
    item.submenu[0].submenu[0].click();
    assert.deepStrictEqual(calls, []);
    queued[0]();
    assert.deepStrictEqual(calls, ["mood.content"]);
  });
});
