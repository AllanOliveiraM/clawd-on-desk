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

test("petting loop stops re-sending when the gate closes but keeps the session for mood", () => {
  const env = setup();
  env.mode = "none";
  env.runtime.configure(ON);
  env.runtime.handleGesture("pet-start");
  env.commitLast();
  assert.equal(env.sends.length, 1);
  env.gate = false;
  env.clock.advance(1000);
  env.runtime.handleGesture("pet-continue");
  env.clock.advance(1000); // petting duration ends while the gate is closed
  assert.equal(env.sends.length, 1, "no re-send through a closed gate");
  assert.equal(env.restores, 1, "our petting visual is replaced by idle");
  assert.equal(env.runtime.isAnimating(), false);
  // Session still alive: strokes keep raising contentment and keep the timer.
  const c0 = env.runtime.getMood().contentment;
  env.runtime.handleGesture("pet-continue");
  assert.ok(env.runtime.getMood().contentment > c0);
  assert.equal(env.clock.pendingTimers, 1, "inactivity timer only");
});

test("petting loop does not restore idle when a newer visual owns the screen", () => {
  const env = setup();
  env.mode = "none";
  env.runtime.configure(ON);
  env.runtime.handleGesture("pet-start");
  env.commitLast();
  env.gate = false;
  env.generation += 1; // someone else painted
  env.clock.advance(2000);
  assert.equal(env.sends.length, 1);
  assert.equal(env.restores, 0);
});

test("an active petting session blocks beats and idle activities even without a visual", () => {
  const env = setup();
  env.runtime.configure(ON);
  env.gate = false;
  env.runtime.handleGesture("pet-start"); // session, no visual (gate closed)
  env.gate = true;
  for (let i = 0; i < 2; i += 1) {
    env.runtime.handleGesture("pet-continue");
    env.runtime.tick();
    env.clock.advance(1000);
  }
  // Keep stroking for a long time: no beat may start mid-session.
  for (let i = 0; i < 400; i += 1) {
    env.runtime.handleGesture("pet-continue");
    env.clock.advance(1000);
    env.runtime.tick();
  }
  assert.equal(env.sends.filter((s) => s.file !== "petting.svg").length, 0);
  env.mode = "activities";
  assert.deepEqual(env.runtime.chooseIdleActivity({ theme: env.theme }), { skip: true });
});

test("idle activities skip while a petting visual plays even without autonomy", () => {
  const env = setup();
  env.mode = "activities";
  env.runtime.configure({ ...ON, autonomy: false });
  env.runtime.handleGesture("pet-start");
  env.commitLast();
  assert.deepEqual(env.runtime.chooseIdleActivity({ theme: env.theme }), { skip: true });
  env.runtime.handleGesture("pet-end");
  assert.equal(env.runtime.chooseIdleActivity({ theme: env.theme }), null);
  // Disabled: nothing can be playing, chooser keeps the original path.
  env.runtime.configure({ ...ON, enabled: false });
  assert.equal(env.runtime.chooseIdleActivity({ theme: env.theme }), null);
});

test("hover greet never interrupts another idle visual", () => {
  let other = true;
  const env = setup({ options: { isOtherIdleVisualPlaying: () => other } });
  env.mode = "none";
  env.runtime.configure({ ...ON, personality: "playful" });
  env.runtime.handleGesture("hover-dwell");
  assert.equal(env.sends.length, 0);
  other = false;
  env.runtime.handleGesture("hover-dwell");
  assert.equal(env.sends.length, 1, "no cooldown was spent while blocked");
  // Petting may still take over by design.
  const pet = setup({ options: { isOtherIdleVisualPlaying: () => true } });
  pet.mode = "none";
  pet.runtime.configure(ON);
  pet.runtime.handleGesture("pet-start");
  assert.equal(pet.sends.length, 1);
});

test("a discarded explore target is not credited to the visit grid", () => {
  const env = setup();
  env.runtime.configure({ ...ON, personality: "curious" });
  env.randomValue = 0.1; // explore
  const args = {
    xMin: 0, xMax: 1900, yMin: 0, yMax: 700,
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    size: { width: 100, height: 100 },
    displayId: 1,
    workArea: { x: 0, y: 0, width: 2000, height: 800 },
  };
  const first = env.runtime.pickRoamTarget(args);
  assert.equal(first.preferred, false);
  env.runtime.onPreferredTargetDiscarded();
  env.runtime.noteWalkFinished({ preferred: false });
  // Not credited: the same least-visited cell is still the explore answer.
  const second = env.runtime.pickRoamTarget(args);
  assert.deepEqual(second, first);

  // Credited (control): after a real arrival the next explore picks another cell.
  const ctl = setup();
  ctl.runtime.configure({ ...ON, personality: "curious" });
  ctl.randomValue = 0.1;
  const a = ctl.runtime.pickRoamTarget(args);
  ctl.runtime.noteWalkFinished({ preferred: false });
  assert.notDeepEqual(ctl.runtime.pickRoamTarget(args), a);
});

