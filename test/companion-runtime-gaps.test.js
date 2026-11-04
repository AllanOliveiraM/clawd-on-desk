"use strict";

// Gap-hunting tests for the companion runtime: clock jumps, test-mode walk
// leftovers, work-pick memo identity, dispose, equivalence and boundaries.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createCompanionRuntime } = require("../src/companion-runtime");

function harness(keys, extra = {}) {
  let t = 0;
  const timers = [];
  let id = 0;
  const env = { state: "idle", gate: true, mode: "roam", gen: 0, sends: [], restores: 0, randomValue: 0.99, randomCalls: 0, storeCalls: [] };
  const anims = {};
  for (const k of keys) anims[k] = { files: [`${k}.svg`], duration: null };
  env.theme = { states: { idle: ["idle.svg"] }, companionAnimations: anims };
  env.setNow = (v) => { t = v; };
  env.now = () => t;
  env.advance = (ms) => {
    const target = t + ms;
    for (;;) {
      const due = timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1); t = due.at; due.fn();
    }
    t = target;
  };
  env.pendingTimers = () => timers.length;
  env.store = {
    load() { env.storeCalls.push(["load"]); return { state: null, restSpot: null }; },
    schedule(p) { env.storeCalls.push(["schedule", p]); },
    flush() { env.storeCalls.push(["flush"]); },
    remove() { env.storeCalls.push(["remove"]); },
  };
  env.runtime = createCompanionRuntime({
    getTheme: () => env.theme, getCurrentState: () => env.state, canPlay: () => env.gate,
    restoreIdleVisual: () => { env.restores += 1; }, isVisualGenerationCurrent: (g) => g === env.gen,
    sendToRenderer: (c, s, file, opts) => { env.gen += 1; env.sends.push({ file, opts, gen: env.gen }); return { visualGeneration: env.gen }; },
    getIdleMode: () => env.mode, isRoamAnimating: () => false,
    random: () => { env.randomCalls += 1; return env.randomValue; },
    now: () => t, setTimeout: (fn, ms) => { timers.push({ id: ++id, at: t + ms, fn }); return id; },
    clearTimeout: (x) => { const i = timers.findIndex((y) => y.id === x); if (i >= 0) timers.splice(i, 1); },
    store: extra.noStore ? null : env.store,
    ...extra.options,
  });
  env.commitLast = () => { const l = env.sends[env.sends.length - 1]; l.opts.onLogicalSettlement({ status: "committed", visualGeneration: l.gen }); };
  return env;
}
const ON = { enabled: true, personality: "playful", autonomy: true, interactions: true, memory: false };

// ---- 2 / 3: a clock that goes backwards ----

test("a backwards clock jump does not freeze roam through holdsRoam", () => {
  const env = harness(["greet"]);
  env.mode = "none";
  env.runtime.configure(ON);
  env.setNow(3600000);
  env.runtime.handleGesture("hover-dwell");
  env.commitLast();
  env.advance(3500);
  env.setNow(0);
  env.advance(5000);
  assert.equal(env.runtime.holdsRoam(), false);
});

test("searchMouse under XWayland waits only its own threshold after a backwards clock jump", () => {
  const env = harness(["searchMouse"], { options: { xwayland: true } });
  env.runtime.configure({ ...ON, mischief: true });
  env.setNow(3600000);
  env.runtime.tick({ x: 1, y: 1 });
  env.setNow(0);
  for (let i = 0; i < 40 && env.sends.length === 0; i += 1) { env.advance(1000); env.runtime.tick(null, { cursorTrusted: false }); }
  assert.equal(env.sends.length, 1);
});

test("a backwards clock jump re-bases the next beat and the mood clock", () => {
  const env = harness(["content", "tired", "grumpy", "curious", "shy", "greet", "petting"], { options: { getIdleMode: () => env.mode } });
  env.setNow(3600000);
  env.runtime.configure({ ...ON, memory: true });
  env.runtime.tick(); // arms nextBeatAt around 3.6e6 + delay
  env.setNow(0);
  for (let i = 0; i < 400 && env.sends.length === 0; i += 1) { env.advance(1000); env.runtime.tick(); }
  assert.equal(env.sends.length, 1, "the beat waited out the hour the clock went back");
  env.runtime.noteEvent("pet");
  const saved = env.storeCalls.filter((c) => c[0] === "schedule").pop()[1].state;
  assert.ok(saved.lastAdvanceAt <= env.now(), "lastAdvanceAt stays in the future");
});

