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

const aliveFiles = fs.readdirSync(SVG_DIR).filter((f) => /^clawd-alive-.*\.svg$/.test(f)).sort();
const read = (f) => fs.readFileSync(path.join(SVG_DIR, f), "utf8");
const USE_ALLOW = new Set(["clawd-alive-sleep-twitch.svg", "clawd-alive-collapse-sleep-twitch.svg"]);

test("every alive svg is script-free, url-free and has a viewBox (use allow-list T3)", () => {
  assert.ok(aliveFiles.length >= 78);
  for (const f of aliveFiles) {
    const s = read(f);
    assert.ok(/<svg\b[^>]*\bviewBox=/.test(s), `${f} viewBox`);
    assert.ok(!/<script\b/i.test(s), `${f} script`);
    assert.ok(!/\bon[a-z]+\s*=/i.test(s.replace(/<style[\s\S]*?<\/style>/gi, "")), `${f} handler`);
    assert.ok(!/url\(\s*['"]?\s*(https?:|data:|\/\/|file:)/i.test(s), `${f} external url`);
    assert.ok(!/<(image|foreignObject|iframe|embed)\b/i.test(s), `${f} embeds`);
    assert.ok(!/(href|src)\s*=\s*["'](?!#)/i.test(s), `${f} external href`);
    if (/<use\b/.test(s)) assert.ok(USE_ALLOW.has(f), `${f} unexpected <use>`);
  }
  for (const f of USE_ALLOW) assert.ok(/<use\b/.test(read(f)), `${f} allow-list entry stale`);
});

function loopLengths(file) {
  const out = new Set();
  for (const m of read(file).matchAll(/animation:\s*[\w-]+\s+([0-9.]+)(m?s)\b/g)) {
    out.add(m[2] === "ms" ? Number(m[1]) : Math.round(Number(m[1]) * 1000));
  }
  return out;
}

test("declared companion durations match the art loop; only petting + 3 walks are duration-less", () => {
  const entries = Object.entries(raw.companionAnimations);
  const noDuration = entries.filter(([, e]) => e.duration == null).map(([k]) => k).sort();
  assert.deepEqual(noDuration, ["petting", "walkBouncy", "walkCurious", "walkTired"]);
  for (const [key, e] of entries) {
    assert.ok(fs.existsSync(path.join(SVG_DIR, e.file)), `${key} file exists`);
    if (e.duration == null) continue;
    const loops = loopLengths(e.file);
    assert.ok(loops.size >= 1, `${key} has animations`);
    if (key === "sleepTwitch" || key === "collapseSleepTwitch") {
      assert.equal(Math.max(...loops), e.duration, `${key} max equals duration`);
    } else {
      assert.equal(loops.size, 1, `${key}: one loop length ${[...loops]}`);
      assert.equal([...loops][0], e.duration, `${key} duration`);
    }
  }
});

test("schema robustness: empty files falls back to file for animations and tiers (T2)", () => {
  assert.deepEqual(schema.normalizeCompanionAnimations({ petting: { files: [], file: "a.svg" } }).petting.files, ["a.svg"]);
  assert.equal(schema.normalizeCompanionWorkTiers({ working: [{ minSessions: 1, files: [], file: "a.svg" }] }).working.length, 1);
  assert.deepEqual(schema.normalizeCompanionAnimations({ petting: { files: [], file: "a.svg" } }).petting.files, ["a.svg"]);
});

test("schema robustness: backslash/traversal names are basenamed", () => {
  const o = schema.normalizeCompanionAnimations({ petting: { file: "..\\x\\evil.svg" }, content: { file: "/" }, tired: { file: "a/../b.svg" } });
  assert.deepEqual(o.petting.files, ["evil.svg"]);
  assert.equal(o.content, undefined);
  assert.deepEqual(o.tired.files, ["b.svg"]);
});

test("schema robustness: duration only kept when a positive finite number", () => {
  const dur = (d) => schema.normalizeCompanionAnimations({ petting: { file: "a.svg", duration: d } }).petting.duration;
  for (const bad of [Infinity, -Infinity, NaN, "300", 0, -5, null, undefined, {}, [300]]) assert.equal(dur(bad), null, String(bad));
  assert.equal(dur(300), 300);
  assert.equal(dur(0.5), 0.5);
  const nonStr = schema.normalizeCompanionAnimations({ petting: { files: [1, null, {}, ["a.svg"]] }, content: { file: 7 } });
  assert.deepEqual(nonStr, {});
});

test("schema robustness: tier minSessions boundaries, ordering and stability", () => {
  const norm = (list) => schema.normalizeCompanionWorkTiers({ working: list }).working;
  assert.deepEqual(norm([{ minSessions: 0.5, files: ["a.svg"] }]), []);
  assert.deepEqual(norm([{ minSessions: 0, files: ["a.svg"] }, { minSessions: -2, files: ["a.svg"] }]), []);
  assert.deepEqual(norm([{ minSessions: Infinity, files: ["a.svg"] }, { minSessions: NaN, files: ["a.svg"] }, { minSessions: "3", files: ["a.svg"] }]), []);
  assert.equal(norm([{ minSessions: 1.9, files: ["a.svg"] }])[0].minSessions, 1);
  const dup = norm([{ minSessions: 2, files: ["first.svg"] }, { minSessions: 2, files: ["second.svg"] }, { minSessions: 5, files: ["top.svg"] }]);
  assert.deepEqual(dup.map((t) => t.files[0]), ["top.svg", "first.svg", "second.svg"]);
  assert.deepEqual(norm([{ minSessions: 1 }, { minSessions: 1, files: [], variants: [] }, null, 5, "x"]), []);
  assert.deepEqual(norm([{ minSessions: 1, variants: ["v.svg"] }]), [{ minSessions: 1, files: [], variants: ["v.svg"] }]);
});

test("schema robustness: hostile / non-object inputs give empty results", () => {
  const emptyTiers = { working: [], juggling: [] };
  for (const bad of [null, undefined, [], "x", 5, true]) {
    assert.deepEqual(schema.normalizeCompanionAnimations(bad), {});
    assert.deepEqual(schema.normalizeCompanionWorkTiers(bad), emptyTiers);
  }
  const proto = JSON.parse('{"__proto__":{"petting":{"file":"a.svg"}},"constructor":{"file":"a.svg"}}');
  assert.deepEqual(schema.normalizeCompanionAnimations(proto), {});
  assert.equal({}.petting, undefined);
  assert.deepEqual(schema.normalizeCompanionWorkTiers({ working: "nope", juggling: { 0: {} }, __proto__: { working: [] } }), emptyTiers);
  assert.deepEqual(schema.normalizeCompanionAnimations({ unknownKey: { file: "a.svg" }, petting: [] }), {});
  const again = schema.normalizeCompanionAnimations({ petting: { file: "a.svg", duration: 5 } });
  assert.deepEqual(schema.normalizeCompanionAnimations(again), again);
});

test("projectThemeVisualUsages tolerates raw junk and stateFamily strings", () => {
  for (const junk of [{ companionAnimations: [], companionWorkTiers: null }, { companionAnimations: "x", companionWorkTiers: 5 }, {}, null, undefined]) {
    assert.doesNotThrow(() => schema.projectThemeVisualUsages(junk));
  }
  const usages = schema.projectThemeVisualUsages({
    companionAnimations: { petting: { file: "a.svg" } },
    companionWorkTiers: { working: [{ minSessions: 1, files: ["w.svg"], variants: ["v.svg"] }] },
  });
  const flat = JSON.stringify(usages instanceof Map ? [...usages] : usages);
  assert.ok(flat.includes("companion:petting"), flat);
  assert.ok(flat.includes("companion:workTiers.working"), flat);
  assert.ok(flat.includes("a.svg") && flat.includes("w.svg") && flat.includes("v.svg"));
});

test("built-in clawd: companion visual usages are required assets and exist on disk", () => {
  const theme = themeLoader.loadTheme("clawd", { strict: true });
  const required = new Set(schema.collectRequiredAssetFiles(theme));
  const usages = schema.projectThemeVisualUsages(theme);
  const files = new Set();
  const walk = (v) => {
    if (typeof v === "string") { if (v.endsWith(".svg")) files.add(v); }
    else if (v && typeof v === "object") for (const x of (v instanceof Map ? [...v.entries()].flat() : Object.values(v))) walk(x);
  };
  walk(usages);
  const alive = [...files].filter((f) => f.startsWith("clawd-alive-"));
  assert.ok(alive.length > 70);
  for (const f of alive) {
    assert.ok(required.has(f), `${f} required`);
    assert.ok(fs.existsSync(path.join(SVG_DIR, f)), `${f} exists`);
  }
});
