"use strict";
// Deterministic Clawd Alive driver for the mischief-off equivalence golden.
// test/fixtures/companion-alive-golden.json was produced by running this
// driver against the runtime at 40b54948 (before mischief); the runtime test
// asserts the current runtime, with mischief:false and every new input fed,
// reproduces it exactly.

const KEYS = [
  "petting", "content", "tired", "shy", "grumpy", "curious", "greet",
  "catch", "catchMiss", "pounceLeft", "pounceRight", "fakeNap", "boo",
  "pokeLeft", "pokeRight", "reachClose", "wallPushLeft", "wallPushRight",
  "wallPeekLeft", "wallPeekRight", "sitEdge", "morningStretch", "coffee",
  "nightSleepy", "welcome", "stretchBack", "toyBall", "toyYoyo", "toyPlane",
];

const SCRIPTS = [];
for (const personality of ["balanced", "playful", "shy"]) {
  for (const mode of ["roam", "activities", "none"]) SCRIPTS.push({ personality, mode, seed: SCRIPTS.length + 1 });
}

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function runScript(createCompanionRuntime, { personality, mode, seed }, steps = 2400) {
  let nowMs = 0;
  let nextId = 0;
  const timers = [];
  const clock = {
    now: () => nowMs,
    setTimeout(fn, ms) { const t = { id: ++nextId, at: nowMs + ms, fn }; timers.push(t); return t.id; },
    clearTimeout(id) { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    advance(ms) {
      const target = nowMs + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        nowMs = due.at;
        due.fn();
      }
      nowMs = target;
    },
  };
  const companionAnimations = {};
  for (const key of KEYS) companionAnimations[key] = { files: [`${key}.svg`], duration: null };
  const env = { state: "idle", gate: true, generation: 0, sends: [], restores: 0, answers: [], storeCalls: 0, animating: "" };
  const store = {
    load() { env.storeCalls += 1; return { state: null, restSpot: null }; },
    schedule() { env.storeCalls += 1; },
    flush() { env.storeCalls += 1; },
    remove() { env.storeCalls += 1; },
  };
  const rt = createCompanionRuntime({
    getTheme: () => ({ states: { idle: ["idle.svg"] }, companionAnimations }),
    getCurrentState: () => env.state,
    canPlay: () => env.gate,
    restoreIdleVisual: () => { env.restores += 1; },
    isVisualGenerationCurrent: (g) => g === env.generation,
    sendToRenderer: (channel, state, file, opts) => {
      env.generation += 1;
      env.sends.push({ file, opts, g: env.generation, t: nowMs });
      return { visualGeneration: env.generation };
    },
    getIdleMode: () => mode,
    isRoamAnimating: () => false,
    store,
    random: lcg(seed),
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    getPlatform: () => "linux",
  });
  rt.configure({ enabled: true, personality, autonomy: true, interactions: true, memory: true, mischief: false });
  const r = lcg(seed + 1000);
  const args = {
    xMin: 0, xMax: 1900, yMin: 0, yMax: 900,
    bounds: { x: 950, y: 450, width: 100, height: 100 },
    size: { width: 100, height: 100 },
    displayId: null,
    workArea: { x: 0, y: 0, width: 2000, height: 1000 },
  };
  let committed = 0;
  for (let i = 0; i < steps; i += 1) {
    clock.advance(500);
    if (env.sends.length > committed) {
      committed = env.sends.length;
      const last = env.sends[env.sends.length - 1];
      last.opts.onLogicalSettlement({ status: "committed", visualGeneration: last.g });
    }
    const x = r();
    const cursor = { x: 400 + r() * 800, y: 400 + r() * 300, petRect: { x: 500, y: 500, width: 100, height: 100 }, overPet: r() < 0.2 };
    rt.tick(cursor);
    if (x < 0.02) rt.handleGesture("hover-dwell");
    else if (x < 0.04) rt.handleGesture("hover-move");
    else if (x < 0.05) rt.handleGesture("pet-start");
    else if (x < 0.06) rt.handleGesture("pet-end");
    else if (x < 0.07) env.answers.push(rt.getRoamDelayMs(r() < 0.5, 8000));
    else if (x < 0.08) env.answers.push(rt.pickRoamTarget(args));
    else if (x < 0.09) rt.noteWalkFinished({ preferred: r() < 0.5, mischief: "reachClose", reachedEdgeDistancePx: 0 });
    else if (x < 0.095) rt.onPreferredTargetDiscarded();
    else if (x < 0.10) rt.noteIdleEntered({ from: r() < 0.5 ? "sleep" : "work", awayMs: 9e6 });
    else if (x < 0.11) env.answers.push(rt.chooseIdleActivity({}));
    else if (x < 0.115) env.gate = !env.gate;
    else if (x < 0.118) env.generation += 1;
    else if (x < 0.12) rt.noteEvent("click");
    env.animating += rt.isAnimating() ? "1" : "0";
  }
  return {
    sends: env.sends.map((s) => [s.file, s.t]),
    restores: env.restores,
    answers: env.answers,
    storeCalls: env.storeCalls,
    animating: env.animating,
    mood: rt.getMood(),
    timers: timers.length,
  };
}

module.exports = { SCRIPTS, runScript };
