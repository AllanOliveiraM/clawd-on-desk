"use strict";

// Gap-hunting tests for the companion runtime: clock jumps, test-mode walk
// leftovers, work-pick memo identity, dispose, equivalence and boundaries.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createCompanionRuntime } = require("../src/companion-runtime");
const themeLoader = require("../src/theme-loader");

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
    load() { env.storeCalls.push(["load"]); return extra.loaded || { state: null, restSpot: null }; },
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

// ---- 10: dispose ----

test("after dispose every entry point is inert and nothing reaches the store", () => {
  const env = harness(["greet", "walkBouncy"]);
  env.runtime.configure({ ...ON, memory: true, mischief: true });
  env.runtime.handleGesture("hover-dwell");
  assert.equal(env.sends.length, 1);
  env.runtime.dispose();
  const callsAfter = env.storeCalls.length;
  assert.deepEqual(env.runtime.debugPlay("walk", { variant: "walkBouncy" }), { ok: false, reason: "disabled" });
  assert.deepEqual(env.runtime.debugCatalog(), []);
  assert.equal(env.runtime.holdsRoam(), false);
  assert.equal(env.runtime.isAnimating(), false);
  assert.equal(env.runtime.pickWalkVisual(), null);
  assert.equal(env.runtime.pickSleepVisual("sleeping"), null);
  assert.equal(env.runtime.pickWorkVisual("working", { sessions: 1, episode: 0 }), null);
  assert.equal(env.runtime.pickRoamTarget({ xMin: 0, xMax: 10, yMin: 0, yMax: 10 }), null);
  assert.equal(env.runtime.chooseIdleActivity({}), null);
  assert.equal(env.runtime.getRoamDelayMs(false, 4000), 4000);
  env.runtime.noteEvent("pet");
  env.runtime.noteDragEnd({ x: 0.5, y: 0.5 });
  env.runtime.noteWalkFinished({ preferred: true });
  env.runtime.noteIdleEntered({ from: "sleep", awayMs: 9e9 });
  env.runtime.onPreferredTargetDiscarded();
  env.runtime.handleGesture("pet-start");
  env.runtime.tick({ x: 1, y: 1 });
  env.runtime.configure({ enabled: false });
  env.runtime.configure({ enabled: true, memory: true });
  env.runtime.reset();
  env.runtime.cancel();
  assert.equal(env.storeCalls.length, callsAfter, "no store traffic after dispose");
  assert.equal(env.sends.length, 1);
});

test("a settlement that arrives after dispose starts no timer", () => {
  const env = harness(["greet"]);
  env.runtime.configure({ ...ON, memory: false });
  env.runtime.handleGesture("hover-dwell");
  assert.equal(env.pendingTimers(), 0);
  env.runtime.dispose();
  env.commitLast();
  assert.equal(env.pendingTimers(), 0);
  assert.equal(env.runtime.isAnimating(), false);
});

// ---- 11: rest spot on another monitor ----

const REST_LOADED = (displayId) => ({
  state: { mood: { energy: 20, contentment: 55, familiarity: 0 }, label: "tired", streak: null, lastAdvanceAt: null, lastInteractionAt: null },
  restSpot: { displayId, x: 0.5, y: 0.5 },
});
const REST_ARGS = {
  xMin: 0, xMax: 1900, yMin: 0, yMax: 700,
  bounds: { x: 0, y: 0, width: 100, height: 100 }, size: { width: 100, height: 100 },
  displayId: 1, workArea: { x: 0, y: 0, width: 2000, height: 800 },
};

test("a rest spot on a monitor the pet cannot reach gives no preferred target", () => {
  const farArea = { x: 2000, y: 0, width: 1000, height: 800 };
  const env = harness([], { loaded: REST_LOADED(2), options: { getDisplayWorkArea: (id) => (id === 2 ? farArea : null) } });
  env.runtime.configure({ ...ON, memory: true });
  assert.equal(env.runtime.pickRoamTarget(REST_ARGS), null);
  assert.equal(env.runtime.pickRoamTarget(REST_ARGS), null, "never clamped to this display's edge");
  const gone = harness([], { loaded: REST_LOADED(2) });
  gone.runtime.configure({ ...ON, memory: true });
  assert.equal(gone.runtime.pickRoamTarget(REST_ARGS), null, "unknown display geometry");
  const same = harness([], { loaded: REST_LOADED(1) });
  same.runtime.configure({ ...ON, memory: true });
  assert.deepEqual(same.runtime.pickRoamTarget(REST_ARGS), { x: 950, y: 350, preferred: true });
  const unknown = harness([], { loaded: REST_LOADED(null) });
  unknown.runtime.configure({ ...ON, memory: true });
  assert.deepEqual(unknown.runtime.pickRoamTarget(REST_ARGS), { x: 950, y: 350, preferred: true });
});

