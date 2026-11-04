"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const scenes = require("../src/companion-scenes");

const { partDurationMs, buildScene, mischiefAvailable, fetchSide, fetchObjectKey, walkEdgeDistance, createScenePlayer, FETCH_OBJECTS } = scenes;

const resolverOf = (keys, duration = null) => (key) => (keys.includes(key) ? { file: `${key}.svg`, duration } : null);
const first = () => 0;

test("partDurationMs clamps authored and default durations", () => {
  assert.equal(partDurationMs({ duration: 50 }, true), 100);
  assert.equal(partDurationMs({ duration: 50 }, false), 1000);
  assert.equal(partDurationMs({ duration: 9000 }), 8000);
  assert.equal(partDurationMs({ duration: 9000 }, true), 8000);
  for (const duration of [null, 0, -1, NaN, Infinity, "5", undefined]) {
    assert.equal(partDurationMs({ duration }), 3500, String(duration));
    assert.equal(partDurationMs({ duration }, true), 3500, `once ${duration}`);
  }
  assert.equal(partDurationMs(null), 3500);
  assert.equal(partDurationMs({}, true), 3500);
});

test("buildScene rejects unknown ids and missing main art", () => {
  assert.equal(buildScene("nope", {}, resolverOf(["x"]), first), null);
  assert.equal(buildScene("sitEdge", {}, resolverOf(["sitDown", "standUp"]), first), null, "no main sitEdge part");
  assert.equal(buildScene("single", {}, resolverOf(["x"]), first), null, "single needs a key");
  assert.equal(buildScene("single", { key: "missing" }, resolverOf(["x"]), first), null);
  assert.equal(buildScene("welcome", {}, resolverOf([]), first), null);
});

test("buildScene leaves out optional parts without art and keeps the rest", () => {
  const bare = buildScene("sitEdge", {}, resolverOf(["sitEdge"]), first);
  assert.deepEqual(bare.parts.map((p) => p.key), ["sitEdge"]);
  const full = buildScene("sitEdge", {}, resolverOf(["sitDown", "sitEdge", "standUp"], 600), first);
  assert.deepEqual(full.parts.map((p) => p.key), ["sitDown", "sitEdge", "standUp"]);
  assert.equal(full.parts[0].duration, 600, "a one-shot keeps its own length");
  assert.equal(full.parts[1].loop, true);
  assert.equal(full.parts.every((p) => !("optional" in p)), true);
});

test("buildScene without a catchMiss part has no hover-move switch", () => {
  const scene = buildScene("catch", { bucket: "high" }, resolverOf(["catch"]), first);
  assert.deepEqual(scene.on, {});
  const withMiss = buildScene("catch", { bucket: "high" }, resolverOf(["catch", "catchMiss"]), first);
  assert.deepEqual(Object.keys(withMiss.on), ["hover-move"]);
});

test("reactive scenes require interactions, the rest autonomy", () => {
  assert.equal(buildScene("catch", {}, resolverOf(["catch"]), first).requires, "interactions");
  assert.equal(buildScene("pounce", { side: "left" }, resolverOf(["pounceLeft"]), first).requires, "interactions");
  assert.equal(buildScene("welcome", {}, resolverOf(["welcome"]), first).requires, "autonomy");
  assert.equal(buildScene("searchMouse", {}, resolverOf(["searchMouse"]), first).requires, "autonomy");
});

test("mischiefAvailable in single-part mode leaves out walking and looping scenes", () => {
  const keys = new Set(["fetchExitLeft", "fetchCursorLeft", "wallPushLeft", "fakeNap", "sitEdge", "reachClose", "searchMouse", "coffee"]);
  const full = mischiefAvailable(keys, false);
  for (const id of ["fetch", "wall", "fakeNap", "sitEdge", "reachClose", "searchMouse", "coffee"]) assert.ok(full.has(id), id);
  const single = mischiefAvailable(keys, true);
  for (const id of ["fetch", "wall", "fakeNap", "sitEdge", "reachClose"]) assert.equal(single.has(id), false, id);
  assert.ok(single.has("searchMouse"));
  assert.ok(single.has("coffee"));
});

test("a fetch needs an exit and at least one object on a side", () => {
  assert.equal(mischiefAvailable(new Set(["fetchExitLeft"]), false).has("fetch"), false);
  assert.equal(mischiefAvailable(new Set(["fetchCursorLeft"]), false).has("fetch"), false);
  assert.equal(mischiefAvailable(new Set(["fetchExitRight", "fetchCursorRight"]), false).has("fetch"), true);
});

