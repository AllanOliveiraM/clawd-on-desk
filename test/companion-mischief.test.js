"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const m = require("../src/companion-mischief");
const { getTraits, DEFAULT_MOOD, createInitialState } = require("../src/companion-model");

const RECT = { x: 1000, y: 500, width: 100, height: 100 };
const ALL = new Set([
  "fakeNap", "reachClose", "wall", "sitEdge", "morningStretch", "coffee",
  "nightSleepy", "toyBall", "toyYoyo", "toyPlane",
]);
const BASE = new Date(2026, 10, 3, 14, 0, 0).getTime(); // 14:00 local, no day window

function make({ rand = 0.9, hour = 14, start = BASE } = {}) {
  const clock = { t: start, r: rand, h: hour };
  const brain = m.createMischiefBrain({ now: () => clock.t, random: () => clock.r, getHour: () => clock.h });
  return { clock, brain };
}

function state(energy = 50) {
  const s = createInitialState();
  return { ...s, mood: { ...DEFAULT_MOOD, energy } };
}

function pick(brain, clock, over) {
  return brain.pickAutonomous({
    traits: getTraits("balanced"), personality: "balanced", state: state(), mode: "roam",
    available: ALL, now: clock.t, ...over,
  });
}

function sample(x, y, over) {
  return { x, y, petRect: RECT, overPet: false, ...over };
}

test("exports expected constants and helpers", () => {
  assert.equal(m.MISCHIEF_IDS.length, 11);
  assert.equal(m.MISCHIEF_COOLDOWN_MS.fakeNap, 10800000);
  assert.equal(m.globalCooldownMs({ activity: 0 }), 900000);
  assert.equal(m.globalCooldownMs({ activity: 1 }), 480000);
  assert.equal(m.dayWindow(6), "morning");
  assert.equal(m.dayWindow(10), null);
  assert.equal(m.dayWindow(23), "night");
  assert.equal(m.dayWindow(2), "night");
  assert.equal(m.dayWindow(3), null);
  assert.equal(m.reactWeight("pounce", "shy"), 0);
  assert.equal(m.reactWeight("catch", "shy"), 1);
});

test("transit past the pet never triggers pounce", () => {
  const { brain, clock } = make();
  assert.equal(brain.observeCursor(sample(1200, 550)), null);
  clock.t += 500;
  assert.equal(brain.observeCursor(sample(1150, 550)), null);
  clock.t += 500;
  assert.equal(brain.observeCursor(sample(1300, 550)), null);
  clock.t += 1000;
  assert.equal(brain.observeCursor(sample(1500, 550)), null);
});

test("lurking in the band triggers pounce on the cursor side", () => {
  const { brain, clock } = make();
  assert.equal(brain.observeCursor(sample(1200, 550)), null);
  clock.t += 2600;
  assert.deepEqual(brain.observeCursor(sample(1201, 550)), { id: "pounce", side: "right" });
  // does not re-fire while the lurk continues
  clock.t += 100;
  assert.equal(brain.observeCursor(sample(1201, 550)), null);

  const left = make();
  left.brain.observeCursor(sample(850, 550));
  left.clock.t += 2600;
  assert.deepEqual(left.brain.observeCursor(sample(850, 550)), { id: "pounce", side: "left" });
});

test("leaving the band resets the pounce clock", () => {
  const { brain, clock } = make();
  brain.observeCursor(sample(1200, 550));
  clock.t += 2000;
  brain.observeCursor(sample(1400, 550)); // out of band
  clock.t += 600;
  assert.equal(brain.observeCursor(sample(1200, 550)), null);
});

test("cursor over the pet never pounces", () => {
  const { brain, clock } = make();
  brain.observeCursor(sample(1050, 550, { overPet: true }));
  clock.t += 5000;
  assert.equal(brain.observeCursor(sample(1050, 550, { overPet: true })), null);
});

