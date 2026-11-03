"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createPetStrokeDetector, PET_STROKE } = require("../src/pet-stroke-detector");

function make() {
  const clock = { t: 1_000_000 };
  const d = createPetStrokeDetector({ now: () => clock.t });
  return { d, clock };
}

// Feed x positions spaced stepMs apart; returns all results.
function run(d, clock, xs, stepMs, y = 0) {
  const out = [];
  for (const x of xs) {
    out.push(d.feed(x, y));
    clock.t += stepMs;
  }
  return out;
}

function startPetting(d, clock) {
  const res = run(d, clock, [0, 20, 0, 20], 300);
  assert.equal(res[3], "pet-start");
  clock.t -= 300; // back to the time of the last feed
}

test("exports constants", () => {
  assert.deepEqual({ ...PET_STROKE }, {
    minAmplitudePx: 12, jitterPx: 3, reversalsToStart: 3,
    windowMs: 1500, continueEveryMs: 1000, endAfterMs: 1000,
  });
});

test("three back-and-forth strokes start petting", () => {
  const { d, clock } = make();
  const res = run(d, clock, [0, 20, 0, 20], 300);
  assert.deepEqual(res, [null, null, null, "pet-start"]);
  assert.equal(d.isActive(), true);
});

test("jitter is rejected", () => {
  const { d, clock } = make();
  const xs = Array.from({ length: 50 }, (_, i) => (i % 2 ? 1 : -1));
  assert.ok(run(d, clock, xs, 50).every((r) => r === null));
  assert.equal(d.isActive(), false);
});

test("stationary cursor emits nothing", () => {
  const { d, clock } = make();
  assert.ok(run(d, clock, new Array(100).fill(5), 50).every((r) => r === null));
  assert.equal(d.poll(), null);
});

test("slow strokes outside the window do not start", () => {
  const { d, clock } = make();
  assert.ok(run(d, clock, [0, 20, 0, 20, 0, 20, 0], 900).every((r) => r === null));
});

test("continue is rate limited", () => {
  const { d, clock } = make();
  startPetting(d, clock);
  const res = [];
  for (let i = 0; i < 10; i++) {
    clock.t += 100;
    res.push(d.feed(i % 2 ? 20 : 0, 0));
  }
  assert.ok(res.filter((r) => r === "pet-continue").length <= 1);
  assert.ok(!res.includes("pet-start"));
});

test("continue fires after interval when a new reversal happened", () => {
  const { d, clock } = make();
  startPetting(d, clock);
  clock.t += 1000;
  assert.equal(d.feed(0, 0), "pet-continue");
});

test("poll ends after inactivity", () => {
  const { d, clock } = make();
  startPetting(d, clock);
  clock.t += 999;
  assert.equal(d.poll(), null);
  clock.t += 1;
  assert.equal(d.poll(), "pet-end");
  assert.equal(d.isActive(), false);
  // fully idle: needs fresh reversals
  assert.equal(d.feed(0, 0), null);
  assert.equal(d.feed(20, 0), null);
});

test("vertical motion never pets", () => {
  const { d, clock } = make();
  const out = [];
  for (let i = 0; i < 40; i++) {
    out.push(d.feed(10, i % 2 ? 40 : 0));
    clock.t += 100;
  }
  assert.ok(out.every((r) => r === null));
  assert.equal(d.isActive(), false);
});

test("reset clears an active session", () => {
  const { d, clock } = make();
  startPetting(d, clock);
  d.reset();
  assert.equal(d.isActive(), false);
  clock.t += 5000;
  assert.equal(d.poll(), null);
});

test("one-way pass with small backsteps never pets", () => {
  const { d, clock } = make();
  const xs = [0, 6, 12, 18, 24, 20, 26, 32, 38, 44, 40, 46, 52, 58, 64];
  assert.ok(run(d, clock, xs, 40).every((r) => r === null));
  assert.equal(d.isActive(), false);
});
