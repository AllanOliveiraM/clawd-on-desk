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
    ]);
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

  it("built-in clawd declares all seven", () => {
    const theme = themeLoader.loadTheme("clawd", { strict: true });
    assert.deepStrictEqual(theme.companionAnimations, {
      petting: { files: ["clawd-alive-petting.svg"], duration: null },
      content: { files: ["clawd-alive-content.svg"], duration: 3500 },
      tired: { files: ["clawd-alive-tired.svg"], duration: 4000 },
      shy: { files: ["clawd-alive-shy.svg"], duration: 3000 },
      grumpy: { files: ["clawd-alive-grumpy.svg"], duration: 3500 },
      curious: { files: ["clawd-alive-curious.svg"], duration: 4000 },
      greet: { files: ["clawd-alive-greet.svg"], duration: 2500 },
    });
    assert.deepStrictEqual(Object.keys(theme.companionAnimations), [...schema.COMPANION_ANIMATION_KEYS]);
    const required = schema.collectRequiredAssetFiles(theme);
    for (const key of schema.COMPANION_ANIMATION_KEYS) {
      const file = `clawd-alive-${key}.svg`;
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
