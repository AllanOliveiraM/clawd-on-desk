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
    ]);
    assert.deepStrictEqual(schema.MISCHIEF_ANIMATION_KEYS, [
      "catch", "catchMiss", "pounceLeft", "pounceRight", "fakeNap", "boo",
      "pokeLeft", "pokeRight", "reachClose", "wallPushLeft", "wallPushRight",
      "wallPeekLeft", "wallPeekRight", "sitEdge", "morningStretch", "coffee",
      "nightSleepy", "welcome", "stretchBack", "toyBall", "toyYoyo", "toyPlane",
    ]);
  });

  it("exports the polish keys (directional catches, strikes, mirrors, walk variants) after mischief", () => {
    assert.deepStrictEqual(schema.POLISH_ANIMATION_KEYS, [
      "catchHigh", "catchBody", "catchLow", "catchLeft", "catchRight",
      "catchMissHigh", "catchMissBody", "catchMissLow", "catchMissLeft", "catchMissRight",
      "pounceStrikeLeft", "pounceStrikeRight",
      "greetLeft", "shyRight", "reachCloseLeft",
      "walkBouncy", "walkTired", "walkCurious",
    ]);
    assert.deepStrictEqual(schema.COMPANION_ANIMATION_KEYS.slice(-18), [...schema.POLISH_ANIMATION_KEYS]);
    const block = {};
    for (const key of schema.POLISH_ANIMATION_KEYS) block[key] = { file: `../x/${key}.svg`, duration: 1400 };
    const theme = schema.mergeDefaults(validThemeJson({ companionAnimations: block }), "test", false);
    for (const key of schema.POLISH_ANIMATION_KEYS) {
      assert.deepStrictEqual(theme.companionAnimations[key], { files: [`${key}.svg`], duration: 1400 }, key);
    }
    assert.deepStrictEqual(schema.mergeDefaults(validThemeJson(), "test", false).companionAnimations, {});
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

  it("built-in clawd declares all mischief keys", () => {
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
    };
    for (const [key, entry] of Object.entries(base)) assert.deepStrictEqual(theme.companionAnimations[key], entry, key);
    // Polish keys are optional: the theme registers them as their art lands.
    const declared = Object.keys(theme.companionAnimations);
    assert.deepStrictEqual(declared, schema.COMPANION_ANIMATION_KEYS.filter((key) => declared.includes(key)));
    for (const key of [...schema.MISCHIEF_ANIMATION_KEYS]) assert.ok(declared.includes(key), key);
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