// Feed the same sample once per second for `ms`, returning the last result.
function hold(brain, clock, x, y, ms) {
  let r = null;
  for (let e = 0; e < ms; e += 1000) {
    clock.t += 1000;
    r = brain.observeCursor(sample(x, y));
    if (r) return r;
  }
  return r;
}

test("parked far cursor triggers poke after 20 s", () => {
  const a = make();
  a.brain.observeCursor(sample(1600, 550));
  assert.equal(hold(a.brain, a.clock, 1600, 550, 19000), null);
  a.clock.t += 1000;
  assert.deepEqual(a.brain.observeCursor(sample(1600, 550)), { id: "poke", target: { x: 1600, y: 550 } });

  const near = make(); // center is (1050, 550); 250 px away is too close
  near.brain.observeCursor(sample(1300, 550));
  const r = hold(near.brain, near.clock, 1300, 550, 21000);
  assert.ok(!r || r.id !== "poke");
});

test("boo only while napping and cursor approaches", () => {
  const { brain, clock } = make();
  assert.equal(brain.observeCursor(sample(1150, 550)), null);
  brain.setNapping(true);
  clock.t += 100;
  assert.equal(brain.observeCursor(sample(1400, 550)), null); // 300 px from the edge
  clock.t += 100;
  assert.deepEqual(brain.observeCursor(sample(1150, 550)), { id: "boo" }); // 50 px
  clock.t += 100;
  assert.equal(brain.observeCursor(sample(1140, 550)), null); // latched
});

test("null cursor samples are ignored", () => {
  const { brain, clock } = make();
  assert.equal(brain.observeCursor(null), null);
  brain.observeCursor(sample(1200, 550));
  clock.t += 1500;
  assert.equal(brain.observeCursor(null), null);
  clock.t += 500; // 2 s into the lurk: not yet
  assert.equal(brain.observeCursor(sample(1200, 550)), null);
  clock.t += 600; // 2.6 s: the null sample did not reset the clock
  assert.deepEqual(brain.observeCursor(sample(1200, 550)), { id: "pounce", side: "right" });
});

test("a long gap in samples never fires on the first sample after it", () => {
  const p = make();
  p.brain.observeCursor(sample(1200, 550));
  p.clock.t += 60000;
  assert.equal(p.brain.observeCursor(sample(1200, 550)), null);
  p.clock.t += 2600;
  assert.deepEqual(p.brain.observeCursor(sample(1200, 550)), { id: "pounce", side: "right" });

  const k = make();
  k.brain.observeCursor(sample(1600, 550));
  k.clock.t += 60000;
  assert.equal(k.brain.observeCursor(sample(1600, 550)), null);
  assert.equal(hold(k.brain, k.clock, 1600, 550, 19000), null);
  assert.equal(hold(k.brain, k.clock, 1600, 550, 2000).id, "poke");
});

test("a backwards clock re-bases cursor clocks", () => {
  const { brain, clock } = make();
  brain.observeCursor(sample(1200, 550));
  clock.t += 2000;
  brain.observeCursor(sample(1200, 550));
  clock.t -= 10000;
  assert.equal(brain.observeCursor(sample(1200, 550)), null);
  clock.t += 2000;
  assert.equal(brain.observeCursor(sample(1200, 550)), null);
  clock.t += 600;
  assert.deepEqual(brain.observeCursor(sample(1200, 550)), { id: "pounce", side: "right" });
});

test("napping while the cursor is already close does not boo instantly", () => {
  const { brain, clock } = make();
  brain.observeCursor(sample(1150, 550));
  brain.setNapping(true);
  clock.t += 100;
  assert.equal(brain.observeCursor(sample(1150, 550)), null);
  clock.t += 100;
  brain.observeCursor(sample(1500, 550)); // leaves
  clock.t += 100;
  assert.deepEqual(brain.observeCursor(sample(1150, 550)), { id: "boo" });
});

