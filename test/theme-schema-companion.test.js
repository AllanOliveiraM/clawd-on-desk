"use strict";

const { describe, it, mock, afterEach } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const schema = require("../src/theme-schema");
const { applyVariantPatch, VARIANT_ALLOWED_KEYS } = require("../src/theme-variants");
const themeLoader = require("../src/theme-loader");

themeLoader.init(path.join(__dirname, "..", "src"));

afterEach(() => {
  mock.restoreAll();
});

function validThemeJson(overrides = {}) {
  return {
    schemaVersion: 1,
    name: "Test",
    version: "1.0.0",
    viewBox: { x: 0, y: 0, width: 100, height: 100 },
    states: {
      idle: ["idle.svg"],
      yawning: ["yawning.svg"],
      dozing: ["dozing.svg"],
      collapsing: ["collapsing.svg"],
      thinking: ["thinking.svg"],
      working: ["working.svg"],
      sleeping: ["sleeping.svg"],
      waking: ["waking.svg"],
    },
    ...overrides,
  };
}

describe("theme companionAnimations block", () => {
  it("exports the companion animation keys", () => {
    assert.deepStrictEqual(schema.COMPANION_ANIMATION_KEYS, [
      "petting", "content", "tired", "shy", "grumpy", "curious", "greet",
      ...schema.MISCHIEF_ANIMATION_KEYS,
      ...schema.POLISH_ANIMATION_KEYS,
      ...schema.TRANSITION_ANIMATION_KEYS,
      ...schema.FETCH_ANIMATION_KEYS,
      ...schema.SEARCH_MOUSE_ANIMATION_KEYS,
    ]);
    assert.deepStrictEqual(schema.MISCHIEF_ANIMATION_KEYS, [
      "catch", "catchMiss", "pounceLeft", "pounceRight", "fakeNap", "boo",
      "pokeLeft", "pokeRight", "reachClose", "wallPushLeft", "wallPushRight",
      "wallPeekLeft", "wallPeekRight", "sitEdge", "morningStretch", "coffee",
      "nightSleepy", "welcome", "stretchBack", "toyBall", "toyYoyo", "toyPlane",
    ]);
  });

  it("exports the polish keys (directional catches, strikes, mirrors, walk variants, dreamy sleep) after mischief", () => {
    assert.deepStrictEqual(schema.POLISH_ANIMATION_KEYS, [
      "catchHigh", "catchBody", "catchLow", "catchLeft", "catchRight",
      "catchMissHigh", "catchMissBody", "catchMissLow", "catchMissLeft", "catchMissRight",
      "pounceStrikeLeft", "pounceStrikeRight",
      "greetLeft", "shyRight", "reachCloseLeft",
      "walkBouncy", "walkTired", "walkCurious",
      "sleepTwitch", "collapseSleepTwitch",
    ]);
    assert.deepStrictEqual(schema.COMPANION_ANIMATION_KEYS.slice(-41, -21), [...schema.POLISH_ANIMATION_KEYS]);
    const block = {};
    for (const key of schema.POLISH_ANIMATION_KEYS) block[key] = { file: `../x/${key}.svg`, duration: 1400 };
    const theme = schema.mergeDefaults(validThemeJson({ companionAnimations: block }), "test", false);
    for (const key of schema.POLISH_ANIMATION_KEYS) {
      assert.deepStrictEqual(theme.companionAnimations[key], { files: [`${key}.svg`], duration: 1400 }, key);
    }
    assert.deepStrictEqual(schema.mergeDefaults(validThemeJson(), "test", false).companionAnimations, {});
  });

  it("exports the intro / outro part keys last (sit, fake nap, petting)", () => {
    assert.deepStrictEqual(schema.TRANSITION_ANIMATION_KEYS, [
      "sitDown", "standUp", "fakeNapIn", "fakeNapOut", "pettingIn", "pettingOut",
    ]);
    assert.deepStrictEqual(schema.COMPANION_ANIMATION_KEYS.slice(-21, -15), [...schema.TRANSITION_ANIMATION_KEYS]);
    const block = {};
    for (const key of schema.TRANSITION_ANIMATION_KEYS) block[key] = { file: `../x/${key}.svg`, duration: 250 };
    const theme = schema.mergeDefaults(validThemeJson({ companionAnimations: block }), "test", false);
    for (const key of schema.TRANSITION_ANIMATION_KEYS) {
      assert.deepStrictEqual(theme.companionAnimations[key], { files: [`${key}.svg`], duration: 250 }, key);
    }
  });

  it("exports the fetch pairs and searchMouse last, optional and basenamed", () => {
    assert.deepStrictEqual(schema.FETCH_ANIMATION_KEYS, [
      "fetchExitLeft", "fetchExitRight",
      "fetchCursorLeft", "fetchCursorRight", "fetchDuckLeft", "fetchDuckRight",
      "fetchEnterLeft", "fetchEnterRight", "fetchBugLeft", "fetchBugRight",
      "fetchBoxLeft", "fetchBoxRight", "fetchSockLeft", "fetchSockRight",
    ]);
    assert.deepStrictEqual(schema.SEARCH_MOUSE_ANIMATION_KEYS, ["searchMouse"]);
    assert.deepStrictEqual(schema.COMPANION_ANIMATION_KEYS.slice(-15), [
      ...schema.FETCH_ANIMATION_KEYS, ...schema.SEARCH_MOUSE_ANIMATION_KEYS,
    ]);
    const block = {};
    for (const key of schema.COMPANION_ANIMATION_KEYS.slice(-15)) block[key] = { file: `../x/${key}.svg`, duration: 7000 };
    const theme = schema.mergeDefaults(validThemeJson({ companionAnimations: block }), "test", false);
    for (const key of schema.COMPANION_ANIMATION_KEYS.slice(-15)) {
      assert.deepStrictEqual(theme.companionAnimations[key], { files: [`${key}.svg`], duration: 7000 }, key);
    }
  });

  it("mischief keys are optional and basenamed", () => {
    const bare = schema.mergeDefaults(validThemeJson(), "test", false);
    assert.deepStrictEqual(bare.companionAnimations, {});
    const block = {};
    for (const key of schema.MISCHIEF_ANIMATION_KEYS) block[key] = { file: `../x/${key}.svg`, duration: 900 };
    const theme = schema.mergeDefaults(validThemeJson({ companionAnimations: block }), "test", false);
    for (const key of schema.MISCHIEF_ANIMATION_KEYS) {
      assert.deepStrictEqual(theme.companionAnimations[key], { files: [`${key}.svg`], duration: 900 }, key);
    }
  });

  it("companionAnimations is optional", () => {
    const theme = schema.mergeDefaults(validThemeJson(), "test", false);
    assert.deepStrictEqual(theme.companionAnimations, {});
    assert.deepStrictEqual(schema.validateTheme(validThemeJson()), []);
  });

  it("accepts {file} and {files} entries with optional duration", () => {
    const theme = schema.mergeDefaults(validThemeJson({
      companionAnimations: {
        petting: { file: "pet.svg" },
        content: { files: ["a.svg", "b.svg"], duration: 3500 },
      },
    }), "test", false);
    assert.deepStrictEqual(theme.companionAnimations, {
      petting: { files: ["pet.svg"], duration: null },
      content: { files: ["a.svg", "b.svg"], duration: 3500 },
    });
  });

  it("unknown keys and empty entries are dropped", () => {
    const theme = schema.mergeDefaults(validThemeJson({
      companionAnimations: {
        dance: { file: "dance.svg" },
        petting: {},
        content: { files: [] },
        tired: { file: "" },
        shy: null,
        grumpy: "grumpy.svg",
        curious: { files: [12, "", "curious.svg"], duration: -5 },
      },
    }), "test", false);
    assert.deepStrictEqual(theme.companionAnimations, {
      curious: { files: ["curious.svg"], duration: null },
    });
  });

  it("non-object block normalizes to {}", () => {
    for (const value of [null, [], "x", 3]) {
      const theme = schema.mergeDefaults(validThemeJson({ companionAnimations: value }), "test", false);
      assert.deepStrictEqual(theme.companionAnimations, {});
    }
  });

  it("files are basenamed", () => {
    const theme = schema.mergeDefaults(validThemeJson({
      companionAnimations: {
        petting: { file: "../x/evil.svg" },
        content: { files: ["..\\y\\other.svg"] },
      },
    }), "test", false);
    assert.deepStrictEqual(theme.companionAnimations.petting.files, ["evil.svg"]);
    assert.deepStrictEqual(theme.companionAnimations.content.files, ["other.svg"]);
  });

  it("companion files are required assets", () => {
    const theme = schema.mergeDefaults(validThemeJson({
      companionAnimations: {
        petting: { file: "pet.svg" },
        content: { files: ["calm-a.svg", "calm-b.svg"] },
        bogus: { file: "ignored.svg" },
      },
    }), "test", false);
    const files = schema.collectRequiredAssetFiles(theme);
    assert.ok(files.includes("pet.svg"));
    assert.ok(files.includes("calm-a.svg"));
    assert.ok(files.includes("calm-b.svg"));
    assert.ok(!files.includes("ignored.svg"));
    const usages = schema.projectThemeVisualUsages(theme);
    assert.ok(usages.some((u) => u.file === "pet.svg" && u.stateFamily === "companion:petting"));
  });

  it("theme variants cannot override companionAnimations", () => {
    assert.strictEqual(VARIANT_ALLOWED_KEYS.has("companionAnimations"), false);
    const warn = mock.method(console, "warn", () => {});
    const raw = validThemeJson({ companionAnimations: { petting: { file: "pet.svg" } } });
    const patched = applyVariantPatch(raw, {
      companionAnimations: { petting: { file: "hijack.svg" } },
    }, "test", "alt");
    assert.deepStrictEqual(patched.companionAnimations, { petting: { file: "pet.svg" } });
    assert.ok(warn.mock.calls.length >= 1);
  });

  it("built-in clawd declares every companion key", () => {
    const theme = themeLoader.loadTheme("clawd", { strict: true });
    const base = {
      petting: { files: ["clawd-alive-petting.svg"], duration: null },
      content: { files: ["clawd-alive-content.svg"], duration: 3500 },
      tired: { files: ["clawd-alive-tired.svg"], duration: 4000 },
      shy: { files: ["clawd-alive-shy.svg"], duration: 3000 },
      grumpy: { files: ["clawd-alive-grumpy.svg"], duration: 3500 },
      curious: { files: ["clawd-alive-curious.svg"], duration: 4000 },
      greet: { files: ["clawd-alive-greet.svg"], duration: 2500 },
      catch: { files: ["clawd-alive-catch.svg"], duration: 1600 },
      catchMiss: { files: ["clawd-alive-catch-miss.svg"], duration: 2200 },
      pounceLeft: { files: ["clawd-alive-pounce-left.svg"], duration: 2400 },
      pounceRight: { files: ["clawd-alive-pounce-right.svg"], duration: 2400 },
      fakeNap: { files: ["clawd-alive-fake-nap.svg"], duration: 3000 },
      boo: { files: ["clawd-alive-boo.svg"], duration: 1400 },
      pokeLeft: { files: ["clawd-alive-poke-left.svg"], duration: 2000 },
      pokeRight: { files: ["clawd-alive-poke-right.svg"], duration: 2000 },
      reachClose: { files: ["clawd-alive-reach-close.svg"], duration: 3000 },
      wallPushLeft: { files: ["clawd-alive-wall-push-left.svg"], duration: 2500 },
      wallPushRight: { files: ["clawd-alive-wall-push-right.svg"], duration: 2500 },
      wallPeekLeft: { files: ["clawd-alive-wall-peek-left.svg"], duration: 2500 },
      wallPeekRight: { files: ["clawd-alive-wall-peek-right.svg"], duration: 2500 },
      sitEdge: { files: ["clawd-alive-sit-edge.svg"], duration: 2000 },
      morningStretch: { files: ["clawd-alive-morning-stretch.svg"], duration: 2800 },
      coffee: { files: ["clawd-alive-coffee.svg"], duration: 3000 },
      nightSleepy: { files: ["clawd-alive-night-sleepy.svg"], duration: 3000 },
      welcome: { files: ["clawd-alive-welcome.svg"], duration: 2000 },
      stretchBack: { files: ["clawd-alive-stretch-back.svg"], duration: 2600 },
      toyBall: { files: ["clawd-alive-toy-ball.svg"], duration: 3000 },
      toyYoyo: { files: ["clawd-alive-toy-yoyo.svg"], duration: 3000 },
      toyPlane: { files: ["clawd-alive-toy-plane.svg"], duration: 3000 },
      catchHigh: { files: ["clawd-alive-catch-high.svg"], duration: 1400 },
      catchBody: { files: ["clawd-alive-catch-body.svg"], duration: 1600 },
      catchLow: { files: ["clawd-alive-catch-low.svg"], duration: 1600 },
      catchLeft: { files: ["clawd-alive-catch-left.svg"], duration: 1600 },
      catchRight: { files: ["clawd-alive-catch-right.svg"], duration: 1600 },
      catchMissHigh: { files: ["clawd-alive-catch-miss-high.svg"], duration: 2200 },
      catchMissBody: { files: ["clawd-alive-catch-miss-body.svg"], duration: 2200 },
      catchMissLow: { files: ["clawd-alive-catch-miss-low.svg"], duration: 2200 },
      catchMissLeft: { files: ["clawd-alive-catch-miss-left.svg"], duration: 2200 },
      catchMissRight: { files: ["clawd-alive-catch-miss-right.svg"], duration: 2200 },
      pounceStrikeLeft: { files: ["clawd-alive-pounce-strike-left.svg"], duration: 1800 },
      pounceStrikeRight: { files: ["clawd-alive-pounce-strike-right.svg"], duration: 1800 },
      greetLeft: { files: ["clawd-alive-greet-left.svg"], duration: 2500 },
      shyRight: { files: ["clawd-alive-shy-right.svg"], duration: 3000 },
      reachCloseLeft: { files: ["clawd-alive-reach-close-left.svg"], duration: 3000 },
      // Roam drives the walk visual for the whole walk; no duration is read.
      walkBouncy: { files: ["clawd-alive-walk-bouncy.svg"], duration: null },
      walkTired: { files: ["clawd-alive-walk-tired.svg"], duration: null },
      walkCurious: { files: ["clawd-alive-walk-curious.svg"], duration: null },
      // Replaces the sleeping visual for a whole sleep; one 18 s loop.
      sleepTwitch: { files: ["clawd-alive-sleep-twitch.svg"], duration: 18000 },
      // Replaces the collapse visual for a whole collapse sleep; one 18 s loop.
      collapseSleepTwitch: { files: ["clawd-alive-collapse-sleep-twitch.svg"], duration: 18000 },
      // One-shot intro / outro parts: played once for exactly their loop length.
      sitDown: { files: ["clawd-alive-sit-down.svg"], duration: 600 },
      standUp: { files: ["clawd-alive-stand-up.svg"], duration: 600 },
      fakeNapIn: { files: ["clawd-alive-fake-nap-in.svg"], duration: 500 },
      fakeNapOut: { files: ["clawd-alive-fake-nap-out.svg"], duration: 500 },
      pettingIn: { files: ["clawd-alive-petting-in.svg"], duration: 250 },
      pettingOut: { files: ["clawd-alive-petting-out.svg"], duration: 300 },
      // Fetch: one-shot exit, then the hauled object, each for its loop length.
      fetchExitLeft: { files: ["clawd-alive-fetch-exit-left.svg"], duration: 2000 },
      fetchExitRight: { files: ["clawd-alive-fetch-exit-right.svg"], duration: 2000 },
      fetchCursorLeft: { files: ["clawd-alive-fetch-cursor-left.svg"], duration: 7600 },
      fetchCursorRight: { files: ["clawd-alive-fetch-cursor-right.svg"], duration: 7600 },
      fetchDuckLeft: { files: ["clawd-alive-fetch-duck-left.svg"], duration: 7900 },
      fetchDuckRight: { files: ["clawd-alive-fetch-duck-right.svg"], duration: 7900 },
      fetchEnterLeft: { files: ["clawd-alive-fetch-enter-left.svg"], duration: 8000 },
      fetchEnterRight: { files: ["clawd-alive-fetch-enter-right.svg"], duration: 8000 },
      fetchBugLeft: { files: ["clawd-alive-fetch-bug-left.svg"], duration: 8000 },
      fetchBugRight: { files: ["clawd-alive-fetch-bug-right.svg"], duration: 8000 },
      fetchBoxLeft: { files: ["clawd-alive-fetch-box-left.svg"], duration: 8000 },
      fetchBoxRight: { files: ["clawd-alive-fetch-box-right.svg"], duration: 8000 },
      fetchSockLeft: { files: ["clawd-alive-fetch-sock-left.svg"], duration: 8000 },
      fetchSockRight: { files: ["clawd-alive-fetch-sock-right.svg"], duration: 8000 },
      searchMouse: { files: ["clawd-alive-search-mouse.svg"], duration: 3000 },
    };
    assert.deepStrictEqual(theme.companionAnimations, base);
    const declared = Object.keys(theme.companionAnimations);
    assert.deepStrictEqual(declared, [...schema.COMPANION_ANIMATION_KEYS]);
    const required = schema.collectRequiredAssetFiles(theme);
    for (const key of declared) {
      const [file] = theme.companionAnimations[key].files;
      assert.ok(required.includes(file), `${file} required`);
      assert.ok(theme.rendering.objectChannelFiles.includes(file), `${file} objectChannel`);
      assert.strictEqual(theme.rendering.discreteSampling[file], 24, `${file} discreteSampling`);
      assert.ok(theme.customization.accessories.files[file], `${file} accessories`);
      assert.ok(theme.customization.mouthAccessories.files[file], `${file} mouthAccessories`);
    }
  });

  it("calico and cloudling declare none", () => {
    for (const id of ["calico", "cloudling"]) {
      const theme = themeLoader.loadTheme(id, { strict: true });
      assert.deepStrictEqual(theme.companionAnimations, {}, id);
    }
  });
});