test("tick checks the beat clock before asking canPlay", () => {
  let gateCalls = 0;
  const env = setup({ options: { canPlay: () => { gateCalls += 1; return true; } } });
  env.runtime.configure(ON);
  env.runtime.tick(); // arms the clock
  env.clock.advance(1000);
  env.runtime.tick();
  assert.equal(gateCalls, 0);
});

test("noteIdleEntered restarts the beat delay", () => {
  const env = setup();
  env.runtime.configure(ON);
  env.runtime.tick(); // arms the clock at t=0
  // Find when the beat would have fired, then re-enter idle just before it.
  const probe = setup();
  probe.runtime.configure(ON);
  tickUntilBeat(probe);
  const firesAt = probe.clock.now();
  env.clock.advance(firesAt - 1000);
  env.runtime.noteIdleEntered();
  env.clock.advance(1000);
  env.runtime.tick();
  assert.equal(env.sends.length, 0, "fresh delay after a new idle entry");
  env.clock.advance(firesAt);
  env.runtime.tick();
  assert.equal(env.sends.length, 1);
  // Disabled: a no-op without computation.
  const off = setup();
  off.runtime.configure({ ...ON, enabled: false });
  off.runtime.noteIdleEntered();
  assert.equal(off.clock.pendingTimers, 0);
});

// ---- mischief (scenes) ----

const MISCHIEF_KEYS = [
  "catch", "catchMiss", "pounceLeft", "pounceRight", "fakeNap", "boo",
  "pokeLeft", "pokeRight", "reachClose", "wallPushLeft", "wallPushRight",
  "wallPeekLeft", "wallPeekRight", "sitEdge", "morningStretch", "coffee",
  "nightSleepy", "welcome", "stretchBack", "toyBall", "toyYoyo", "toyPlane",
];
const MON = { ...ON, mischief: true };
const PET_RECT = { x: 500, y: 500, width: 100, height: 100 };
const ROAM_ARGS = {
  xMin: 0, xMax: 1900, yMin: 0, yMax: 900,
  bounds: { x: 950, y: 450, width: 100, height: 100 },
  size: { width: 100, height: 100 },
  displayId: null,
  workArea: { x: 0, y: 0, width: 2000, height: 1000 },
};

function sample(x, y, overPet = false) {
  return { x, y, petRect: { ...PET_RECT }, overPet };
}

// Ticks with the same cursor sample every 250 ms for `ms`.
function tickWithCursor(env, cursor, ms) {
  for (let t = 0; t < ms; t += 250) {
    env.clock.advance(250);
    env.runtime.tick(cursor);
  }
}

// Advances time in small steps, committing every new (uncommitted) send right away.
function runCommitting(env, ms, step = 250) {
  const commitPending = () => {
    const last = env.sends[env.sends.length - 1];
    if (last && !last.committedByHelper) {
      last.committedByHelper = true;
      env.commitLast();
    }
  };
  for (let t = 0; t < ms; t += step) {
    commitPending();
    env.clock.advance(step);
  }
  commitPending();
}

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test("mischief off is identical to Clawd Alive", () => {
  // Same script and theme (with mischief art) twice: once with mischief:false
  // and every new input; once the way Clawd Alive was driven. Sends, restores
  // and answers match.
  function run(withExtras) {
    const env = setup({ options: { random: lcg(7) } });
    env.theme = themeWith([...ALL_KEYS, ...MISCHIEF_KEYS]);
    const log = [];
    const cfg = withExtras ? { ...ON, personality: "playful", mischief: false } : { ...ON, personality: "playful" };
    env.runtime.configure(cfg);
    env.runtime.handleGesture("hover-dwell");
    if (withExtras) env.runtime.handleGesture("hover-move");
    env.commitLast();
    for (let i = 0; i < 1200; i += 1) {
      env.clock.advance(500);
      if (env.sends.length && !env.sends[env.sends.length - 1].committedSeen) {
        env.sends[env.sends.length - 1].committedSeen = true;
        env.commitLast();
      }
      const cursor = i < 600 ? sample(700, 550) : sample(1500, 1200);
      env.runtime.tick(withExtras ? cursor : undefined);
    }
    env.runtime.noteIdleEntered(withExtras ? { from: "sleep", awayMs: 9e6 } : undefined);
    for (let i = 0; i < 100; i += 1) {
      env.clock.advance(1000);
      env.runtime.tick(withExtras ? sample(700, 550) : undefined);
    }
    log.push(env.runtime.getRoamDelayMs(false, 8000));
    log.push(env.runtime.pickRoamTarget(ROAM_ARGS));
    env.runtime.noteWalkFinished(withExtras
      ? { preferred: true, mischief: "reachClose", reachedEdgeDistancePx: 0 }
      : { preferred: true });
    env.runtime.handleGesture("hover-dwell");
    env.mode = "activities";
    for (let i = 0; i < 20; i += 1) log.push(env.runtime.chooseIdleActivity({ theme: env.theme }));
    log.push(env.runtime.getMood());
    return { sends: env.sends.map((s) => s.file), restores: env.restores, log, timers: env.clock.pendingTimers };
  }
  const off = run(true);
  const alive = run(false);
  assert.ok(alive.sends.length > 1, "the script exercises real playback");
  assert.deepEqual(off, alive);
});