// ---- 12: sleep roll bookkeeping ----

test("a collapse without twitch art leaves the sleep a fresh roll", () => {
  const env = harness(["sleepTwitch"]);
  env.runtime.configure(ON);
  env.randomValue = 0.99;
  assert.equal(env.runtime.pickSleepVisual("collapsing"), null);
  env.randomValue = 0.1;
  assert.equal(env.runtime.pickSleepVisual("sleeping", { fromCollapse: true }), "sleepTwitch.svg");
});

test("a collapse miss is kept for the sleep, a hit too", () => {
  const env = harness(["sleepTwitch", "collapseSleepTwitch"]);
  env.runtime.configure(ON);
  env.randomValue = 0.99;
  assert.equal(env.runtime.pickSleepVisual("collapsing"), null);
  env.randomValue = 0.1;
  assert.equal(env.runtime.pickSleepVisual("sleeping", { fromCollapse: true }), null, "the miss sticks");
  assert.equal(env.runtime.pickSleepVisual("collapsing"), "collapseSleepTwitch.svg");
  env.randomValue = 0.99;
  assert.equal(env.runtime.pickSleepVisual("sleeping", { fromCollapse: true }), "sleepTwitch.svg", "the hit sticks");
  assert.equal(env.runtime.pickSleepVisual("sleeping", { fromCollapse: true }), null, "one decision, used once");
});

test("disabling between collapse and sleep drops the pending decision", () => {
  const env = harness(["sleepTwitch", "collapseSleepTwitch"]);
  env.runtime.configure(ON);
  env.randomValue = 0.1;
  assert.equal(env.runtime.pickSleepVisual("collapsing"), "collapseSleepTwitch.svg");
  env.runtime.configure({ enabled: false });
  assert.equal(env.runtime.pickSleepVisual("sleeping", { fromCollapse: true }), null);
  env.runtime.configure({ enabled: true });
  env.randomValue = 0.99;
  assert.equal(env.runtime.pickSleepVisual("sleeping", { fromCollapse: true }), null, "fresh roll, not the stale hit");
  env.randomValue = 0.1;
  env.runtime.pickSleepVisual("collapsing");
  env.runtime.configure({ enabled: false });
  env.runtime.configure({ enabled: true });
  env.randomValue = 0.99;
  assert.equal(env.runtime.pickSleepVisual("sleeping", { fromCollapse: true }), null, "no call while disabled still drops it");
});

test("pickSleepVisual tolerates missing or odd options", () => {
  const env = harness(["sleepTwitch"]);
  env.runtime.configure(ON);
  env.randomValue = 0.1;
  for (const options of [null, undefined, 5, "x", {}]) {
    assert.doesNotThrow(() => env.runtime.pickSleepVisual("sleeping", options));
  }
  assert.equal(env.runtime.pickSleepVisual("sleeping", null), "sleepTwitch.svg");
  assert.equal(env.runtime.pickSleepVisual("waking", null), null);
  assert.equal(env.runtime.pickSleepVisual(undefined), "sleepTwitch.svg");
});

// ---- 13: walk variant boundaries ----

function walkEnv(personality, mood, keys = ["walkTired", "walkBouncy", "walkCurious"]) {
  const env = harness(keys, { loaded: { state: { mood, label: "neutral", streak: null, lastAdvanceAt: null, lastInteractionAt: null }, restSpot: null } });
  env.runtime.configure({ ...ON, personality, memory: true });
  env.randomValue = 0;
  return env;
}

test("walk variants: energy 35 is not tired, 34 is", () => {
  const rested = walkEnv("balanced", { energy: 35, contentment: 50, familiarity: 0 });
  assert.equal(rested.runtime.pickWalkVisual(), null, "balanced, content 50: no bouncy, not tired");
  const tired = walkEnv("balanced", { energy: 34, contentment: 50, familiarity: 0 });
  assert.equal(tired.runtime.pickWalkVisual(), "walkTired.svg");
});

