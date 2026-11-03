"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createCompanionRuntime } = require("../src/companion-runtime");
const { DEFAULT_MOOD } = require("../src/companion-model");

function fakeClock() {
  let nowMs = 0;
  let nextId = 0;
  const timers = [];
  return {
    now: () => nowMs,
    get pendingTimers() { return timers.length; },
    setTimeout(fn, ms) {
      const timer = { id: ++nextId, at: nowMs + ms, fn };
      timers.push(timer);
      return timer.id;
    },
    clearTimeout(id) {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
    advance(ms) {
      const target = nowMs + ms;
      for (;;) {
        const due = timers
          .filter((timer) => timer.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        nowMs = due.at;
        due.fn();
      }
      nowMs = target;
    },
  };
}

const ALL_KEYS = ["petting", "content", "tired", "shy", "grumpy", "curious", "greet"];

function themeWith(keys = ALL_KEYS) {
  const companionAnimations = {};
  for (const key of keys) companionAnimations[key] = { files: [`${key}.svg`], duration: null };
  return { states: { idle: ["idle.svg"] }, companionAnimations };
}

function fakeStore(loaded) {
  const calls = [];
  return {
    calls,
    load() { calls.push(["load"]); return loaded || { state: null, restSpot: null }; },
    schedule(payload) { calls.push(["schedule", payload]); },
    flush() { calls.push(["flush"]); },
    remove() { calls.push(["remove"]); },
    dispose() { calls.push(["dispose"]); },
    count(name) { return calls.filter((c) => c[0] === name).length; },
  };
}

function setup(overrides = {}) {
  const clock = fakeClock();
  const env = {
    clock,
    state: "idle",
    gate: true,
    mode: "roam",
    roamAnimating: false,
    theme: themeWith(),
    generation: 0,
    sends: [],
    restores: 0,
    store: fakeStore(overrides.loaded),
    randomValue: 0.99,
  };
  const options = {
    getTheme: () => env.theme,
    getCurrentState: () => env.state,
    canPlay: () => env.gate,
    restoreIdleVisual: () => { env.restores += 1; },
    isVisualGenerationCurrent: (g) => g === env.generation,
    sendToRenderer: (channel, state, file, opts) => {
      env.generation += 1;
      env.sends.push({ channel, state, file, opts, generation: env.generation });
      return { visualGeneration: env.generation };
    },
    getIdleMode: () => env.mode,
    isRoamAnimating: () => env.roamAnimating,
    store: env.store,
    random: () => env.randomValue,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    ...overrides.options,
  };
  env.runtime = createCompanionRuntime(options);
  env.commitLast = () => {
    const last = env.sends[env.sends.length - 1];
    last.opts.onLogicalSettlement({ status: "committed", visualGeneration: last.generation });
  };
  return env;
}

const ON = { enabled: true, personality: "balanced", autonomy: true, interactions: true, memory: true };

// Arms the beat clock and runs ticks until a beat is sent (or the window ends).
function tickUntilBeat(env, maxMs = 400000) {
  env.runtime.tick();
  for (let t = 0; t < maxMs && env.sends.length === 0; t += 1000) {
    env.clock.advance(1000);
    env.runtime.tick();
  }
}

test("disabled runtime does nothing", () => {
  const env = setup();
  env.runtime.configure({ ...ON, enabled: false });
  const storeCallsAfterConfigure = env.store.calls.length;
  for (let i = 0; i < 400; i += 1) {
    env.clock.advance(1000);
    env.runtime.tick();
  }
  env.runtime.noteEvent("pet");
  env.runtime.noteEvent("clickBurst");
  env.runtime.handleGesture("pet-start");
  env.runtime.handleGesture("hover-dwell");
  env.runtime.noteDragEnd({ displayId: 1, x: 0.5, y: 0.5 });
  env.runtime.noteWalkFinished({ preferred: true });
  assert.equal(env.sends.length, 0);
  assert.equal(env.store.calls.length, 0);
  assert.equal(storeCallsAfterConfigure, 0);
  assert.equal(env.runtime.chooseIdleActivity({ theme: env.theme }), null);
  assert.equal(env.runtime.getRoamDelayMs(true, 8000), 8000);
  assert.equal(env.runtime.pickRoamTarget({ xMin: 0, xMax: 100, yMin: 0, yMax: 100 }), null);
  assert.equal(env.runtime.isAnimating(), false);
  assert.equal(env.clock.pendingTimers, 0);
});

test("stay-put mode never plays autonomously", () => {
  const env = setup();
  env.mode = "none";
  env.runtime.configure(ON);
  for (let i = 0; i < 3600; i += 1) {
    env.clock.advance(1000);
    env.runtime.tick();
  }
  assert.equal(env.sends.length, 0);
  assert.equal(env.runtime.chooseIdleActivity({ theme: env.theme }), null);
});

test("roam mode plays a beat after the delay and respects canPlay", () => {
  const env = setup();
  env.runtime.configure(ON);
  env.gate = false;
  tickUntilBeat(env);
  assert.equal(env.sends.length, 0);
  env.gate = true;
  env.runtime.tick();
  assert.equal(env.sends.length, 1);
  assert.equal(env.sends[0].channel, "state-change");
  assert.equal(env.sends[0].state, "idle");
  assert.match(env.sends[0].file, /\.svg$/);
  assert.equal(env.runtime.isAnimating(), true);
});

test("roam mode never plays while the roam is animating", () => {
  const env = setup();
  env.runtime.configure(ON);
  env.roamAnimating = true;
  tickUntilBeat(env);
  assert.equal(env.sends.length, 0);
  env.roamAnimating = false;
  env.runtime.tick();
  assert.equal(env.sends.length, 1);
});

test("beat waits for committed settlement before timing", () => {
  const env = setup();
  env.runtime.configure(ON);
  tickUntilBeat(env);
  assert.equal(env.sends.length, 1);
  env.clock.advance(20000);
  assert.equal(env.restores, 0, "no timer before settlement");
  env.commitLast();
  env.clock.advance(1999);
  assert.equal(env.restores, 0);
  env.clock.advance(10000);
  assert.equal(env.restores, 1);
  assert.equal(env.runtime.isAnimating(), false);
});

test("non-committed settlement abandons the beat without restoring", () => {
  const env = setup();
  env.runtime.configure(ON);
  tickUntilBeat(env);
  const last = env.sends[0];
  last.opts.onLogicalSettlement({ status: "superseded", visualGeneration: last.generation });
  assert.equal(env.runtime.isAnimating(), false);
  env.clock.advance(20000);
  assert.equal(env.restores, 0);
  assert.equal(env.clock.pendingTimers, 0);
});

test("stale beat never restores after newer generation", () => {
  const env = setup();
  env.runtime.configure(ON);
  tickUntilBeat(env);
  env.commitLast();
  env.generation += 1; // a real state change painted something newer
  assert.equal(env.runtime.isAnimating(), false);
  env.clock.advance(10000);
  assert.equal(env.restores, 0);
});

test("disabling mid-beat restores idle and clears timers", () => {
  const env = setup();
  env.runtime.configure(ON);
  tickUntilBeat(env);
  env.commitLast();
  assert.equal(env.clock.pendingTimers, 1);
  env.runtime.configure({ ...ON, enabled: false });
  assert.equal(env.restores, 1);
  assert.equal(env.clock.pendingTimers, 0);
  assert.equal(env.runtime.isAnimating(), false);
  assert.equal(env.store.count("flush"), 1);
  env.clock.advance(20000);
  assert.equal(env.restores, 1);
});

test("activities chooser returns skip for observe and null for themeActivity", () => {
  const env = setup();
  env.mode = "activities";
  env.runtime.configure(ON);
  // INTENTS order: observe first, so a tiny random picks observe.
  env.randomValue = 0;
  assert.deepEqual(env.runtime.chooseIdleActivity({ theme: env.theme }), { skip: true });
  // themeActivity is last in INTENTS, so random near 1 picks it.
  env.randomValue = 0.999;
  assert.equal(env.runtime.chooseIdleActivity({ theme: env.theme }), null);
});

test("activities chooser returns a companion file with clamped duration and cooldown", () => {
  const env = setup();
  env.mode = "activities";
  env.theme = themeWith(["curious"]);
  env.theme.companionAnimations.curious.duration = 60000;
  env.runtime.configure({ ...ON, personality: "curious" });
  // observe ~4.5, content 0, curious 1.8, themeActivity 2: pick inside curious.
  env.randomValue = 0.6;
  const choice = env.runtime.chooseIdleActivity({ theme: env.theme });
  assert.deepEqual(choice, { file: "curious.svg", durationMs: 8000 });
  // On cooldown now: the same random value can no longer land on curious.
  const again = env.runtime.chooseIdleActivity({ theme: env.theme });
  assert.notDeepEqual(again, choice);
  assert.equal(env.sends.length, 0, "the chooser never plays by itself");
});

test("activities chooser is null in roam mode and without autonomy", () => {
  const env = setup();
  env.runtime.configure(ON);
  assert.equal(env.runtime.chooseIdleActivity({ theme: env.theme }), null);
  env.mode = "activities";
  env.runtime.configure({ ...ON, autonomy: false });
  assert.equal(env.runtime.chooseIdleActivity({ theme: env.theme }), null);
  assert.equal(env.runtime.getRoamDelayMs(false, 4000), 4000);
});

test("missing theme animation degrades to observe", () => {
  const env = setup();
  env.theme = { states: { idle: ["idle.svg"] } };
  env.runtime.configure(ON);
  for (let i = 0; i < 3600; i += 1) {
    env.clock.advance(1000);
    env.runtime.tick();
  }
  env.runtime.handleGesture("pet-start");
  env.runtime.handleGesture("hover-dwell");
  assert.equal(env.sends.length, 0);
  env.mode = "activities";
  env.randomValue = 0;
  assert.deepEqual(env.runtime.chooseIdleActivity({ theme: env.theme }), { skip: true });
});

test("petting plays, continues and ends; mood registers without visual when gate closed", () => {
  const env = setup();
  env.mode = "none";
  env.runtime.configure(ON);
  const before = env.runtime.getMood().contentment;
  env.runtime.handleGesture("pet-start");
  assert.equal(env.sends.length, 1);
  assert.equal(env.sends[0].file, "petting.svg");
  assert.ok(env.runtime.getMood().contentment > before);
  env.commitLast();
  // Loop: after the 2000 ms default duration the same file is sent again.
  env.clock.advance(1000);
  env.runtime.handleGesture("pet-continue");
  env.clock.advance(1000);
  assert.equal(env.sends.length, 2);
  assert.equal(env.sends[1].file, "petting.svg");
  assert.equal(env.restores, 0);
  env.commitLast();
  env.runtime.handleGesture("pet-end");
  assert.equal(env.restores, 1);
  assert.equal(env.runtime.isAnimating(), false);
  assert.equal(env.clock.pendingTimers, 0);

  // Inactivity ends a session after 3000 ms without pet-continue.
  env.runtime.handleGesture("pet-start");
  env.commitLast();
  env.clock.advance(3000);
  assert.equal(env.runtime.isAnimating(), false);
  assert.equal(env.clock.pendingTimers, 0);

  // Gate closed: mood still registers, no visual.
  env.gate = false;
  const sends = env.sends.length;
  const c0 = env.runtime.getMood().contentment;
  env.runtime.handleGesture("pet-start");
  env.runtime.handleGesture("pet-continue");
  assert.equal(env.sends.length, sends);
  assert.ok(env.runtime.getMood().contentment > c0);
});

test("petting takes over a playing beat", () => {
  const env = setup();
  env.runtime.configure(ON);
  tickUntilBeat(env);
  env.commitLast();
  env.runtime.handleGesture("pet-start");
  assert.equal(env.sends.length, 2);
  assert.equal(env.sends[1].file, "petting.svg");
  env.commitLast();
  assert.equal(env.clock.pendingTimers, 2, "petting duration + inactivity timers only");
});

test("shy pet with low familiarity answers petting with shy", () => {
  const env = setup();
  env.runtime.configure({ ...ON, personality: "shy" });
  env.runtime.handleGesture("pet-start");
  assert.equal(env.sends[0].file, "shy.svg");
});

test("interactions off ignores gestures but clicks still change mood", () => {
  const env = setup();
  env.runtime.configure({ ...ON, interactions: false });
  const before = env.runtime.getMood();
  env.runtime.handleGesture("pet-start");
  env.runtime.handleGesture("hover-dwell");
  assert.equal(env.sends.length, 0);
  assert.equal(env.runtime.getMood().contentment, before.contentment);
  env.runtime.noteEvent("clickBurst");
  assert.ok(env.runtime.getMood().contentment < before.contentment);
});

test("hover dwell fires at most once per minute", () => {
  const env = setup();
  env.mode = "none";
  env.runtime.configure({ ...ON, personality: "playful" });
  env.runtime.handleGesture("hover-dwell");
  assert.equal(env.sends.length, 1);
  assert.equal(env.sends[0].file, "greet.svg");
  env.commitLast();
  env.clock.advance(10000);
  env.runtime.handleGesture("hover-dwell");
  assert.equal(env.sends.length, 1);
  env.clock.advance(51000);
  env.runtime.handleGesture("hover-dwell");
  assert.equal(env.sends.length, 2);

  const calm = setup();
  calm.runtime.configure({ ...ON, personality: "balanced" });
  calm.runtime.handleGesture("hover-dwell");
  assert.equal(calm.sends.length, 0);

  const shy = setup();
  shy.runtime.configure({ ...ON, personality: "shy" });
  shy.runtime.handleGesture("hover-dwell");
  assert.equal(shy.sends[0].file, "shy.svg");
});

test("memory off removes file and never schedules writes", () => {
  const env = setup();
  env.runtime.configure({ ...ON, memory: false });
  assert.equal(env.store.count("remove"), 1);
  assert.equal(env.store.count("load"), 0);
  env.runtime.noteEvent("pet");
  env.runtime.noteDragEnd({ displayId: 1, x: 0.2, y: 0.8 });
  env.runtime.configure({ ...ON, memory: false });
  assert.equal(env.store.count("schedule"), 0);
  assert.equal(env.store.count("remove"), 1, "idempotent configure");

  const on = setup();
  on.runtime.configure(ON);
  assert.equal(on.store.count("load"), 1);
  on.runtime.noteEvent("pet");
  assert.ok(on.store.count("schedule") >= 1);
  on.runtime.configure({ ...ON, memory: false });
  assert.equal(on.store.count("remove"), 1);
});

test("loaded state is used and restSpot persisted", () => {
  const loaded = {
    state: { mood: { energy: 20, contentment: 90, familiarity: 42 }, label: "content", streak: null, lastAdvanceAt: null, lastInteractionAt: null },
    restSpot: { displayId: 7, x: 0.25, y: 0.75 },
  };
  const env = setup({ loaded });
  env.runtime.configure(ON);
  assert.equal(env.runtime.getMood().familiarity, 42);
  assert.deepEqual(env.runtime.getRestSpot(), loaded.restSpot);
  env.runtime.noteDragEnd({ displayId: 2, x: 0.5, y: 0.1 });
  const last = env.store.calls.filter((c) => c[0] === "schedule").pop();
  assert.deepEqual(last[1].restSpot, { displayId: 2, x: 0.5, y: 0.1 });
});

test("reset restores defaults and removes file without touching configure state", () => {
  const env = setup();
  env.runtime.configure({ ...ON, personality: "playful" });
  env.runtime.noteEvent("pet");
  env.runtime.noteDragEnd({ displayId: 1, x: 0.3, y: 0.3 });
  env.runtime.handleGesture("pet-start");
  env.commitLast();
  env.runtime.reset();
  assert.deepEqual(env.runtime.getMood(), { ...DEFAULT_MOOD });
  assert.equal(env.runtime.getRestSpot(), null);
  assert.equal(env.store.count("remove"), 1);
  assert.equal(env.restores, 1);
  assert.equal(env.clock.pendingTimers, 0);
  // Still enabled with the same personality: a playful hover still greets.
  env.runtime.handleGesture("hover-dwell");
  assert.equal(env.sends[env.sends.length - 1].file, "greet.svg");
});

test("personality change applies without resetting mood", () => {
  const env = setup();
  env.runtime.configure(ON);
  env.runtime.noteEvent("pet");
  env.runtime.noteEvent("pet");
  const mood = env.runtime.getMood();
  env.runtime.configure({ ...ON, personality: "shy" });
  assert.deepEqual(env.runtime.getMood(), mood);
  assert.equal(env.store.count("load"), 1, "no reload on personality change");
  env.runtime.handleGesture("hover-dwell");
  assert.equal(env.sends[0].file, "shy.svg");
});

test("getRoamDelayMs scales with personality", () => {
  const env = setup();
  env.runtime.configure({ ...ON, personality: "calm" });
  assert.ok(env.runtime.getRoamDelayMs(false, 8000) > 8000);
  env.runtime.configure({ ...ON, personality: "playful" });
  assert.ok(env.runtime.getRoamDelayMs(false, 8000) < 8000);
});

test("pickRoamTarget returns rest spot when tired, explores when curious, else null", () => {
  const loaded = {
    state: { mood: { energy: 20, contentment: 55, familiarity: 0 }, label: "tired", streak: null, lastAdvanceAt: null, lastInteractionAt: null },
    restSpot: { displayId: 2, x: 0.5, y: 0.5 },
  };
  const env = setup({
    loaded,
    options: { getDisplayWorkArea: (id) => (id === 2 ? { x: 1000, y: 0, width: 1000, height: 800 } : null) },
  });
  env.runtime.configure(ON);
  const args = {
    xMin: 0, xMax: 1900, yMin: 0, yMax: 700,
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    size: { width: 100, height: 100 },
    displayId: 1,
    workArea: { x: 0, y: 0, width: 2000, height: 800 },
  };
  assert.deepEqual(env.runtime.pickRoamTarget(args), { x: 1450, y: 350, preferred: true });
  // Clamped into the allowed window range.
  assert.deepEqual(env.runtime.pickRoamTarget({ ...args, xMax: 1200 }), { x: 1200, y: 350, preferred: true });

  // Not tired: exploration with probability curiosity * 0.6 (balanced 0.3).
  const exp = setup();
  exp.runtime.configure(ON);
  exp.randomValue = 0.1;
  const target = exp.runtime.pickRoamTarget(args);
  assert.equal(target.preferred, false);
  // Pet sits in the top-left cell, so the least-visited cell is another one.
  assert.ok(!(target.x < 600 && target.y < 216));
  assert.ok(target.x >= 0 && target.x <= 1900 && target.y >= 0 && target.y <= 700);
  exp.randomValue = 0.9;
  assert.equal(exp.runtime.pickRoamTarget(args), null);
});

test("walk to preferred spot with low energy forces a tired beat soon", () => {
  const loaded = {
    state: { mood: { energy: 40, contentment: 55, familiarity: 0 }, label: "neutral", streak: null, lastAdvanceAt: null, lastInteractionAt: null },
    restSpot: null,
  };
  const env = setup({ loaded });
  env.runtime.configure(ON);
  env.runtime.tick(); // arms the regular (long) beat clock
  env.runtime.noteWalkFinished({ preferred: true });
  env.clock.advance(1000);
  env.runtime.tick();
  assert.equal(env.sends.length, 1);
  assert.equal(env.sends[0].file, "tired.svg");
});

test("dispose cancels timers, flushes and turns every method into a no-op", () => {
  const env = setup();
  env.runtime.configure(ON);
  env.runtime.handleGesture("pet-start");
  env.commitLast();
  env.runtime.dispose();
  assert.equal(env.clock.pendingTimers, 0);
  assert.equal(env.store.count("flush"), 1);
  const calls = env.store.calls.length;
  const sends = env.sends.length;
  env.runtime.configure({ ...ON, personality: "shy" });
  env.runtime.tick();
  env.runtime.noteEvent("pet");
  env.runtime.handleGesture("pet-start");
  env.runtime.reset();
  env.runtime.dispose();
  assert.equal(env.store.calls.length, calls);
  assert.equal(env.sends.length, sends);
  assert.equal(env.runtime.chooseIdleActivity({}), null);
  assert.equal(env.runtime.getRoamDelayMs(true, 8000), 8000);
});

test("one hour of roaming keeps energy healthy", () => {
  const loaded = { state: null, restSpot: { displayId: null, x: 0.5, y: 0.5 } };
  const env = setup({ loaded });
  env.runtime.configure(ON); // balanced
  const workArea = { x: 0, y: 0, width: 2000, height: 1000 };
  const size = { width: 100, height: 100 };
  const restTarget = { x: 950, y: 450 };
  let pos = { x: 100, y: 100 };
  let calls = 0;
  let holds = 0;
  let isFirst = true;
  for (let t = 0; t < 3600 * 1000; t += 10000) {
    env.runtime.getRoamDelayMs(isFirst, 4000);
    isFirst = false;
    env.clock.advance(10000);
    calls += 1;
    const target = env.runtime.pickRoamTarget({
      xMin: 0, xMax: 1900, yMin: 0, yMax: 900,
      bounds: { ...pos, ...size }, size, displayId: null, workArea,
    });
    if (target && target.preferred && Math.hypot(target.x - pos.x, target.y - pos.y) < 100) {
      holds += 1; // roam holds: already at the rest spot
      continue;
    }
    pos = target ? { x: target.x, y: target.y } : (pos.x === restTarget.x ? { x: 100, y: 100 } : { x: 1500, y: 700 });
    env.runtime.noteWalkFinished({ preferred: !!(target && target.preferred) });
  }
  const energy = env.runtime.getMood().energy;
  assert.ok(energy >= 40, `energy ${energy}`);
  assert.ok(holds <= calls * 0.1, `holds ${holds} of ${calls}`);
});

test("rest-spot hold yields to a normal walk after three consecutive holds", () => {
  const loaded = {
    state: { mood: { energy: 10, contentment: 55, familiarity: 0 }, label: "tired", streak: null, lastAdvanceAt: null, lastInteractionAt: null },
    restSpot: { displayId: null, x: 0.5, y: 0.5 },
  };
  const env = setup({ loaded });
  env.runtime.configure(ON);
  const args = {
    xMin: 0, xMax: 1900, yMin: 0, yMax: 900,
    bounds: { x: 950, y: 450, width: 100, height: 100 },
    size: { width: 100, height: 100 },
    displayId: null,
    workArea: { x: 0, y: 0, width: 2000, height: 1000 },
  };
  const results = [];
  for (let i = 0; i < 8; i++) results.push(env.runtime.pickRoamTarget(args));
  assert.deepEqual(results.map((r) => (r ? "rest" : "walk")), ["rest", "rest", "rest", "walk", "rest", "rest", "rest", "walk"]);
});