test("hover dwell plays catch and a move turns it into catchMiss", () => {
  const env = setup();
  env.mode = "none";
  env.theme = themeWith([...ALL_KEYS, ...MISCHIEF_KEYS]);
  env.runtime.configure(MON); // balanced: no greet today, catch with mischief
  env.runtime.handleGesture("hover-dwell");
  assert.equal(env.sends.length, 1);
  assert.equal(env.sends[0].file, "catch.svg");
  env.commitLast();
  env.clock.advance(500);
  env.runtime.handleGesture("hover-move");
  assert.equal(env.sends.length, 2);
  assert.equal(env.sends[1].file, "catchMiss.svg");
  assert.equal(env.restores, 0, "the miss takes the visual over directly");
  env.runtime.handleGesture("hover-move"); // at most one switch per scene
  assert.equal(env.sends.length, 2);
  env.commitLast();
  env.clock.advance(3500);
  assert.equal(env.restores, 1);
  assert.equal(env.runtime.isAnimating(), false);
  assert.equal(env.clock.pendingTimers, 0);
  // catch is on its 90 s cooldown: a balanced pet falls back to today's hover (nothing).
  env.runtime.handleGesture("hover-dwell");
  assert.equal(env.sends.length, 2);
  // A move outside a catch scene does nothing.
  env.runtime.handleGesture("hover-move");
  assert.equal(env.sends.length, 2);
  env.clock.advance(90000);
  env.runtime.handleGesture("hover-dwell");
  assert.equal(env.sends[2].file, "catch.svg");
});

test("shy hover still plays shy", () => {
  const env = setup();
  env.mode = "none";
  env.theme = themeWith([...ALL_KEYS, ...MISCHIEF_KEYS]);
  env.runtime.configure({ ...MON, personality: "shy" });
  env.runtime.handleGesture("hover-dwell");
  assert.equal(env.sends.length, 1);
  assert.equal(env.sends[0].file, "shy.svg");
  env.runtime.handleGesture("hover-move");
  assert.equal(env.sends.length, 1);
});

test("pounce plays the side-correct file", () => {
  for (const [x, file] of [[700, "pounceRight.svg"], [400, "pounceLeft.svg"]]) {
    const env = setup();
    env.mode = "none";
    env.theme = themeWith(MISCHIEF_KEYS);
    env.runtime.configure({ ...MON, personality: "playful" });
    tickWithCursor(env, sample(x, 550), 2000);
    assert.equal(env.sends.length, 0, "not before 2.5 s in the band");
    tickWithCursor(env, sample(x, 550), 1000);
    assert.equal(env.sends.length, 1);
    assert.equal(env.sends[0].file, file);
  }
  // Shy never pounces; interactions off never pounces.
  for (const cfg of [{ ...MON, personality: "shy" }, { ...MON, personality: "playful", interactions: false }]) {
    const env = setup();
    env.mode = "none";
    env.theme = themeWith(MISCHIEF_KEYS);
    env.runtime.configure(cfg);
    tickWithCursor(env, sample(700, 550), 5000);
    assert.equal(env.sends.length, 0);
  }
});

test("fake nap loops until cursor approach then boo", () => {
  const env = setup();
  env.theme = themeWith(["fakeNap", "boo"]);
  env.runtime.configure({ ...MON, personality: "playful" });
  tickUntilBeat(env);
  assert.equal(env.sends.length, 1);
  assert.equal(env.sends[0].file, "fakeNap.svg");
  env.commitLast();
  env.clock.advance(3500);
  assert.equal(env.sends.length, 2, "the loop re-sends the nap");
  assert.equal(env.sends[1].file, "fakeNap.svg");
  assert.equal(env.restores, 0);
  env.commitLast();
  env.runtime.tick(sample(1200, 550)); // far away: keeps napping
  assert.equal(env.sends.length, 2);
  env.clock.advance(250);
  env.runtime.tick(sample(650, 550)); // sneaks up
  assert.equal(env.sends.length, 3);
  assert.equal(env.sends[2].file, "boo.svg");
  env.commitLast();
  env.clock.advance(3500);
  assert.equal(env.restores, 1);
  assert.equal(env.clock.pendingTimers, 0);

  // Without an approach the nap ends at 20 s.
  const nap = setup();
  nap.theme = themeWith(["fakeNap"]);
  nap.runtime.configure({ ...MON, personality: "playful" });
  tickUntilBeat(nap);
  const startedAt = nap.clock.now();
  runCommitting(nap, 25000);
  assert.ok(nap.sends.every((s) => s.file === "fakeNap.svg"));
  assert.equal(nap.sends.length, 6);
  assert.equal(nap.restores, 1);
  assert.ok(nap.clock.now() - startedAt >= 20000);
  assert.equal(nap.runtime.isAnimating(), false);
});

