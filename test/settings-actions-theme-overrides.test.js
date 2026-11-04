"use strict";

const test = require("node:test");
const assert = require("node:assert");

const themeOverrideCommands = require("../src/settings-actions-theme-overrides");

test("settings theme override actions expose the command surface", () => {
  assert.deepStrictEqual(Object.keys(themeOverrideCommands).sort(), [
    "ANIMATION_OVERRIDES_EXPORT_VERSION",
    "ONESHOT_OVERRIDE_STATES",
    "importAnimationOverrides",
    "resetThemeOverrides",
    "setAnimationOverride",
    "setSoundOverride",
    "setThemeOverrideDisabled",
    "setWideHitboxOverride",
  ]);
  assert.strictEqual(themeOverrideCommands.ANIMATION_OVERRIDES_EXPORT_VERSION, 1);
  assert.ok(themeOverrideCommands.ONESHOT_OVERRIDE_STATES.has("attention"));
});

test("settings theme override actions update an active state slot with explicit reload data", () => {
  const calls = [];
  const snapshot = {
    theme: "clawd",
    themeOverrides: {
      clawd: {
        hitbox: { wide: { "old.svg": true } },
        sounds: { complete: { file: "done.mp3" } },
      },
    },
  };

  const result = themeOverrideCommands.setAnimationOverride(
    {
      themeId: "clawd",
      slotType: "state",
      stateKey: "attention",
      file: "new-attention.svg",
      transition: { in: 80, out: 120 },
      autoReturnMs: 2500,
    },
    {
      snapshot,
      activateTheme: (themeId, variantId, overrideMap) => {
        calls.push({ themeId, variantId, overrideMap });
      },
    }
  );

  assert.strictEqual(result.status, "ok");
  assert.deepStrictEqual(result.commit.themeOverrides.clawd.states.attention, {
    file: "new-attention.svg",
    transition: { in: 80, out: 120 },
  });
  assert.deepStrictEqual(result.commit.themeOverrides.clawd.timings, {
    autoReturn: { attention: 2500 },
  });
  assert.deepStrictEqual(result.commit.themeOverrides.clawd.hitbox, snapshot.themeOverrides.clawd.hitbox);
  assert.deepStrictEqual(result.commit.themeOverrides.clawd.sounds, snapshot.themeOverrides.clawd.sounds);
  assert.deepStrictEqual(calls, [
    {
      themeId: "clawd",
      variantId: null,
      overrideMap: result.commit.themeOverrides.clawd,
    },
  ]);
});

test("settings theme override actions clear transition overrides that match the theme default", () => {
  const calls = [];
  const snapshot = {
    theme: "clawd",
    themeOverrides: {
      clawd: {
        states: {
          thinking: {
            transition: { in: 160, out: 150 },
          },
        },
      },
    },
  };

  const result = themeOverrideCommands.setAnimationOverride(
    {
      themeId: "clawd",
      slotType: "state",
      stateKey: "thinking",
      transition: { in: 150, out: 150 },
      transitionThemeDefault: { in: 150, out: 150 },
    },
    {
      snapshot,
      activateTheme: (themeId, variantId, overrideMap) => {
        calls.push({ themeId, variantId, overrideMap });
      },
    }
  );

  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.commit.themeOverrides.clawd, undefined);
  assert.deepStrictEqual(calls, [
    {
      themeId: "clawd",
      variantId: null,
      overrideMap: {},
    },
  ]);
});

test("settings theme override actions keep transition overrides that differ from the theme default", () => {
  const result = themeOverrideCommands.setAnimationOverride(
    {
      themeId: "clawd",
      slotType: "state",
      stateKey: "thinking",
      transition: { in: 160, out: 150 },
      transitionThemeDefault: { in: 150, out: 150 },
    },
    {
      snapshot: { theme: "other", themeOverrides: {} },
      activateTheme: () => {
        throw new Error("inactive theme should not reload");
      },
    }
  );

  assert.strictEqual(result.status, "ok");
  assert.deepStrictEqual(result.commit.themeOverrides.clawd.states.thinking, {
    transition: { in: 160, out: 150 },
  });
});