test("walk variants: bouncy needs contentment above 75 for non-playful pets", () => {
  assert.equal(walkEnv("balanced", { energy: 80, contentment: 75, familiarity: 0 }).runtime.pickWalkVisual(), null);
  assert.equal(walkEnv("balanced", { energy: 80, contentment: 76, familiarity: 0 }).runtime.pickWalkVisual(), "walkBouncy.svg");
  assert.equal(walkEnv("playful", { energy: 80, contentment: 10, familiarity: 0 }).runtime.pickWalkVisual(), "walkBouncy.svg", "playful ignores contentment");
});

test("walk variants: a tired pet only ever rolls walkTired", () => {
  const env = walkEnv("playful", { energy: 34, contentment: 90, familiarity: 0 });
  assert.equal(env.runtime.pickWalkVisual(), "walkTired.svg");
  const noArt = walkEnv("playful", { energy: 34, contentment: 90, familiarity: 0 }, ["walkBouncy"]);
  const before = noArt.randomCalls;
  assert.equal(noArt.runtime.pickWalkVisual(), null, "no tired art, no bouncy fallback");
  assert.equal(noArt.randomCalls, before, "no art, no roll");
  const miss = walkEnv("playful", { energy: 34, contentment: 90, familiarity: 0 });
  miss.randomValue = 0.6; // not < 0.6
  assert.equal(miss.runtime.pickWalkVisual(), null);
});

test("walk variants: curious pets fall through to walkCurious", () => {
  const env = walkEnv("curious", { energy: 80, contentment: 50, familiarity: 0 });
  assert.equal(env.runtime.pickWalkVisual(), "walkCurious.svg");
  env.randomValue = 0.35;
  assert.equal(env.runtime.pickWalkVisual(), null);
});

// ---- 6: equivalence with themes that have no companion art ----

for (const name of ["calico", "cloudling"]) {
  test(`${name}: everything on over a simulated hour changes nothing visible`, () => {
    themeLoader.init(path.join(__dirname, "..", "src"));
    const theme = themeLoader.loadTheme(name);
    const run = (cfg) => {
      const env = harness([], { options: { xwayland: true } });
      env.theme = theme;
      env.runtime.configure(cfg);
      const before = env.randomCalls;
      let hookCalls = 0;
      let hookRandom = 0;
      for (let i = 0; i < 3600; i += 1) {
        env.advance(1000);
        env.runtime.tick({ x: i % 50, y: 5, petBounds: { x: 100, y: 100, width: 200, height: 200 } }, i % 7 === 0 ? { cursorTrusted: false } : undefined);
        if (i % 60 === 0) {
          const r0 = env.randomCalls;
          const hooks = [env.runtime.pickWalkVisual(), env.runtime.pickSleepVisual("sleeping"), env.runtime.pickSleepVisual("collapsing"),
            env.runtime.pickWorkVisual("working", { sessions: 9, episode: 0 }), env.runtime.pickWorkVisual("juggling", { subagents: 9, episode: 0 })];
          assert.deepEqual(hooks, [null, null, null, null, null]);
          hookCalls += 1;
          hookRandom += env.randomCalls - r0;
          env.runtime.handleGesture("hover-dwell", { bucket: "body", side: "left" });
          env.runtime.handleGesture("pet-start");
          env.runtime.handleGesture("pet-end");
          env.runtime.noteIdleEntered({ from: "sleep", awayMs: 9e9 });
        }
      }
      assert.ok(hookCalls > 0);
      assert.equal(hookRandom, 0, "the hooks draw no randomness without art");
      assert.deepEqual(env.runtime.debugCatalog(), []);
      return { sends: env.sends.length, random: env.randomCalls - before };
    };
    const on = run({ enabled: true, personality: "playful", autonomy: true, interactions: true, memory: false, mischief: true });
    assert.equal(on.sends, 0);
    const plain = run({ enabled: true, personality: "playful", autonomy: true, interactions: true, memory: false, mischief: false });
    assert.equal(plain.sends, 0);
    assert.equal(on.random, plain.random, "mischief adds no randomness without art");
  });
}