test("real state change mid-scene kills every part", () => {
  const env = setup();
  env.theme = themeWith(["fakeNap", "boo"]);
  env.runtime.configure({ ...MON, personality: "playful" });
  tickUntilBeat(env);
  env.commitLast();
  env.generation += 1; // a real event painted something newer
  env.runtime.tick(sample(650, 550)); // even a boo trigger cannot revive the scene
  env.clock.advance(30000);
  assert.equal(env.sends.length, 1);
  assert.equal(env.restores, 0);
  assert.equal(env.clock.pendingTimers, 0);
  assert.equal(env.runtime.isAnimating(), false);

  // Catch: a move after a newer generation never sends the miss nor restores.
  const hover = setup();
  hover.mode = "none";
  hover.theme = themeWith(MISCHIEF_KEYS);
  hover.runtime.configure(MON);
  hover.runtime.handleGesture("hover-dwell");
  hover.commitLast();
  hover.generation += 1;
  hover.runtime.handleGesture("hover-move");
  hover.clock.advance(10000);
  assert.equal(hover.sends.length, 1);
  assert.equal(hover.restores, 0);
  assert.equal(hover.clock.pendingTimers, 0);

  // Logical state left idle between loop iterations: no re-send, no restore.
  const work = setup();
  work.theme = themeWith(["sitEdge"]);
  work.runtime.configure(MON);
  tickUntilBeat(work, 200000);
  work.runtime.pickRoamTarget(ROAM_ARGS);
  work.runtime.noteWalkFinished({ preferred: true, mischief: "sitEdge", reachedEdgeDistancePx: 0 });
  assert.equal(work.sends.length, 1);
  work.commitLast();
  work.state = "working";
  work.clock.advance(30000);
  assert.equal(work.sends.length, 1);
  assert.equal(work.restores, 0);
  assert.equal(work.clock.pendingTimers, 0);
});

test("welcome waits for the gate up to 60 s then drops", () => {
  const env = setup();
  env.theme = themeWith(["welcome"]);
  env.runtime.configure(MON);
  env.gate = false;
  env.runtime.noteIdleEntered({ from: "sleep", awayMs: 3600000 });
  for (let i = 0; i < 59; i += 1) {
    env.clock.advance(1000);
    env.runtime.tick();
  }
  assert.equal(env.sends.length, 0);
  env.gate = true;
  env.runtime.tick();
  assert.equal(env.sends.length, 1);
  assert.equal(env.sends[0].file, "welcome.svg");

  const late = setup();
  late.theme = themeWith(["welcome"]);
  late.runtime.configure(MON);
  late.gate = false;
  late.runtime.noteIdleEntered({ from: "sleep", awayMs: 3600000 });
  for (let i = 0; i < 61; i += 1) {
    late.clock.advance(1000);
    late.runtime.tick();
  }
  late.gate = true;
  late.runtime.tick();
  late.clock.advance(1000);
  late.runtime.tick();
  assert.equal(late.sends.length, 0);
});

test("stretch only after long work", () => {
  const cases = [
    [{ from: "work", awayMs: 599999 }, 0],
    [{ from: "other", awayMs: 9e6 }, 0],
    [{ from: "work", awayMs: 600000 }, 1],
  ];
  for (const [info, expected] of cases) {
    const env = setup();
    env.theme = themeWith(["stretchBack", "welcome"]);
    env.runtime.configure(MON);
    env.runtime.noteIdleEntered(info);
    env.clock.advance(1000);
    env.runtime.tick();
    assert.equal(env.sends.length, expected, JSON.stringify(info));
    if (expected) assert.equal(env.sends[0].file, "stretchBack.svg");
  }
});

test("walking mischief shortens the roam delay and targets the right corner per platform", () => {
  // Inset from the corner: 1.5 pet widths from the side, 0.4 pet heights from the top.
  for (const [platform, x] of [["linux", 1750], ["win32", 1750], ["darwin", 150]]) {
    const env = setup({ options: { getPlatform: () => platform } });
    env.theme = themeWith(["reachClose"]);
    env.runtime.configure(MON); // balanced: 8000 * 1.1
    assert.equal(env.runtime.getRoamDelayMs(false, 8000), 8800);
    tickUntilBeat(env, 200000);
    assert.equal(env.sends.length, 0, "a walking mischief waits for the roam");
    assert.equal(env.runtime.getRoamDelayMs(false, 8000), 4000);
    const target = env.runtime.pickRoamTarget(ROAM_ARGS);
    assert.deepEqual(target, { x, y: 40, preferred: true, mischief: "reachClose" });
    assert.equal(env.runtime.getRoamDelayMs(false, 8000), 8800);
    env.runtime.noteWalkFinished({ preferred: true, mischief: "reachClose", reachedEdgeDistancePx: 0 });
    assert.equal(env.sends.length, 1);
    assert.equal(env.sends[0].file, "reachClose.svg");
  }
});