test("settings theme override actions preserve animation and hitbox data when changing sound overrides", () => {
  const snapshot = {
    theme: "calico",
    themeOverrides: {
      clawd: {
        states: { attention: { file: "attention.svg" } },
        reactions: { clickLeft: { file: "click.svg" } },
        hitbox: { wide: { "wide.svg": true } },
        sounds: { confirm: { file: "confirm.wav" } },
      },
    },
  };

  const result = themeOverrideCommands.setSoundOverride(
    { themeId: "clawd", soundName: "complete", file: "complete.mp3", originalName: "picked.mp3" },
    {
      snapshot,
      activateTheme: () => {
        throw new Error("inactive theme should not reload");
      },
    }
  );

  assert.strictEqual(result.status, "ok");
  assert.deepStrictEqual(result.commit.themeOverrides.clawd.states, snapshot.themeOverrides.clawd.states);
  assert.deepStrictEqual(result.commit.themeOverrides.clawd.reactions, snapshot.themeOverrides.clawd.reactions);
  assert.deepStrictEqual(result.commit.themeOverrides.clawd.hitbox, snapshot.themeOverrides.clawd.hitbox);
  assert.deepStrictEqual(result.commit.themeOverrides.clawd.sounds, {
    confirm: { file: "confirm.wav" },
    complete: { file: "complete.mp3", originalName: "picked.mp3" },
  });
});

test("settings theme override actions import active theme overrides with the committed map", () => {
  const calls = [];
  const payload = {
    version: 1,
    themes: {
      clawd: {
        states: {
          attention: { disabled: true },
        },
      },
    },
  };
  const snapshot = { theme: "clawd", themeOverrides: {} };

  const result = themeOverrideCommands.importAnimationOverrides(payload, {
    snapshot,
    activateTheme: (themeId, variantId, overrideMap) => {
      calls.push({ themeId, variantId, overrideMap });
    },
  });

  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.importedThemeCount, 1);
  assert.deepStrictEqual(calls, [
    {
      themeId: "clawd",
      variantId: null,
      overrideMap: result.commit.themeOverrides.clawd,
    },
  ]);
});

test("settings theme override actions reset an active theme by reloading without overrides", () => {
  const calls = [];
  const snapshot = {
    theme: "clawd",
    themeOverrides: {
      clawd: { states: { attention: { disabled: true } } },
      calico: { states: { error: { disabled: true } } },
    },
  };

  const result = themeOverrideCommands.resetThemeOverrides("clawd", {
    snapshot,
    activateTheme: (themeId, variantId, overrideMap) => {
      calls.push({ themeId, variantId, overrideMap });
    },
  });

  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.commit.themeOverrides.clawd, undefined);
  assert.ok(result.commit.themeOverrides.calico);
  assert.deepStrictEqual(calls, [
    { themeId: "clawd", variantId: null, overrideMap: null },
  ]);
});

// ── Clawd Alive companion animation overrides ──

function companionDeps(snapshot, calls = []) {
  return {
    snapshot,
    activateTheme: (themeId, variantId, overrideMap) => {
      calls.push({ themeId, variantId, overrideMap });
    },
  };
}

test("companion overrides persist file and duration and reload the active theme", () => {
  const calls = [];
  const snapshot = {
    theme: "clawd",
    themeOverrides: { clawd: { sounds: { complete: { file: "done.mp3" } } } },
  };
  const result = themeOverrideCommands.setAnimationOverride(
    { themeId: "clawd", slotType: "companion", companionKey: "greet", file: "my-greet.svg", durationMs: 1800 },
    companionDeps(snapshot, calls)
  );
  assert.strictEqual(result.status, "ok");
  assert.deepStrictEqual(result.commit.themeOverrides.clawd.companionAnimations, {
    greet: { file: "my-greet.svg", durationMs: 1800 },
  });
  assert.deepStrictEqual(result.commit.themeOverrides.clawd.sounds, { complete: { file: "done.mp3" } });
  assert.deepStrictEqual(calls, [
    { themeId: "clawd", variantId: null, overrideMap: result.commit.themeOverrides.clawd },
  ]);
});

