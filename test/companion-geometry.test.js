"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const themeLoader = require("../src/theme-loader");
const geo = require("../src/companion-geometry");

themeLoader.init(path.join(__dirname, "..", "src"));
const clawd = themeLoader.loadTheme("clawd", { strict: true });
const near = (actual, expected, eps = 0.002) => assert.ok(Math.abs(actual - expected) < eps, `${actual} vs ${expected}`);

test("catch buckets follow the viewBox thresholds", () => {
  assert.equal(geo.catchBucket(7.5, 5), "high");
  assert.equal(geo.catchBucket(-1, 5), "high", "high wins above the head");
  assert.equal(geo.catchBucket(1, 10), "left");
  assert.equal(geo.catchBucket(14, 10), "right");
  assert.equal(geo.catchBucket(7.5, 14), "low");
  assert.equal(geo.catchBucket(7.5, 10), "body");
  assert.equal(geo.catchBucket(NaN, 10), null);
});

test("hover info carries bucket and cursor side", () => {
  assert.deepEqual(geo.hoverInfoFromPointer({ x: 1, y: 10, inside: true }), { bucket: "left", side: "left" });
  assert.deepEqual(geo.hoverInfoFromPointer({ x: 8, y: 14 }), { bucket: "low", side: "right" });
  assert.equal(geo.hoverInfoFromPointer(null), null);
  assert.equal(geo.hoverInfoFromPointer({ x: "1", y: 2 }), null);
});

test("art points use the theme layout (clawd numbers from the polish audit)", () => {
  const W = 1000;
  const art = geo.createArt(clawd, { width: W, height: W });
  const poke = art.point("pokeLeft", geo.POKE_FINGERTIP.u, geo.POKE_FINGERTIP.v);
  near(poke.x / W, 0.123);
  near(poke.y / W, 0.747);
  assert.equal(art.mirrorU("pokeRight", -5.5), 20.5);
  near(art.point("pokeRight", 20.5, 10).x / W, 0.877);
  near(art.point("wallPushLeft", geo.WALL_PUSH_HANDS_U, 10).x / W, 0.21);
  near(art.point("wallPeekLeft", geo.WALL_PEEK_EDGE_U, 10).x / W, 0.25);
  assert.equal(geo.FETCH_EDGE_U, -1.5, "Ruling N4: the fetch art assumes the screen edge at u -1.5");
  near(art.point("sitEdge", 7.5, geo.SIT_EDGE_LEDGE_V).y / W, 0.892);
  const tip = art.point("reachClose", geo.REACH_CLOSE_TIP.u, geo.REACH_CLOSE_TIP.v);
  near(tip.x / W, 0.747);
  near(tip.y / W, 0.196);
  const margins = art.visualMargins("pokeLeft");
  near(margins.top / W, 0.254);
  near(margins.bottom / W, 0.05);
});

test("art answers null without a placeable theme, key or size", () => {
  const bare = geo.createArt({ companionAnimations: { pokeLeft: { files: ["p.svg"] } } }, { width: 100, height: 100 });
  assert.equal(bare.has("pokeLeft"), true);
  assert.equal(bare.point("pokeLeft", 0, 0), null);
  assert.equal(geo.createArt(clawd, { width: 100, height: 100 }).point("noSuchKey", 0, 0), null);
  assert.equal(geo.createArt(clawd, null).point("pokeLeft", 0, 0), null);
  assert.equal(bare.visualMargins("pokeLeft"), null);
});