test("walking mischief targets the nearest wall, the bottom edge and the cursor", () => {
  const wall = setup();
  wall.theme = themeWith(["wallPushLeft", "wallPushRight"]);
  wall.runtime.configure(MON);
  tickUntilBeat(wall, 200000);
  const nearLeft = { ...ROAM_ARGS, bounds: { x: 300, y: 600, width: 100, height: 100 } };
  assert.deepEqual(wall.runtime.pickRoamTarget(nearLeft), { x: 0, y: 600, preferred: true, mischief: "wall", side: "left" });
  wall.runtime.noteWalkFinished({ preferred: true, mischief: "wall", reachedEdgeDistancePx: 0 });
  assert.equal(wall.sends[0].file, "wallPushLeft.svg");

  const edge = setup();
  edge.theme = themeWith(["sitEdge"]);
  edge.runtime.configure(MON);
  tickUntilBeat(edge, 200000);
  assert.deepEqual(edge.runtime.pickRoamTarget(nearLeft), { x: 300, y: 900, preferred: true, mischief: "sitEdge" });
  edge.runtime.noteWalkFinished({ preferred: true, mischief: "sitEdge", reachedEdgeDistancePx: 40 });
  assert.equal(edge.sends[0].file, "sitEdge.svg");
  runCommitting(edge, 20000);
  assert.ok(edge.sends.length > 1 && edge.sends.every((s) => s.file === "sitEdge.svg"));
  assert.equal(edge.restores, 1, "the sit loop ends at 15 s");

  const poke = setup();
  poke.theme = themeWith(["pokeLeft", "pokeRight"]);
  poke.runtime.configure(MON);
  const parked = { x: 1500, y: 300, petRect: { x: 950, y: 450, width: 100, height: 100 }, overPet: false };
  for (let t = 0; t < 21000; t += 250) {
    poke.clock.advance(250);
    poke.runtime.tick(parked);
  }
  assert.equal(poke.runtime.getRoamDelayMs(false, 8000), 4000);
  // Pet sits left of the cursor: stop half a pet before it, cursor on the right.
  assert.deepEqual(poke.runtime.pickRoamTarget(ROAM_ARGS), { x: 1350, y: 250, preferred: true, mischief: "poke" });
  poke.runtime.noteWalkFinished({ preferred: true, mischief: "poke", reachedEdgeDistancePx: 700 });
  assert.equal(poke.sends.length, 1);
  assert.equal(poke.sends[0].file, "pokeRight.svg");
});

test("corner target clamped by fence skips the scene", () => {
  const env = setup();
  env.theme = themeWith(["reachClose"]);
  env.runtime.configure(MON);
  tickUntilBeat(env, 200000);
  assert.equal(env.runtime.pickRoamTarget(ROAM_ARGS).mischief, "reachClose");
  env.runtime.noteWalkFinished({ preferred: true, mischief: "reachClose", reachedEdgeDistancePx: 500 });
  assert.equal(env.sends.length, 0);
  assert.equal(env.runtime.getRoamDelayMs(false, 8000), 8800, "nothing pending afterwards");
});

// Roam's margin band (15%) as xMin..xMax, plus its edgeBounds (work area,
// whole window, narrowed by an active fence).
const BAND_ARGS = {
  ...ROAM_ARGS,
  xMin: 300, xMax: 1600, yMin: 150, yMax: 750,
  bounds: { x: 300, y: 600, width: 100, height: 100 },
  edgeBounds: { xMin: 0, xMax: 1900, yMin: 0, yMax: 900 },
};

test("edge mischief targets leave the margin band and play at the real edge", () => {
  const cases = [
    [["reachClose"], { x: 1750, y: 40 }, "reachClose.svg"],
    [["wallPushLeft", "wallPushRight"], { x: 0, y: 600 }, "wallPushLeft.svg"],
    [["sitEdge"], { x: 300, y: 900 }, "sitEdge.svg"],
  ];
  for (const [keys, spot, file] of cases) {
    const env = setup();
    env.theme = themeWith(keys);
    env.runtime.configure(MON);
    tickUntilBeat(env, 200000);
    const target = env.runtime.pickRoamTarget(BAND_ARGS);
    assert.deepEqual({ x: target.x, y: target.y }, spot, keys[0]);
    // Roam reports the gap of its final bounds: 0 at the real edge.
    env.runtime.noteWalkFinished({ preferred: true, mischief: target.mischief, reachedEdgeDistancePx: 0 });
    assert.equal(env.sends.length, 1, keys[0]);
    assert.equal(env.sends[0].file, file);
  }

  // Without edgeBounds (older roam) the band still clamps, as before.
  const old = setup();
  old.theme = themeWith(["reachClose"]);
  old.runtime.configure(MON);
  tickUntilBeat(old, 200000);
  const { edgeBounds, ...bandOnly } = BAND_ARGS;
  assert.ok(edgeBounds);
  assert.deepEqual(old.runtime.pickRoamTarget(bandOnly), { x: 1600, y: 150, preferred: true, mischief: "reachClose" });
});