test("companion overrides accept the short intro durations the theme authors", () => {
  const result = themeOverrideCommands.setAnimationOverride(
    { themeId: "clawd", slotType: "companion", companionKey: "pettingIn", durationMs: 250 },
    companionDeps({ theme: "calico", themeOverrides: {} })
  );
  assert.strictEqual(result.status, "ok");
  assert.deepStrictEqual(result.commit.themeOverrides.clawd.companionAnimations, {
    pettingIn: { durationMs: 250 },
  });
});

test("companion overrides reject invalid files, unknown keys and unsupported timing", () => {
  const deps = companionDeps({ theme: "clawd", themeOverrides: {} });
  const base = { themeId: "clawd", slotType: "companion", companionKey: "greet" };
  for (const payload of [
    { ...base, file: "" },
    { ...base, file: 42 },
    { ...base, companionKey: "nope", file: "x.svg" },
    { ...base, companionKey: "__proto__", file: "x.svg" },
    { ...base, transition: { in: 10, out: 10 } },
    { ...base, autoReturnMs: 2000 },
    { ...base, durationMs: 50 },
    { ...base, durationMs: 8001 },
    { ...base, durationMs: 60000 },
    { ...base, companionKey: "walkBouncy", durationMs: 1000 },
    { ...base, companionKey: "sleepTwitch", durationMs: 1000 },
  ]) {
    const result = themeOverrideCommands.setAnimationOverride(payload, deps);
    assert.strictEqual(result.status, "error", JSON.stringify(payload));
  }
});

test("restoring a companion card clears its entry, tolerating the generic transition reset", () => {
  const snapshot = {
    theme: "calico",
    themeOverrides: {
      clawd: {
        companionAnimations: { greet: { file: "my-greet.svg", durationMs: 1800 }, boo: { file: "b.svg" } },
      },
    },
  };
  const result = themeOverrideCommands.setAnimationOverride(
    { themeId: "clawd", slotType: "companion", companionKey: "greet", file: null, transition: null, durationMs: null },
    companionDeps(snapshot)
  );
  assert.strictEqual(result.status, "ok");
  assert.deepStrictEqual(result.commit.themeOverrides.clawd, { companionAnimations: { boo: { file: "b.svg" } } });
});

test("other override commands keep companion overrides intact", () => {
  const companionAnimations = { greet: { file: "my-greet.svg" } };
  const snapshot = { theme: "calico", themeOverrides: { clawd: { companionAnimations } } };
  const sound = themeOverrideCommands.setSoundOverride(
    { themeId: "clawd", soundName: "complete", file: "c.mp3" },
    companionDeps(snapshot)
  );
  assert.deepStrictEqual(sound.commit.themeOverrides.clawd.companionAnimations, companionAnimations);
  const state = themeOverrideCommands.setAnimationOverride(
    { themeId: "clawd", slotType: "state", stateKey: "attention", file: "a.svg" },
    companionDeps(snapshot)
  );
  assert.deepStrictEqual(state.commit.themeOverrides.clawd.companionAnimations, companionAnimations);
  assert.strictEqual(state.commit.themeOverrides.clawd.states.companionAnimations, undefined);
  const disabled = themeOverrideCommands.setThemeOverrideDisabled(
    { themeId: "clawd", stateKey: "error", disabled: true },
    companionDeps(snapshot)
  );
  assert.deepStrictEqual(disabled.commit.themeOverrides.clawd.companionAnimations, companionAnimations);
});

