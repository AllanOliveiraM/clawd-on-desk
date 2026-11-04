"use strict";

// Clawd Alive theme + art invariants: schema normalizer robustness and the
// shape of the built-in clawd companion art.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const schema = require("../src/theme-schema");
const themeLoader = require("../src/theme-loader");

const ROOT = path.join(__dirname, "..");
themeLoader.init(path.join(ROOT, "src"));
const SVG_DIR = path.join(ROOT, "assets", "svg");
const raw = JSON.parse(fs.readFileSync(path.join(ROOT, "themes", "clawd", "theme.json"), "utf8"));

test("dot basenames are rejected by the animation and tier normalizers (T1)", () => {
  const anims = schema.normalizeCompanionAnimations({
    petting: { file: ".." },
    content: { file: "." },
    tired: { files: ["..", ".", "ok.svg"] },
    shy: { file: "x/.." },
  });
  assert.deepEqual(Object.keys(anims), ["tired"]);
  assert.deepEqual(anims.tired.files, ["ok.svg"]);
  const tiers = schema.normalizeCompanionWorkTiers({
    working: [{ minSessions: 1, files: [".."] }, { minSessions: 2, files: ["..", "a.svg"], variants: ["."] }],
    juggling: [{ minSessions: 1, variants: ["x/.."] }],
  });
  assert.equal(tiers.working.length, 1);
  assert.deepEqual(tiers.working[0].files, ["a.svg"]);
  assert.deepEqual(tiers.working[0].variants, []);
  assert.equal(tiers.juggling.length, 0);
});