test("a backwards clock cannot stretch cooldowns past their nominal length", () => {
  const { brain, clock } = make({ rand: 0.6 });
  brain.markPlayed("fakeNap", clock.t, getTraits("balanced"));
  const back = clock.t - 100000000;
  assert.equal(brain.canReact("fakeNap", back), false);
  assert.equal(brain.canReact("fakeNap", back + 10800000), true);
  assert.equal(brain.isGlobalReady(back + m.globalCooldownMs(getTraits("balanced"))), true);
});

test("isGlobalReady reflects the global cooldown", () => {
  const { brain, clock } = make();
  const traits = getTraits("balanced");
  assert.equal(brain.isGlobalReady(clock.t), true);
  brain.markPlayed("poke", clock.t, traits);
  assert.equal(brain.isGlobalReady(clock.t + m.globalCooldownMs(traits) - 1), false);
  assert.equal(brain.isGlobalReady(clock.t + m.globalCooldownMs(traits)), true);
  brain.markPlayed("pounce", clock.t + 5);
  assert.equal(brain.isGlobalReady(clock.t + m.globalCooldownMs(traits)), true);
});

test("shy never pounces, boos or fake naps; calm never fake naps", () => {
  assert.equal(m.reactWeight("pounce", "shy"), 0);
  assert.equal(m.reactWeight("boo", "shy"), 0);
  assert.equal(m.reactWeight("boo", "calm"), 0);
  for (const personality of ["shy", "calm"]) {
    const { brain, clock } = make({ rand: 0.6 });
    const only = new Set(["fakeNap"]);
    assert.equal(pick(brain, clock, { personality, traits: getTraits(personality), available: only }), null);
  }
});

test("walking mischief only in roam mode", () => {
  const only = new Set(["reachClose", "wall", "sitEdge"]);
  const roam = make({ rand: 0.6 });
  assert.ok(pick(roam.brain, roam.clock, { available: only, mode: "roam" }));
  const act = make({ rand: 0.6 });
  assert.equal(pick(act.brain, act.clock, { available: only, mode: "activities" }), null);
  const nap = make({ rand: 0.6 });
  assert.equal(pick(nap.brain, nap.clock, { available: new Set(["fakeNap"]), mode: "activities" }).id, "fakeNap");
});

test("global cooldown blocks autonomous picks but not reactive ones", () => {
  const { brain, clock } = make({ rand: 0.6 });
  const traits = getTraits("balanced");
  const first = pick(brain, clock);
  assert.ok(first);
  brain.markPlayed(first.id, clock.t);
  const gap = m.globalCooldownMs(traits);
  clock.t += gap - 1;
  assert.equal(pick(brain, clock), null);
  assert.equal(brain.canReact("pounce", clock.t), true);
  brain.markPlayed("pounce", clock.t);
  brain.markPlayed("catch", clock.t);
  brain.markPlayed("welcome", clock.t);
  clock.t += 1;
  assert.ok(pick(brain, clock, { available: new Set(["sitEdge", "toyBall"]) }));
});

test("reactive plays do not start the global cooldown", () => {
  const { brain, clock } = make({ rand: 0.6 });
  brain.markPlayed("pounce", clock.t);
  brain.markPlayed("catch", clock.t);
  brain.markPlayed("stretchBack", clock.t);
  assert.ok(pick(brain, clock));
});

test("individual cooldowns apply", () => {
  const { brain, clock } = make();
  brain.markPlayed("catch", clock.t);
  assert.equal(brain.canReact("catch", clock.t + 89999), false);
  assert.equal(brain.canReact("catch", clock.t + 90000), true);
  brain.markPlayed("fakeNap", clock.t);
  assert.equal(brain.canReact("fakeNap", clock.t + 10799999), false);
  assert.equal(brain.canReact("fakeNap", clock.t + 10800000), true);
  assert.equal(brain.canReact("welcome", clock.t), true);

  // an autonomous id under its own cooldown is skipped after the global one expires
  const b = make({ rand: 0.6 });
  b.brain.markPlayed("fakeNap", b.clock.t);
  b.clock.t += 1000000; // global (<= 900 s) expired, fakeNap still cooling
  assert.equal(pick(b.brain, b.clock, { available: new Set(["fakeNap"]) }), null);
});