test("import round-trips companion overrides and drops unsafe entries", () => {
  const calls = [];
  const exported = {
    clawd: {
      companionAnimations: {
        greet: { file: "my-greet.svg", durationMs: 1800, transition: { in: 1, out: 1 } },
        boo: { file: "../../evil/boo.svg" },
        bogus: { file: "x.svg" },
        shy: { file: "" },
        petting: { file: "my-pet.svg", durationMs: 1e10 },
        content: { durationMs: 1e10 },
        tired: { file: "t.svg", durationMs: 50 },
        walkBouncy: { file: "w.svg", durationMs: 2000 },
      },
    },
  };
  const result = themeOverrideCommands.importAnimationOverrides(
    { version: 1, themes: JSON.parse(JSON.stringify(exported)) },
    companionDeps({ theme: "clawd", themeOverrides: {} }, calls)
  );
  assert.strictEqual(result.status, "ok");
  assert.deepStrictEqual(result.commit.themeOverrides.clawd, {
    companionAnimations: {
      greet: { file: "my-greet.svg", durationMs: 1800 },
      boo: { file: "boo.svg" },
      petting: { file: "my-pet.svg" },
      tired: { file: "t.svg" },
      walkBouncy: { file: "w.svg" },
    },
  });
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].overrideMap, result.commit.themeOverrides.clawd);
});

test("restore defaults clears companion overrides", () => {
  const calls = [];
  const snapshot = { theme: "clawd", themeOverrides: { clawd: { companionAnimations: { greet: { file: "g.svg" } } } } };
  const result = themeOverrideCommands.resetThemeOverrides("clawd", companionDeps(snapshot, calls));
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.commit.themeOverrides.clawd, undefined);
  assert.deepStrictEqual(calls, [{ themeId: "clawd", variantId: null, overrideMap: null }]);
});

// ── gap hunting (settings): companion command edges ──
test("companion command partial resets keep the other half", () => {
  const snapshot = { theme: "clawd", themeOverrides: { clawd: { companionAnimations: {
    greet: { file: "g.svg", sourceThemeId: "calico", durationMs: 1800 },
  } } } };
  const fileNull = themeOverrideCommands.setAnimationOverride(
    { themeId: "clawd", slotType: "companion", companionKey: "greet", file: null }, companionDeps(snapshot));
  assert.strictEqual(fileNull.status, "ok", fileNull.message);
  assert.deepStrictEqual(fileNull.commit.themeOverrides.clawd.companionAnimations, { greet: { durationMs: 1800 } });
  const durNull = themeOverrideCommands.setAnimationOverride(
    { themeId: "clawd", slotType: "companion", companionKey: "greet", durationMs: null }, companionDeps(snapshot));
  assert.deepStrictEqual(durNull.commit.themeOverrides.clawd.companionAnimations, { greet: { file: "g.svg", sourceThemeId: "calico" } });
  // key absent from the theme's override map: resetting is deterministic and leaves nothing behind
  const absent = themeOverrideCommands.setAnimationOverride(
    { themeId: "clawd", slotType: "companion", companionKey: "boo", file: null, durationMs: null },
    companionDeps({ theme: "clawd", themeOverrides: {} }));
  assert.strictEqual(absent.status, "ok", absent.message);
  assert.strictEqual(absent.noop, true);
  assert.strictEqual(absent.commit, undefined);
});

test("companion command duration boundaries", () => {
  const run = (durationMs, companionKey = "greet") => themeOverrideCommands.setAnimationOverride(
    { themeId: "clawd", slotType: "companion", companionKey, durationMs }, companionDeps({ theme: "clawd", themeOverrides: {} }));
  assert.strictEqual(run(100).status, "ok");
  assert.strictEqual(run(8000).status, "ok");
  for (const bad of [99, 8001, NaN, Infinity, "500", -1]) assert.strictEqual(run(bad).status, "error", String(bad));
  assert.strictEqual(run(0).status, "error");
  assert.strictEqual(run(1500, "fetchExitLeft").status, "ok");
  assert.strictEqual(run(1500, "searchMouse").status, "ok");
  assert.strictEqual(run(1500, "petting").status, "error");
});