test("edge mischief inside a fence stays in the fence and skips the scene", () => {
  const env = setup();
  env.theme = themeWith(["reachClose"]);
  env.runtime.configure(MON);
  tickUntilBeat(env, 200000);
  const fenced = { ...BAND_ARGS, edgeBounds: { xMin: 500, xMax: 1400, yMin: 250, yMax: 650 } };
  const target = env.runtime.pickRoamTarget(fenced);
  assert.deepEqual(target, { x: 1400, y: 250, preferred: true, mischief: "reachClose" });
  // Final gap: max(top 250, right 2000 - 1500) = 500 > petWidth 100.
  env.runtime.noteWalkFinished({ preferred: true, mischief: "reachClose", reachedEdgeDistancePx: 500 });
  assert.equal(env.sends.length, 0);
});

test("poke and normal targets ignore edgeBounds", () => {
  const poke = setup();
  poke.theme = themeWith(["pokeLeft", "pokeRight"]);
  poke.runtime.configure(MON);
  // Cursor parked at the far top right: the poke goal sits outside the band.
  const parked = { x: 1990, y: 5, petRect: { x: 300, y: 600, width: 100, height: 100 }, overPet: false };
  for (let t = 0; t < 21000; t += 250) {
    poke.clock.advance(250);
    poke.runtime.tick(parked);
  }
  const target = poke.runtime.pickRoamTarget(BAND_ARGS);
  assert.equal(target.mischief, "poke");
  assert.deepEqual({ x: target.x, y: target.y }, { x: 1600, y: 150 });

  const plain = setup();
  plain.runtime.configure(MON);
  plain.randomValue = 0.1; // explore: a normal (non-preferred) target
  let checked = 0;
  for (let i = 0; i < 20; i++) {
    const t = plain.runtime.pickRoamTarget(BAND_ARGS);
    if (!t) continue;
    checked += 1;
    assert.ok(t.x >= 300 && t.x <= 1600 && t.y >= 150 && t.y <= 750, JSON.stringify(t));
  }
  assert.ok(checked > 0, "at least one normal target was checked");
});

test("welcome needs a long sleep", () => {
  for (const [awayMs, queued] of [[599999, false], [600000, true], [undefined, false]]) {
    const env = setup();
    env.theme = themeWith(["welcome"]);
    env.runtime.configure(MON);
    env.runtime.noteIdleEntered({ from: "sleep", awayMs });
    for (let t = 0; t < 2000; t += 250) {
      env.clock.advance(250);
      env.runtime.tick(null);
    }
    const welcomed = env.sends.some((s) => s.file === "welcome.svg");
    assert.equal(welcomed, queued, String(awayMs));
  }
});

test("a fenced wall walk is judged on the side it proposed", () => {
  const env = setup();
  env.theme = themeWith(["wallPushLeft", "wallPushRight"]);
  env.runtime.configure(MON);
  tickUntilBeat(env, 200000);
  // Pet near the left wall, fence on the right half of the work area.
  const fenced = { ...BAND_ARGS, edgeBounds: { xMin: 1200, xMax: 1800, yMin: 0, yMax: 900 } };
  const target = env.runtime.pickRoamTarget(fenced);
  assert.deepEqual(target, { x: 1200, y: 600, preferred: true, mischief: "wall", side: "left" });
  // Roam measures the left gap (1200), not the nearer right one: no push.
  env.runtime.noteWalkFinished({ preferred: true, mischief: "wall", reachedEdgeDistancePx: 1200 });
  assert.equal(env.sends.length, 0);
});

test("discarded preferred target clears the pending walk", () => {
  const env = setup();
  env.theme = themeWith(["reachClose"]);
  env.runtime.configure(MON);
  tickUntilBeat(env, 200000);
  assert.equal(env.runtime.getRoamDelayMs(false, 8000), 4000);
  env.runtime.onPreferredTargetDiscarded();
  assert.equal(env.runtime.getRoamDelayMs(false, 8000), 8800);

  const walked = setup();
  walked.theme = themeWith(["reachClose"]);
  walked.runtime.configure(MON);
  tickUntilBeat(walked, 200000);
  assert.equal(walked.runtime.pickRoamTarget(ROAM_ARGS).mischief, "reachClose");
  walked.runtime.onPreferredTargetDiscarded();
  walked.runtime.noteWalkFinished({ preferred: true, mischief: "reachClose", reachedEdgeDistancePx: 0 });
  assert.equal(walked.sends.length, 0);
});

test("stay-put mode only allows reactive mischief", () => {
  const env = setup();
  env.mode = "none";
  env.theme = themeWith(MISCHIEF_KEYS);
  env.runtime.configure({ ...MON, personality: "playful" });
  env.runtime.noteIdleEntered({ from: "sleep", awayMs: 9e6 });
  for (let i = 0; i < 3600; i += 1) {
    env.clock.advance(1000);
    env.runtime.tick();
  }
  // Parked far cursor: no poke walk in stay-put.
  tickWithCursor(env, sample(1500, 1200), 30000);
  assert.equal(env.sends.length, 0);
  assert.equal(env.runtime.chooseIdleActivity({ theme: env.theme }), null);
  // Reactive: lurking cursor pounces.
  tickWithCursor(env, sample(700, 550), 3000);
  assert.equal(env.sends.length, 1);
  assert.equal(env.sends[0].file, "pounceRight.svg");
  env.mode = "roam";
  assert.equal(env.runtime.getRoamDelayMs(false, 8000), 6400, "no poke walk was queued");
});