test("day window resets across midnight", () => {
  const morning = new Date(2026, 10, 3, 7, 0, 0).getTime();
  const { brain, clock } = make({ rand: 0.6, hour: 7, start: morning });
  const only = new Set(["morningStretch", "coffee"]);
  const first = pick(brain, clock, { available: only });
  assert.equal(first.id, "dayRhythm");
  assert.ok(["morningStretch", "coffee"].includes(first.variant));
  brain.markPlayed("dayRhythm", clock.t);

  clock.t += 3600000 * 2; // 09:00, same morning, global cooldown long over
  clock.h = 9;
  assert.equal(pick(brain, clock, { available: only }), null);

  // next morning
  clock.t = new Date(2026, 10, 4, 7, 0, 0).getTime();
  clock.h = 7;
  assert.equal(pick(brain, clock, { available: only }).id, "dayRhythm");

  // night 23h -> 02h is the same window
  const night = new Date(2026, 10, 4, 23, 30, 0).getTime();
  const n = make({ rand: 0.6, hour: 23, start: night });
  const nightOnly = new Set(["nightSleepy"]);
  const p = pick(n.brain, n.clock, { available: nightOnly });
  assert.deepEqual(p, { id: "dayRhythm", variant: "nightSleepy" });
  n.brain.markPlayed("dayRhythm", n.clock.t);
  n.clock.t = new Date(2026, 10, 5, 2, 0, 0).getTime();
  n.clock.h = 2;
  assert.equal(pick(n.brain, n.clock, { available: nightOnly }), null);
  // the following night is a new window
  n.clock.t = new Date(2026, 10, 5, 23, 30, 0).getTime();
  n.clock.h = 23;
  assert.equal(pick(n.brain, n.clock, { available: nightOnly }).id, "dayRhythm");
});

test("dayRhythm is never picked outside a window", () => {
  const { brain, clock } = make({ rand: 0.6, hour: 14 });
  assert.equal(pick(brain, clock, { available: new Set(["morningStretch", "nightSleepy"]) }), null);
});

test("toy variant picks among available toys", () => {
  const { brain, clock } = make({ rand: 0.6 });
  const r = pick(brain, clock, { available: new Set(["toyYoyo"]) });
  assert.deepEqual(r, { id: "toy", variant: "toyYoyo" });
});

test("low energy suppresses jumpy and walking mischief", () => {
  const jumpy = new Set(["reachClose", "wall"]);
  const low = make({ rand: 0.6 });
  assert.equal(pick(low.brain, low.clock, { available: jumpy, state: state(20) }), null);
  const ok = make({ rand: 0.6 });
  assert.ok(pick(ok.brain, ok.clock, { available: jumpy, state: state(25) }));
  const calm = make({ rand: 0.6 });
  assert.equal(pick(calm.brain, calm.clock, { available: new Set(["sitEdge"]), state: state(20) }).id, "sitEdge");
});

test("pickAutonomous returns null about half the time", () => {
  const a = make({ rand: 0.4 });
  assert.equal(pick(a.brain, a.clock), null);
  const b = make({ rand: 0.6 });
  const r = pick(b.brain, b.clock);
  assert.ok(r && typeof r.id === "string");
});

test("missing animations are never picked", () => {
  const { brain, clock } = make({ rand: 0.6 });
  assert.equal(pick(brain, clock, { available: new Set() }), null);
  assert.equal(pick(brain, clock, { available: new Set(["wall"]) }).id, "wall");
});

test("reset clears cooldowns, windows and cursor state", () => {
  const { brain, clock } = make({ rand: 0.6 });
  brain.markPlayed("fakeNap", clock.t);
  brain.reset();
  assert.equal(brain.canReact("fakeNap", clock.t), true);
  assert.ok(pick(brain, clock));
});
