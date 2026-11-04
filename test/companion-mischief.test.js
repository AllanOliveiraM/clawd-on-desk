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
  assert.equal(m.MISCHIEF_IDS.length, 13);
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

test("poke has a personality weight: shy pokes far less than curious", () => {
  const row = ["balanced", "playful", "curious", "calm", "shy"].map((p) => m.reactWeight("poke", p));
  assert.deepEqual(row, [0.6, 0.8, 1.2, 0.4, 0.2]);
  assert.ok(m.reactWeight("poke", "shy") * 4 <= m.reactWeight("poke", "curious"));
});

test("pounce cools down for 10 minutes", () => {
  assert.equal(m.MISCHIEF_COOLDOWN_MS.pounce, 600000);
  const { brain, clock } = make();
  brain.markPlayed("pounce", clock.t);
  assert.equal(brain.canReact("pounce", clock.t + 599999), false);
  assert.equal(brain.canReact("pounce", clock.t + 600000), true);
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

// Strike reach (Ruling P1): RECT spans x 1000..1100; the strike hand tips
// reach x 960 (left) / 1140 (right) at tip height y 540, +/- 20 px.
const ZONE = { leftX: 960, rightX: 1140, tipY: 540, tolY: 20 };
function zoned(x, y, over) {
  return sample(x, y, { pounceZone: ZONE, ...over });
}

test("with a strike zone only a cursor inside the arm reach pounces", () => {
  for (const [x, y, side] of [[970, 545, "left"], [960, 520, "left"], [1130, 560, "right"], [1140, 540, "right"]]) {
    const { brain, clock } = make();
    assert.equal(brain.observeCursor(zoned(x, y)), null);
    clock.t += 2600;
    assert.deepEqual(brain.observeCursor(zoned(x, y)), { id: "pounce", side }, `${x},${y}`);
  }
  // In the old 40..220 px band but beyond the reach, or off the arm height.
  for (const [x, y] of [[900, 545], [1200, 540], [970, 570], [1130, 515]]) {
    const { brain, clock } = make();
    brain.observeCursor(zoned(x, y));
    clock.t += 2600;
    assert.equal(brain.observeCursor(zoned(x, y)), null, `${x},${y}`);
  }
});

test("leaving the strike zone resets the pounce clock", () => {
  const { brain, clock } = make();
  brain.observeCursor(zoned(970, 540));
  clock.t += 2000;
  brain.observeCursor(zoned(900, 540));
  clock.t += 600;
  assert.equal(brain.observeCursor(zoned(970, 540)), null);
  clock.t += 2600;
  assert.deepEqual(brain.observeCursor(zoned(970, 540)), { id: "pounce", side: "left" });
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

// ---- fetch ("vai buscar") and searchMouse ----

test("fetch: roam-only, personality weights, 2 h cooldown and the global cooldown", () => {
  assert.ok(m.MISCHIEF_IDS.includes("fetch"));
  assert.equal(m.MISCHIEF_COOLDOWN_MS.fetch, 7200000);
  const row = ["balanced", "playful", "curious", "calm", "shy"].map((p) => m.autonomousWeight("fetch", p));
  assert.deepEqual(row, [0.2, 1, 0.3, 0, 0]);
  const only = new Set(["fetch"]);
  for (const personality of ["calm", "shy"]) {
    const { brain, clock } = make({ rand: 0.6 });
    assert.equal(pick(brain, clock, { personality, traits: getTraits(personality), available: only }), null, personality);
  }
  const roam = make({ rand: 0.6 });
  assert.deepEqual(pick(roam.brain, roam.clock, { personality: "playful", available: only }), { id: "fetch" });
  const act = make({ rand: 0.6 });
  assert.equal(pick(act.brain, act.clock, { personality: "playful", available: only, mode: "activities" }), null);

  const { brain, clock } = make({ rand: 0.6 });
  brain.markPlayed("fetch", clock.t);
  assert.equal(brain.isGlobalReady(clock.t), false, "fetch starts the global cooldown");
  clock.t += 7200000 - 1;
  assert.equal(brain.canReact("fetch", clock.t), false);
  assert.equal(pick(brain, clock, { personality: "playful", available: only }), null);
  clock.t += 1;
  assert.deepEqual(pick(brain, clock, { personality: "playful", available: only }), { id: "fetch" });
});

test("fetch is blocked by low energy and without its art", () => {
  const only = new Set(["fetch"]);
  const low = make({ rand: 0.6 });
  assert.equal(pick(low.brain, low.clock, { personality: "playful", available: only, state: state(24) }), null);
  const ok = make({ rand: 0.6 });
  assert.ok(pick(ok.brain, ok.clock, { personality: "playful", available: only, state: state(25) }));
  const none = make({ rand: 0.6 });
  assert.equal(pick(none.brain, none.clock, { personality: "playful", available: new Set() }), null);
});

test("searchMouse only after 10 min without a trusted cursor sample, 30 min cooldown", () => {
  assert.equal(m.MISCHIEF_COOLDOWN_MS.searchMouse, 1800000);
  const only = new Set(["searchMouse"]);
  const fresh = make({ rand: 0.6 });
  assert.equal(pick(fresh.brain, fresh.clock, { available: only }), null, "no cursor info: never");
  assert.equal(pick(fresh.brain, fresh.clock, { available: only, cursorUnseenMs: 599999 }), null);
  assert.deepEqual(pick(fresh.brain, fresh.clock, { available: only, cursorUnseenMs: 600000 }), { id: "searchMouse" });
  for (const mode of ["roam", "activities"]) {
    const { brain, clock } = make({ rand: 0.6 });
    assert.deepEqual(pick(brain, clock, { available: only, cursorUnseenMs: 9e9, mode }), { id: "searchMouse" }, mode);
  }
  const { brain, clock } = make({ rand: 0.6 });
  brain.markPlayed("searchMouse", clock.t);
  clock.t += 1800000 - 1;
  assert.equal(pick(brain, clock, { available: only, cursorUnseenMs: 9e9 }), null);
  clock.t = BASE + 1800000;
  assert.deepEqual(pick(brain, clock, { available: only, cursorUnseenMs: 9e9 }), { id: "searchMouse" });
  const none = make({ rand: 0.6 });
  assert.equal(pick(none.brain, none.clock, { available: new Set(), cursorUnseenMs: 9e9 }), null);
});

test("searchMouse takes its threshold from the caller (30 s under XWayland)", () => {
  assert.equal(m.XWAYLAND_CURSOR_UNSEEN_MS, 30000);
  const only = new Set(["searchMouse"]);
  const a = make({ rand: 0.6 });
  assert.equal(pick(a.brain, a.clock, { available: only, cursorUnseenMs: 29999, cursorUnseenMinMs: 30000 }), null);
  assert.deepEqual(pick(a.brain, a.clock, { available: only, cursorUnseenMs: 30000, cursorUnseenMinMs: 30000 }), { id: "searchMouse" });
  const b = make({ rand: 0.6 });
  assert.equal(pick(b.brain, b.clock, { available: only, cursorUnseenMs: 30000 }), null, "default stays 10 min");
});

test("searchMouse keeps only its own cooldown (Ruling N3)", () => {
  const only = new Set(["searchMouse"]);
  const { brain, clock } = make({ rand: 0.6 });
  brain.markPlayed("searchMouse", clock.t);
  assert.equal(brain.isGlobalReady(clock.t), true, "does not start the global cooldown");
  assert.ok(pick(brain, clock, { available: new Set(["sitEdge"]) }), "other mischief still free");
  const g = make({ rand: 0.6 });
  g.brain.markPlayed("fetch", g.clock.t);
  assert.equal(g.brain.isGlobalReady(g.clock.t), false);
  assert.deepEqual(pick(g.brain, g.clock, { available: new Set(["searchMouse", "sitEdge"]), cursorUnseenMs: 9e9 }),
    { id: "searchMouse" }, "not blocked by the global cooldown");
  assert.equal(pick(g.brain, g.clock, { available: new Set(["sitEdge"]) }), null);
});

test("fetch and searchMouse never change the picks of a theme without their art", () => {
  for (const rand of [0.55, 0.7, 0.85, 0.99]) {
    const a = make({ rand });
    const b = make({ rand });
    assert.deepEqual(pick(a.brain, a.clock), pick(b.brain, b.clock, { cursorUnseenMs: 9e9 }));
  }
});

test("waking from a nap with a parked far cursor does not poke at once (G1)", () => {
  const { brain, clock } = make();
  brain.setNapping(true);
  for (let i = 0; i < 30; i += 1) { brain.observeCursor(sample(1600, 550)); clock.t += 1000; }
  brain.setNapping(false);
  clock.t += 1000;
  assert.equal(brain.observeCursor(sample(1600, 550)), null, "no poke the instant he wakes");
  assert.equal(hold(brain, clock, 1600, 550, 18000), null);
  clock.t += 2000;
  assert.equal(brain.observeCursor(sample(1600, 550)).id, "poke", "a fresh 20 s of stillness after waking");
});

// ---- coverage: napping, day windows, clocks, searchMouse, fetch, personalities ----

const TRAITS = getTraits("balanced");
const PERSONALITIES = ["balanced", "playful", "curious", "calm", "shy"];

function at(brain, clock, x, y, dt, over) {
  clock.t += dt;
  return brain.observeCursor(sample(x, y, over));
}

test("napping toggles: boo once per approach, pounce needs a fresh dwell after waking", () => {
  const { brain, clock } = make();
  at(brain, clock, 1200, 550, 100); // lurking in the band since t0
  at(brain, clock, 1200, 550, 2000);
  brain.setNapping(true);
  at(brain, clock, 1500, 550, 100); // far: arms the boo
  assert.deepEqual(at(brain, clock, 1150, 550, 100), { id: "boo" });
  assert.equal(at(brain, clock, 1150, 550, 100), null, "latched");
  at(brain, clock, 1500, 550, 100); // leaves
  assert.deepEqual(at(brain, clock, 1150, 550, 100), { id: "boo" }, "a second approach boos again");
  brain.setNapping(false);
  at(brain, clock, 1200, 550, 100);
  assert.equal(at(brain, clock, 1200, 550, 2400), null, "dwell restarted at wake-up");
  assert.deepEqual(at(brain, clock, 1200, 550, 200), { id: "pounce", side: "right" });
});

test("napping suppresses pounce and poke", () => {
  const { brain, clock } = make();
  brain.setNapping(true);
  at(brain, clock, 1300, 550, 100); // edge 200: outside the boo range, inside the pounce band
  for (let i = 0; i < 6; i += 1) assert.equal(at(brain, clock, 1300, 550, 1000), null);
  const far = make();
  far.brain.setNapping(true);
  at(far.brain, far.clock, 1700, 550, 100);
  for (let i = 0; i < 30; i += 1) assert.equal(at(far.brain, far.clock, 1700, 550, 1000), null);
});

test("boo range: 120 px from the edge does not boo, 119 does; over the pet (edge 0) boos", () => {
  const no = make();
  no.brain.setNapping(true);
  assert.equal(at(no.brain, no.clock, 1220, 550, 100), null);
  const yes = make();
  yes.brain.setNapping(true);
  assert.deepEqual(at(yes.brain, yes.clock, 1219, 550, 100), { id: "boo" });
  const over = make();
  over.brain.setNapping(true);
  assert.deepEqual(at(over.brain, over.clock, 1050, 550, 100, { overPet: true }), { id: "boo" });
});

test("dayWindow boundaries and NaN", () => {
  assert.equal(m.dayWindow(5.99), null);
  assert.equal(m.dayWindow(6), "morning");
  assert.equal(m.dayWindow(9.99), "morning");
  assert.equal(m.dayWindow(10), null);
  assert.equal(m.dayWindow(22.99), null);
  assert.equal(m.dayWindow(23), "night");
  assert.equal(m.dayWindow(0), "night");
  assert.equal(m.dayWindow(2.99), "night");
  assert.equal(m.dayWindow(3), null);
  assert.equal(m.dayWindow(NaN), null);
  assert.equal(m.dayWindow(undefined), null);
});

test("DST: the night window key survives fall-back and spring-forward (TZ=America/New_York)", () => {
  const script = `
    const m = require(${JSON.stringify(require.resolve("../src/companion-mischief"))});
    const out = {};
    const run = (name, play, probes) => {
      const c = { t: 0 };
      const b = m.createMischiefBrain({ now: () => c.t, random: () => 0.6 });
      c.t = play; b.markPlayed("dayRhythm");
      out[name] = probes.map((t) => { c.t = t; return b.pickAutonomous({ personality: "balanced", mode: "roam", available: new Set(["nightSleepy"]), now: t }); }).map((r) => !!r);
    };
    const H = 3600000;
    const fall1 = new Date(2026, 10, 1, 1, 30).getTime(); // first 01:30 (EDT)
    run("fall", new Date(2026, 9, 31, 23, 30).getTime(), [fall1, fall1 + H, new Date(2026, 10, 1, 2, 30).getTime(), new Date(2026, 10, 1, 23, 30).getTime()]);
    run("spring", new Date(2026, 2, 7, 23, 30).getTime(), [new Date(2026, 2, 8, 1, 30).getTime(), new Date(2026, 2, 8, 23, 30).getTime()]);
    console.log(JSON.stringify(out));
  `;
  const r = require("node:child_process").spawnSync(process.execPath, ["-e", script], {
    env: { ...process.env, TZ: "America/New_York" }, encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.deepEqual(out.fall, [false, false, false, true], "same window through the repeated hour, new one next night");
  assert.deepEqual(out.spring, [false, true]);
});

test("getHour and now agree across midnight for the night window key", () => {
  const night = new Date(2026, 10, 4, 23, 30, 0).getTime();
  const { brain, clock } = make({ rand: 0.6, hour: 23, start: night });
  const only = new Set(["nightSleepy"]);
  brain.markPlayed("dayRhythm", clock.t);
  clock.t = new Date(2026, 10, 5, 0, 30, 0).getTime();
  clock.h = 0;
  assert.equal(pick(brain, clock, { available: only }), null, "00:30 is still the 4 Nov night");
  clock.t = new Date(2026, 10, 5, 23, 30, 0).getTime();
  clock.h = 23;
  assert.equal(pick(brain, clock, { available: only }).id, "dayRhythm");
  // Without a custom hour source both come from the clock.
  const c = { t: night };
  const b = m.createMischiefBrain({ now: () => c.t, random: () => 0.6 });
  b.markPlayed("dayRhythm");
  c.t = new Date(2026, 10, 5, 0, 30, 0).getTime();
  assert.equal(b.pickAutonomous({ personality: "balanced", mode: "roam", available: only, now: c.t }), null);
});

test("a backwards clock does not replay a dayRhythm window", () => {
  const morning = new Date(2026, 10, 3, 7, 0, 0).getTime();
  const { brain, clock } = make({ rand: 0.6, hour: 7, start: morning });
  const only = new Set(["morningStretch"]);
  brain.markPlayed("dayRhythm", clock.t, TRAITS);
  clock.t = morning - 1800000; // 06:30, same window
  clock.h = 6;
  assert.equal(pick(brain, clock, { available: only }), null);
  clock.t += 2 * 3600000; // well past the global cooldown
  clock.h = 8;
  assert.equal(pick(brain, clock, { available: only }), null, "still the same morning window");
});

test("a cooldown already expired at the last read stays expired after a clock step back (R2')", () => {
  const { brain, clock } = make();
  brain.markPlayed("poke", clock.t, TRAITS);
  const expiredAt = clock.t + m.MISCHIEF_COOLDOWN_MS.poke;
  assert.equal(brain.canReact("poke", expiredAt + 5000), true, "read after it expired");
  // The clock steps back to before the old deadline: the cooldown must not revive.
  assert.equal(brain.canReact("poke", expiredAt - 1000), true);
  assert.equal(brain.canReact("poke", expiredAt - 500), true);
  // Same for the global cooldown.
  const fresh = make();
  fresh.brain.markPlayed("poke", fresh.clock.t, TRAITS);
  const globalEnd = fresh.clock.t + m.globalCooldownMs(TRAITS);
  assert.equal(fresh.brain.isGlobalReady(globalEnd + 5000), true);
  assert.equal(fresh.brain.isGlobalReady(globalEnd - 1000), true);
});

test("a cooldown set after a clock step back is not shortened by later calls", () => {
  const { brain, clock } = make();
  brain.markPlayed("fakeNap", clock.t, TRAITS);
  const back = clock.t - 1000000;
  brain.markPlayed("poke", back, TRAITS);
  assert.equal(brain.canReact("poke", back + 1000), false);
  // Probed in clock order: an earlier probe after a later read is itself a
  // clock step back (R2': what had expired at the last read stays expired).
  assert.equal(brain.isGlobalReady(back + m.globalCooldownMs(TRAITS) - 1), false);
  assert.equal(brain.canReact("poke", back + 1199999), false);
  assert.equal(brain.canReact("poke", back + 1200000), true);
});

test("a forward jump of 8 h releases the global and every own cooldown", () => {
  const { brain, clock } = make();
  brain.markPlayed("fakeNap", clock.t, TRAITS);
  brain.markPlayed("sitEdge", clock.t, TRAITS);
  const later = clock.t + 8 * 3600000;
  assert.equal(brain.canReact("fakeNap", clock.t + 2 * 3600000), false, "still cooling before the jump target");
  assert.equal(brain.isGlobalReady(later), true);
  assert.equal(brain.canReact("sitEdge", later), true);
  assert.equal(brain.canReact("fakeNap", later), true, "the longest cooldown is 3 h");
});

test("searchMouse: unusable unseen values never pick, min 0 with unseen 0 picks", () => {
  const { brain, clock } = make({ rand: 0.6 });
  const base = { traits: TRAITS, personality: "balanced", mode: "roam", available: new Set(["searchMouse"]), now: clock.t };
  for (const bad of [Infinity, NaN, -5, "700000", null, undefined]) {
    assert.equal(brain.pickAutonomous({ ...base, cursorUnseenMs: bad }), null, String(bad));
  }
  assert.deepEqual(brain.pickAutonomous({ ...base, cursorUnseenMs: 0, cursorUnseenMinMs: 0 }), { id: "searchMouse" });
  // an unusable minimum falls back to the 10 min default
  for (const bad of [Infinity, NaN, "0"]) {
    assert.equal(brain.pickAutonomous({ ...base, cursorUnseenMs: 599999, cursorUnseenMinMs: bad }), null, String(bad));
    assert.deepEqual(brain.pickAutonomous({ ...base, cursorUnseenMs: 600000, cursorUnseenMinMs: bad }), { id: "searchMouse" }, String(bad));
  }
});

test("searchMouse is stationary and low-energy proof for every personality (G2)", () => {
  for (const personality of PERSONALITIES) {
    for (const mode of ["roam", "activities", "stationary"]) {
      const { brain, clock } = make({ rand: 0.6 });
      const r = brain.pickAutonomous({
        traits: TRAITS, personality, mode, state: state(5), available: new Set(["searchMouse"]),
        cursorUnseenMs: 700000, now: clock.t,
      });
      assert.deepEqual(r, { id: "searchMouse" }, `${personality}/${mode}`);
    }
  }
});

test("fetch eligibility matrix", () => {
  const only = new Set(["fetch"]);
  const go = (over, setup) => {
    const { brain, clock } = make({ rand: 0.6 });
    if (setup) setup(brain, clock);
    return pick(brain, clock, { available: only, ...over });
  };
  assert.deepEqual(go({ personality: "playful" }), { id: "fetch" });
  assert.equal(go({ personality: "playful", mode: "activities" }), null);
  assert.equal(go({ personality: "playful", mode: null }), null);
  assert.deepEqual(go({ personality: "playful", state: state(25) }), { id: "fetch" });
  assert.equal(go({ personality: "playful", state: state(24) }), null);
  assert.equal(go({ personality: "calm" }), null);
  assert.equal(go({ personality: "shy" }), null);
  const played = (brain, clock) => brain.markPlayed("fetch", clock.t, TRAITS);
  const exact = make({ rand: 0.6 });
  exact.brain.markPlayed("fetch", exact.clock.t, TRAITS);
  assert.equal(exact.brain.canReact("fetch", exact.clock.t + 7199999), false);
  assert.equal(exact.brain.canReact("fetch", exact.clock.t + 7200000), true);
  assert.equal(go({ personality: "playful" }, played), null, "cooling down");
});

test("globalCooldownMs interpolates with activity and defaults to 0.5", () => {
  assert.equal(m.globalCooldownMs({ activity: 0 }), 900000);
  assert.equal(m.globalCooldownMs({ activity: 0.5 }), 690000);
  assert.equal(m.globalCooldownMs({ activity: 1 }), 480000);
  for (const bad of [{ activity: NaN }, {}, null, undefined, { activity: "1" }]) assert.equal(m.globalCooldownMs(bad), 690000);
  assert.equal(m.globalCooldownMs({ activity: 7 }), 480000, "clamped");
  assert.equal(m.globalCooldownMs({ activity: -3 }), 900000, "clamped");
});

test("personalities: unknown falls back to balanced, table is complete and finite", () => {
  for (const id of ["fakeNap", "reachClose", "wall", "sitEdge", "dayRhythm", "toy", "pounce", "boo", "poke", "fetch", "searchMouse"]) {
    for (const p of PERSONALITIES) {
      for (const fn of [m.reactWeight, m.autonomousWeight]) {
        const w = fn(id, p);
        assert.ok(Number.isFinite(w) && w >= 0, `${fn.name}(${id},${p})`);
      }
    }
    for (const p of ["zzz", undefined, null, "toString", "constructor", "__proto__"]) {
      assert.equal(m.reactWeight(id, p), m.reactWeight(id, "balanced"), `${id}/${String(p)}`);
      assert.equal(m.autonomousWeight(id, p), m.autonomousWeight(id, "balanced"));
    }
  }
  assert.equal(m.autonomousWeight("nope", "balanced"), 0);
  assert.equal(m.reactWeight("nope", "balanced"), 1);
  assert.equal(m.reactWeight("catch", "shy"), 1);
  assert.equal(m.autonomousWeight("searchMouse", "shy"), 1);
  const { brain, clock } = make({ rand: 0.6 });
  assert.deepEqual(pick(brain, clock, { personality: "zzz", available: new Set(["sitEdge"]) }), { id: "sitEdge" });
  assert.deepEqual(brain.pickAutonomous({ personality: "zzz", mode: "roam", available: new Set(["sitEdge"]), now: clock.t }), { id: "sitEdge" }, "null traits and state");
});

test("markPlayed: unknown id, NaN time, reset clears own-only cooldowns, canReact before any play", () => {
  const { brain, clock } = make();
  assert.equal(brain.canReact("fakeNap", clock.t), true);
  assert.equal(brain.canReact("nope", clock.t), true);
  brain.markPlayed("nope", clock.t);
  assert.equal(brain.canReact("nope", clock.t), true, "unknown ids have no cooldown");
  assert.equal(brain.isGlobalReady(clock.t), true, "unknown ids start no global cooldown");
  brain.markPlayed("pounce", NaN);
  assert.equal(brain.canReact("pounce", clock.t + 599999), false, "NaN falls back to now()");
  assert.equal(brain.canReact("pounce", clock.t + 600000), true);
  brain.markPlayed("searchMouse", clock.t, TRAITS);
  assert.equal(brain.canReact("searchMouse", clock.t + 1), false);
  assert.equal(brain.isGlobalReady(clock.t + 1), true);
  brain.reset();
  assert.equal(brain.canReact("searchMouse", clock.t + 1), true);
  assert.equal(brain.canReact("pounce", clock.t + 1), true);
});

// ---- coverage: pounce zone, poke, boo and bad samples ----

const TZONE = { leftX: 800, rightX: 1300, tipY: 550, tolY: 20 };

function zoneHit(x, y, zone = TZONE, over) {
  const { brain, clock } = make();
  at(brain, clock, x, y, 100, { pounceZone: zone, ...over });
  return at(brain, clock, x, y, 2500, { pounceZone: zone, ...over });
}

test("pounce strike zone boundaries", () => {
  assert.deepEqual(zoneHit(800, 550), { id: "pounce", side: "left" }, "leftX inclusive");
  assert.equal(zoneHit(799, 550), null);
  assert.equal(zoneHit(1000, 550), null, "rect.x exclusive");
  assert.equal(zoneHit(1100, 550), null, "right edge of the rect exclusive");
  assert.deepEqual(zoneHit(1101, 550), { id: "pounce", side: "right" });
  assert.deepEqual(zoneHit(1300, 550), { id: "pounce", side: "right" }, "rightX inclusive");
  assert.equal(zoneHit(1301, 550), null);
  assert.deepEqual(zoneHit(900, 570), { id: "pounce", side: "left" }, "tipY + tol inclusive");
  assert.deepEqual(zoneHit(900, 530), { id: "pounce", side: "left" }, "tipY - tol inclusive");
  assert.equal(zoneHit(900, 571), null);
  assert.equal(zoneHit(900, 529), null);
  assert.deepEqual(zoneHit(1301, 550, { ...TZONE, rightX: 1400 }), { id: "pounce", side: "right" });
});

test("pounce side comes from the zone and ignores the cursor's side of the pet center", () => {
  // Right of the rect but left of the center cannot happen; a wide pet checks the zone wins.
  assert.deepEqual(zoneHit(1101, 550, { ...TZONE, rightX: 1200 }), { id: "pounce", side: "right" });
  assert.deepEqual(zoneHit(900, 550), { id: "pounce", side: "left" });
});

test("an invalid strike zone falls back to the old band", () => {
  for (const bad of [{ ...TZONE, tolY: -1 }, { ...TZONE, tolY: NaN }, { ...TZONE, leftX: "800" }, {}, null]) {
    assert.deepEqual(zoneHit(1200, 550, bad), { id: "pounce", side: "right" }, JSON.stringify(bad));
    assert.equal(zoneHit(1100 + 39, 550, bad), null, "inside the band's near edge");
    assert.deepEqual(zoneHit(1100 + 40, 550, bad), { id: "pounce", side: "right" }, "band min inclusive");
    assert.deepEqual(zoneHit(1100 + 220, 550, bad), { id: "pounce", side: "right" }, "band max inclusive");
    assert.equal(zoneHit(1100 + 221, 550, bad), null);
  }
  assert.deepEqual(zoneHit(900, 550, null), { id: "pounce", side: "left" });
});

test("moving inside the strike zone keeps the dwell; toggling overPet resets it", () => {
  const { brain, clock } = make();
  const z = { pounceZone: TZONE };
  at(brain, clock, 900, 545, 100, z);
  at(brain, clock, 910, 555, 800, z);
  at(brain, clock, 880, 550, 800, z);
  assert.equal(at(brain, clock, 905, 560, 800, z), null);
  assert.deepEqual(at(brain, clock, 905, 560, 200, z), { id: "pounce", side: "left" }, "2.5 s of lurking while moving");

  const o = make();
  at(o.brain, o.clock, 900, 550, 100, z);
  at(o.brain, o.clock, 900, 550, 2000, z);
  assert.equal(at(o.brain, o.clock, 900, 550, 100, { ...z, overPet: true }), null);
  assert.equal(at(o.brain, o.clock, 900, 550, 2000, z), null, "dwell restarted after the overPet sample");
  assert.deepEqual(at(o.brain, o.clock, 900, 550, 2500, z), { id: "pounce", side: "left" });
});

test("pounce dwell is exactly 2500 ms and fires once while the cursor stays", () => {
  const { brain, clock } = make();
  at(brain, clock, 1200, 550, 100);
  assert.equal(at(brain, clock, 1200, 550, 2499), null);
  assert.deepEqual(at(brain, clock, 1200, 550, 1), { id: "pounce", side: "right" });
  assert.equal(at(brain, clock, 1200, 550, 1000), null);
  assert.equal(at(brain, clock, 1200, 550, 4000), null);
});

test("poke: sub-3 px jitter keeps the clock, 3 px resets it", () => {
  const jit = make();
  at(jit.brain, jit.clock, 1600, 550, 100);
  for (let i = 0; i < 19; i += 1) assert.equal(at(jit.brain, jit.clock, 1600 + (i % 2 ? 0 : 2.9), 550, 1000), null);
  assert.equal(at(jit.brain, jit.clock, 1600, 550, 1000).id, "poke", "20 s of jitter under 3 px");

  const mv = make();
  at(mv.brain, mv.clock, 1600, 550, 100);
  for (let i = 0; i < 19; i += 1) assert.equal(at(mv.brain, mv.clock, 1600 + (i % 2 ? 0 : 3), 550, 1000), null);
  assert.equal(at(mv.brain, mv.clock, 1600, 550, 1000), null, "3 px moves reset the clock every sample");
});

test("poke: exactly 300 px from the pet center does not fire, farther does", () => {
  const edge = make();
  at(edge.brain, edge.clock, 1350, 550, 100);
  for (let i = 0; i < 25; i += 1) assert.equal(at(edge.brain, edge.clock, 1350, 550, 1000), null);
  const far = make();
  at(far.brain, far.clock, 1351, 550, 100);
  assert.equal(hold(far.brain, far.clock, 1351, 550, 21000).id, "poke");
});

test("poke fires once per stillness, then again after movement and another 20 s", () => {
  const { brain, clock } = make();
  at(brain, clock, 1600, 550, 100);
  assert.equal(hold(brain, clock, 1600, 550, 21000).id, "poke");
  for (let i = 0; i < 40; i += 1) assert.equal(at(brain, clock, 1600, 550, 1000), null, "once");
  assert.equal(at(brain, clock, 1650, 550, 1000), null, "moved");
  assert.equal(hold(brain, clock, 1650, 550, 19000), null);
  assert.deepEqual(at(brain, clock, 1650, 550, 1000), { id: "poke", target: { x: 1650, y: 550 } });
});

test("bad samples return null and leave the clocks alone", () => {
  const { brain, clock } = make();
  at(brain, clock, 1200, 550, 100);
  for (const bad of [
    { x: NaN, y: 550, petRect: RECT }, { x: 1200, y: Infinity, petRect: RECT },
    { x: 1200, y: 550 }, { x: "1200", y: 550, petRect: RECT }, undefined, 0,
  ]) {
    clock.t += 200;
    assert.equal(brain.observeCursor(bad), null);
  }
  clock.t += 800; // 2.0 s after the first sample
  assert.equal(brain.observeCursor(sample(1200, 550)), null);
  clock.t += 600;
  assert.deepEqual(brain.observeCursor(sample(1200, 550)), { id: "pounce", side: "right" }, "dwell kept through the bad samples");
});

test("a single null between stills keeps the poke clock", () => {
  const { brain, clock } = make();
  at(brain, clock, 1600, 550, 100);
  assert.equal(hold(brain, clock, 1600, 550, 9000), null);
  clock.t += 1000;
  brain.observeCursor(null);
  assert.equal(hold(brain, clock, 1600, 550, 9000), null);
  assert.equal(at(brain, clock, 1600, 550, 2000).id, "poke");
});

test("a backwards clock step keeps the remaining cooldown, not a fresh full one", () => {
  const { brain, clock } = make();
  brain.markPlayed("pounce", clock.t);
  clock.t += 500000;
  assert.equal(brain.canReact("pounce", clock.t), false); // 100 s left
  clock.t -= 1;
  assert.equal(brain.canReact("pounce", clock.t), false, "a 1 ms step keeps it");
  const back = clock.t - 3600000;
  assert.equal(brain.canReact("pounce", back), false);
  assert.equal(brain.canReact("pounce", back + 99000), false);
  assert.equal(brain.canReact("pounce", back + 100100), true, "only the remaining 100 s, not the full 600 s");
});