test("fetchSide prefers the asked side, falls back, or answers null", () => {
  const ready = (...keys) => (key) => keys.includes(key);
  const obj = FETCH_OBJECTS[0];
  const left = ready("fetchExitLeft", `fetch${obj}Left`);
  const right = ready("fetchExitRight", `fetch${obj}Right`);
  const both = (k) => left(k) || right(k);
  assert.equal(fetchSide("left", both), "left");
  assert.equal(fetchSide("right", both), "right");
  assert.equal(fetchSide("left", right), "right", "the preferred side lacks art");
  assert.equal(fetchSide("right", left), "left");
  assert.equal(fetchSide("left", ready("fetchExitLeft")), null, "exit without objects is not ready");
  assert.equal(fetchSide("left", () => false), null);
});

test("fetchObjectKey honors a planned object, else picks by random", () => {
  const has = (key) => /Left$/.test(key) && FETCH_OBJECTS.some((o) => key === `fetch${o}Left`);
  const keys = FETCH_OBJECTS.map((o) => `fetch${o}Left`);
  assert.ok(keys.length >= 2);
  assert.equal(fetchObjectKey("left", keys[1], has, () => 0), keys[1]);
  assert.equal(fetchObjectKey("left", "bogus", has, () => 1), keys[keys.length - 1], "random 1 clamps to the last");
  assert.equal(fetchObjectKey("left", null, has, () => NaN), keys[0], "NaN falls to the first");
  assert.equal(fetchObjectKey("left", null, has, () => 0.9999999), keys[keys.length - 1]);
  assert.equal(fetchObjectKey("left", null, () => false, () => 0), null);
  assert.equal(fetchObjectKey("right", keys[0], has, () => 0), null, "the object belongs to the other side");
});

test("walkEdgeDistance handles missing bounds, sides and never goes negative", () => {
  const area = { x: 0, y: 0, width: 1000, height: 800 };
  const bounds = { x: 100, y: 100, width: 100, height: 100 };
  assert.equal(walkEdgeDistance({ id: "wall", side: "left" }, { area, bounds: null }), Infinity);
  assert.equal(walkEdgeDistance({ id: "wall", side: "left" }, { area: null, bounds }), Infinity);
  assert.equal(walkEdgeDistance({ id: "fetch", side: "left" }, { area, bounds }), 100);
  assert.equal(walkEdgeDistance({ id: "fetch", side: "right" }, { area, bounds }), 800);
  assert.equal(walkEdgeDistance({ id: "wall", side: "left" }, { area, bounds: { ...bounds, x: -50 } }), 0, "past the edge is 0");
  assert.equal(walkEdgeDistance({ id: "sitEdge" }, { area, bounds: { ...bounds, y: 900 } }), 0);
  assert.equal(walkEdgeDistance({ id: "unknown" }, { area, bounds }), Infinity);
});

// ---- scene loop cut ----

function player(sceneNow) {
  const plays = [];
  const ended = [];
  const p = createScenePlayer({
    play: (kind, file, duration) => plays.push({ file, duration }),
    getPlaying: () => null,
    isOwned: () => true,
    canContinue: () => true,
    stopPlayback: () => {},
    clearPlayback: () => {},
    restoreIdleVisual: () => {},
    now: () => sceneNow.t,
    onEnd: (scene) => ended.push(scene.id),
  });
  return { p, plays, ended };
}

const loopScene = () => ({
  id: "sitEdge",
  parts: [
    { key: "sitEdge", file: "sit.svg", duration: 2000, loop: true, maxMs: 3000 },
    { key: "standUp", file: "up.svg", duration: 600, once: true },
  ],
  on: {}, index: 0, partStartedAt: null, switched: false,
});

test("a late part timer ends the loop without an extra iteration", () => {
  const clock = { t: 0 };
  const { p, plays, ended } = player(clock);
  const scene = loopScene();
  p.start(scene);
  clock.t = 2000;
  p.partFinished(scene, true);
  assert.deepEqual(plays.map((x) => [x.file, x.duration]), [["sit.svg", 2000], ["sit.svg", 1000]], "last iteration cut to maxMs - elapsed");
  clock.t = 9000; // the timer fired very late
  p.partFinished(scene, true);
  assert.deepEqual(plays.map((x) => x.file), ["sit.svg", "sit.svg", "up.svg"], "straight to the next part");
  assert.equal(plays[2].duration, 600);
  clock.t = 9600;
  p.partFinished(scene, true);
  assert.deepEqual(ended, ["sitEdge"]);
});

test("a loop iteration started right before maxMs lasts at least 1 ms", () => {
  const clock = { t: 0 };
  const { p, plays } = player(clock);
  const scene = loopScene();
  p.start(scene);
  clock.t = 2999;
  p.partFinished(scene, true);
  assert.equal(plays[1].file, "sit.svg");
  assert.equal(plays[1].duration, 1);
});

test("a scene that lost its visual ends at once", () => {
  const clock = { t: 0 };
  const { p, plays, ended } = player(clock);
  const scene = loopScene();
  p.start(scene);
  p.partFinished(scene, false);
  assert.equal(plays.length, 1);
  assert.deepEqual(ended, ["sitEdge"]);
});