test("activities mode only picks single-part mischief", () => {
  const env = setup({ options: { getHour: () => 7 } });
  env.mode = "activities";
  env.theme = themeWith(["fakeNap", "boo", "sitEdge", "reachClose", "wallPushLeft", "coffee"]);
  env.runtime.configure({ ...MON, personality: "playful" });
  assert.deepEqual(env.runtime.chooseIdleActivity({ theme: env.theme }), { file: "coffee.svg", durationMs: 3500 });
  for (let i = 0; i < 50; i += 1) {
    env.clock.advance(60000);
    const choice = env.runtime.chooseIdleActivity({ theme: env.theme });
    assert.ok(!choice || !choice.file || choice.file === "coffee.svg", JSON.stringify(choice));
  }
  assert.equal(env.sends.length, 0, "the chooser never plays by itself");

  const toy = setup();
  toy.mode = "activities";
  toy.theme = themeWith(["fakeNap", "toyYoyo"]);
  toy.runtime.configure({ ...MON, personality: "playful" });
  assert.deepEqual(toy.runtime.chooseIdleActivity({ theme: toy.theme }), { file: "toyYoyo.svg", durationMs: 3500 });
});

test("dispose mid-scene clears all timers", () => {
  const env = setup();
  env.mode = "none";
  env.theme = themeWith(MISCHIEF_KEYS);
  env.runtime.configure(MON);
  env.runtime.handleGesture("hover-dwell");
  env.commitLast();
  assert.equal(env.clock.pendingTimers, 1);
  env.runtime.dispose();
  assert.equal(env.clock.pendingTimers, 0);
  env.clock.advance(20000);
  env.runtime.tick(sample(700, 550));
  env.runtime.handleGesture("hover-move");
  assert.equal(env.sends.length, 1);
  assert.equal(env.restores, 0);
  assert.equal(env.runtime.isAnimating(), false);
});

test("turning mischief off mid-scene restores idle and drops pending work", () => {
  const env = setup();
  env.theme = themeWith(["sitEdge", "welcome"]);
  env.runtime.configure(MON);
  tickUntilBeat(env, 200000);
  env.runtime.pickRoamTarget(ROAM_ARGS);
  env.runtime.noteWalkFinished({ preferred: true, mischief: "sitEdge", reachedEdgeDistancePx: 0 });
  env.commitLast();
  env.runtime.noteIdleEntered({ from: "sleep", awayMs: 9e6 });
  env.runtime.configure({ ...MON, mischief: false });
  assert.equal(env.restores, 1);
  assert.equal(env.clock.pendingTimers, 0);
  env.clock.advance(1000);
  env.runtime.tick();
  assert.equal(env.sends.length, 1, "queued welcome was dropped");
});

test("a pet already at the bottom edge sits in place once and is not re-picked", () => {
  const env = setup();
  env.theme = themeWith(["sitEdge"]);
  env.runtime.configure(MON);
  tickUntilBeat(env, 200000);
  const atBottom = { ...ROAM_ARGS, bounds: { x: 950, y: 900, width: 100, height: 100 } };
  assert.equal(env.runtime.pickRoamTarget(atBottom).mischief, "sitEdge");
  env.runtime.onPreferredTargetDiscarded(); // roam: already there (< minDist)
  assert.equal(env.sends.length, 1);
  assert.equal(env.sends[0].file, "sitEdge.svg");
  runCommitting(env, 20000);
  const sends = env.sends.length;
  // One return walk back into the band, then nothing more.
  assert.equal(env.runtime.getRoamDelayMs(false, 8000), 4000);
  assert.equal(env.runtime.pickRoamTarget(atBottom), null);
  for (let i = 0; i < 900; i += 1) {
    env.clock.advance(1000);
    env.runtime.tick();
    assert.equal(env.runtime.getRoamDelayMs(false, 8000), 8800, "sitEdge is not picked again");
  }
  assert.equal(env.sends.length, sends);
});

test("a discarded walking mischief far from its edge spends its cooldown", () => {
  const env = setup();
  env.theme = themeWith(["reachClose"]);
  env.runtime.configure(MON);
  tickUntilBeat(env, 200000);
  assert.equal(env.runtime.pickRoamTarget(ROAM_ARGS).mischief, "reachClose");
  env.runtime.onPreferredTargetDiscarded();
  assert.equal(env.sends.length, 0);
  for (let i = 0; i < 900; i += 1) {
    env.clock.advance(1000);
    env.runtime.tick();
    assert.equal(env.runtime.getRoamDelayMs(false, 8000), 8800, "no repeat while on cooldown");
  }
  assert.equal(env.sends.length, 0);
});

