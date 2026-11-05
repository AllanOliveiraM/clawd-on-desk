"use strict";

// Clawd Alive sleep clock: real user activity keeps Clawd awake, daytime sleep
// waits longer, and everything answers the original values with the feature off.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createCompanionRuntime } = require("../src/companion-runtime");

const BASE = 60000;
const DAY = 5 * 60 * 1000;

function make({ enabled = true, hour = 14, idle = null, energy = 80 } = {}) {
  const env = { hour, idle, reads: 0 };
  const rt = createCompanionRuntime({
    getTheme: () => ({ states: { idle: ["idle.svg"] }, companionAnimations: {} }),
    getHour: () => env.hour,
    getSystemIdleMs: () => { env.reads += 1; return env.idle; },
    store: {
      load: () => ({
        state: { mood: { energy, contentment: 60, familiarity: 10 }, label: "neutral", streak: null, lastAdvanceAt: null, lastInteractionAt: null },
        restSpot: null,
      }),
      schedule() {}, flush() {}, remove() {},
    },
    setTimeout: () => 1,
    clearTimeout: () => {},
    now: () => 1000,
  });
  rt.configure({ enabled, personality: "balanced", memory: true });
  return { rt, env };
}

test("feature off answers the original clock and never asks the system", () => {
  const { rt, env } = make({ enabled: false, idle: 10 });
  assert.equal(rt.sleepClockMs(90000, BASE), 90000);
  assert.equal(rt.sleepTimeoutMs(BASE), BASE);
  assert.equal(rt.isUserBack(), false);
  assert.equal(env.reads, 0);
});

test("real activity holds the sleep clock back", () => {
  const { rt } = make({ idle: 4000 });
  assert.equal(rt.sleepClockMs(400000, BASE), 4000);
});

test("the mouse wins when it moved more recently than the system saw", () => {
  const { rt } = make({ idle: 90000 });
  assert.equal(rt.sleepClockMs(70000, BASE), 70000);
});

test("no system answer falls back to the mouse clock", () => {
  const { rt } = make({ idle: null });
  assert.equal(rt.sleepClockMs(400000, BASE), 400000);
});

test("the system is only asked close to sleep time", () => {
  const { rt, env } = make({ idle: 1000 });
  assert.equal(rt.sleepClockMs(44999, BASE), 44999);
  assert.equal(env.reads, 0);
  assert.equal(rt.sleepClockMs(45000, BASE), 1000);
  assert.equal(env.reads, 1);
});

test("daytime sleep waits five minutes", () => {
  for (const hour of [6, 12, 22]) assert.equal(make({ hour }).rt.sleepTimeoutMs(BASE), DAY, `hour ${hour}`);
});

test("at night he keeps the theme's timeout", () => {
  for (const hour of [23, 0, 5]) assert.equal(make({ hour }).rt.sleepTimeoutMs(BASE), BASE, `hour ${hour}`);
});

test("low energy keeps the theme's timeout by day", () => {
  assert.equal(make({ energy: 24 }).rt.sleepTimeoutMs(BASE), BASE);
  assert.equal(make({ energy: 25 }).rt.sleepTimeoutMs(BASE), DAY);
});

test("a theme slower than the daytime delay is never shortened", () => {
  assert.equal(make().rt.sleepTimeoutMs(DAY + 1), DAY + 1);
});

test("the user is back only on a recent answer", () => {
  assert.equal(make({ idle: 4999 }).rt.isUserBack(), true);
  assert.equal(make({ idle: 5000 }).rt.isUserBack(), false);
  assert.equal(make({ idle: null }).rt.isUserBack(), false);
});

test("a disposed runtime stops asking", () => {
  const { rt, env } = make({ idle: 1 });
  rt.dispose();
  assert.equal(rt.isUserBack(), false);
  assert.equal(rt.sleepClockMs(90000, BASE), 90000);
  assert.equal(rt.sleepTimeoutMs(BASE), BASE);
  assert.equal(env.reads, 0);
});