test("a forward clock jump keeps the stamps (no re-base)", () => {
  const env = harness(["greet"]);
  env.mode = "none";
  env.runtime.configure(ON);
  env.setNow(1000);
  env.runtime.handleGesture("hover-dwell");
  env.commitLast();
  env.advance(3500);
  assert.equal(env.runtime.holdsRoam(), true, "inside the 1.5 s breather");
  env.advance(1500);
  assert.equal(env.runtime.holdsRoam(), false);
  env.setNow(env.now() + 9e6);
  assert.equal(env.runtime.holdsRoam(), false);
});

// ---- 4 / 17: leftovers of test mode and work picks ----

test("a test-mode walk variant does not survive disabling and re-enabling", () => {
  const env = harness(["walkBouncy"]);
  env.runtime.configure(ON);
  assert.deepEqual(env.runtime.debugPlay("walk", { variant: "walkBouncy" }), { ok: true });
  env.runtime.configure({ enabled: false });
  env.runtime.configure({ enabled: true });
  assert.notEqual(env.runtime.getRoamDelayMs(false, 4000), 0);
  assert.equal(env.runtime.pickWalkVisual(), null);
});

test("a test-mode walk variant does not survive reset()", () => {
  const env = harness(["walkBouncy"]);
  env.runtime.configure(ON);
  env.runtime.debugPlay("walk", { variant: "walkBouncy" });
  env.runtime.reset();
  assert.notEqual(env.runtime.getRoamDelayMs(false, 4000), 0);
  assert.equal(env.runtime.pickWalkVisual(), null);
});

test("a test-mode walk variant does not survive leaving Free Roam", () => {
  const env = harness(["walkBouncy"]);
  env.runtime.configure(ON);
  env.runtime.debugPlay("walk", { variant: "walkBouncy" });
  env.mode = "none";
  env.runtime.tick();
  assert.notEqual(env.runtime.getRoamDelayMs(false, 4000), 0);
  assert.equal(env.runtime.pickWalkVisual(), null);
});

test("a test-mode walk variant is spent by the one walk it was armed for", () => {
  const env = harness(["walkBouncy"]);
  env.runtime.configure(ON);
  env.runtime.debugPlay("walk", { variant: "walkBouncy" });
  assert.equal(env.runtime.pickWalkVisual(), "walkBouncy.svg");
  assert.notEqual(env.runtime.getRoamDelayMs(false, 4000), 0);
  assert.equal(env.runtime.pickWalkVisual(), null);
});

const tierBlock = () => ({ working: [{ minSessions: 1, files: ["f.svg"], variants: ["v1.svg"] }], juggling: [] });

test("a theme reload with an equal ladder keeps the held work pick", () => {
  let theme = { companionWorkTiers: tierBlock() };
  let r = 0.1;
  const rt = createCompanionRuntime({ getTheme: () => theme, random: () => r });
  rt.configure({ enabled: true, memory: false });
  assert.equal(rt.pickWorkVisual("working", { sessions: 1, episode: 0 }), "v1.svg");
  theme = { companionWorkTiers: tierBlock() };
  r = 0.9;
  assert.equal(rt.pickWorkVisual("working", { sessions: 1, episode: 0 }), "v1.svg");
  theme = { companionWorkTiers: { working: [{ minSessions: 1, files: ["other.svg"], variants: [] }], juggling: [] } };
  assert.equal(rt.pickWorkVisual("working", { sessions: 1, episode: 0 }), "other.svg", "a changed ladder rolls again");
});

test("disabling Clawd Alive clears the work picks eagerly", () => {
  const theme = { companionWorkTiers: tierBlock() };
  let r = 0.1;
  const rt = createCompanionRuntime({ getTheme: () => theme, random: () => r });
  rt.configure({ enabled: true, memory: false });
  assert.equal(rt.pickWorkVisual("working", { sessions: 1, episode: 0 }), "v1.svg");
  rt.configure({ enabled: false });
  rt.configure({ enabled: true });
  r = 0.9;
  assert.equal(rt.pickWorkVisual("working", { sessions: 1, episode: 0 }), "f.svg");
});