test("an expired pending walk spends its cooldown", () => {
  const env = setup();
  env.theme = themeWith(["reachClose"]);
  env.runtime.configure(MON);
  tickUntilBeat(env, 200000);
  assert.equal(env.runtime.getRoamDelayMs(false, 8000), 4000);
  // The roam never asks for a target: dropped after 120 s.
  for (let i = 0; i < 121; i += 1) {
    env.clock.advance(1000);
    env.runtime.tick();
  }
  for (let i = 0; i < 900; i += 1) {
    env.clock.advance(1000);
    env.runtime.tick();
    assert.equal(env.runtime.getRoamDelayMs(false, 8000), 8800, "not re-picked after expiry");
  }
});

test("reachClose stops inset from the corner, never over the window controls", () => {
  const { walkEdgeDistance } = require("../src/companion-scenes");
  for (const platform of ["linux", "win32", "darwin"]) {
    const env = setup({ options: { getPlatform: () => platform } });
    env.theme = themeWith(["reachClose"]);
    env.runtime.configure(MON);
    tickUntilBeat(env, 200000);
    const target = env.runtime.pickRoamTarget(BAND_ARGS);
    const area = BAND_ARGS.workArea;
    const sideGap = platform === "darwin" ? target.x - area.x : area.x + area.width - (target.x + 100);
    assert.ok(sideGap >= 150, `${platform}: ${sideGap} px from the corner side`);
    assert.ok(target.y - area.y >= 40, `${platform}: ${target.y - area.y} px below the top`);
    // Arrival is measured against the inset spot: there it plays, in the corner it does not.
    const walk = { id: "reachClose" };
    const at = (x, y) => walkEdgeDistance(walk, { area, bounds: { x, y, width: 100, height: 100 }, platform });
    assert.equal(at(target.x, target.y), 0, platform);
    const cornerX = platform === "darwin" ? 0 : 1900;
    assert.ok(at(cornerX, 0) > 100, `${platform}: the bare corner is not an arrival`);
  }
});

// Plays one edge scene to its end through a walk (or kills it), then returns the env.
function playEdgeScene(keys, kill = false) {
  const env = setup();
  env.theme = themeWith(keys);
  env.runtime.configure(MON);
  tickUntilBeat(env, 200000);
  const target = env.runtime.pickRoamTarget(BAND_ARGS);
  assert.ok(target && target.mischief, keys[0]);
  env.runtime.noteWalkFinished({ preferred: true, mischief: target.mischief, reachedEdgeDistancePx: 0 });
  assert.equal(env.sends.length, 1, keys[0]);
  env.commitLast();
  if (kill) {
    env.state = "working";
    env.runtime.tick();
    env.state = "idle";
  } else {
    runCommitting(env, 20000);
  }
  assert.equal(env.runtime.isAnimating(), false, keys[0]);
  return env;
}

test("after an edge scene the pet walks back into the band once", () => {
  for (const kill of [false, true]) {
    for (const keys of [["reachClose"], ["wallPushLeft", "wallPushRight"], ["sitEdge"]]) {
      const label = `${keys[0]}${kill ? " (killed)" : ""}`;
      const env = playEdgeScene(keys, kill);
      env.randomValue = 0.1; // would explore a grid cell without the return walk
      assert.equal(env.runtime.getRoamDelayMs(false, 8000), 4000, label);
      assert.equal(env.runtime.getRoamDelayMs(false, 8000), 4000, `${label}: until the walk is asked`);
      assert.equal(env.runtime.pickRoamTarget(BAND_ARGS), null, `${label}: roam picks a band target`);
      // Cleared after one walk.
      assert.ok(env.runtime.getRoamDelayMs(false, 8000) > 4000, label);
      const next = env.runtime.pickRoamTarget(BAND_ARGS);
      assert.ok(next && next.preferred === false, `${label}: normal explore again`);
    }
  }
});

test("the return walk is dropped on disable, reset, mischief off and mode change", () => {
  const changes = [
    (env) => env.runtime.configure({ ...MON, enabled: false }),
    (env) => env.runtime.reset(),
    (env) => env.runtime.configure({ ...MON, mischief: false }),
    (env) => env.runtime.configure({ ...MON, autonomy: false }),
    (env) => { env.mode = "activities"; env.runtime.tick(); },
  ];
  changes.forEach((change, i) => {
    const env = playEdgeScene(["sitEdge"]);
    change(env);
    env.runtime.configure(MON);
    env.mode = "roam";
    assert.notEqual(env.runtime.getRoamDelayMs(false, 8000), 4000, `change ${i}`);
  });
});

test("mischief off reproduces the 40b54948 golden runs exactly", () => {
  // Golden produced by test/fixtures/companion-alive-script.js against the
  // pre-mischief runtime (40b54948); every new input is fed, mischief is off.
  const { runScript } = require("./fixtures/companion-alive-script");
  const golden = require("./fixtures/companion-alive-golden.json");
  assert.equal(golden.length, 9);
  for (const { script, result } of golden) {
    assert.deepEqual(runScript(createCompanionRuntime, script), result, JSON.stringify(script));
  }
});
