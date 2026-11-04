"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  MOOD_FEED_MIN_INTERVAL_MS,
  normalizeMoodSnapshot,
  readMoodSnapshot,
  createCompanionMoodFeed,
} = require("../src/companion-mood-feed");

describe("normalizeMoodSnapshot", () => {
  it("keeps a valid snapshot, rounding and clamping the bars to 0-100", () => {
    assert.deepEqual(normalizeMoodSnapshot({
      mood: { energy: 70.4, contentment: 120, familiarity: -3 },
      label: "content",
      personality: "playful",
      lastInteractionAt: 1234,
    }), {
      mood: { energy: 70, contentment: 100, familiarity: 0 },
      label: "content",
      personality: "playful",
      lastInteractionAt: 1234,
    });
  });

  it("falls back on unknown labels, personalities and timestamps", () => {
    assert.deepEqual(normalizeMoodSnapshot({
      mood: { energy: "x", contentment: NaN },
      label: "<b>",
      personality: "evil",
      lastInteractionAt: "yesterday",
    }), {
      mood: { energy: 0, contentment: 0, familiarity: 0 },
      label: "neutral",
      personality: null,
      lastInteractionAt: null,
    });
    assert.equal(normalizeMoodSnapshot(null), null);
    assert.equal(normalizeMoodSnapshot({ label: "content" }), null);
  });
});

describe("readMoodSnapshot", () => {
  it("prefers runtime.getMoodSnapshot()", () => {
    const snapshot = readMoodSnapshot({
      getMoodSnapshot: () => ({ mood: { energy: 10, contentment: 20, familiarity: 30 }, label: "tired", personality: "calm", lastInteractionAt: 5 }),
      getMood: () => { throw new Error("must not be used"); },
    });
    assert.deepEqual(snapshot, { mood: { energy: 10, contentment: 20, familiarity: 30 }, label: "tired", personality: "calm", lastInteractionAt: 5 });
  });

  it("derives a snapshot from getMood() on an older runtime", () => {
    const snapshot = readMoodSnapshot({ getMood: () => ({ energy: 80, contentment: 90, familiarity: 4 }) });
    assert.deepEqual(snapshot, { mood: { energy: 80, contentment: 90, familiarity: 4 }, label: "content", personality: null, lastInteractionAt: null });
  });

  it("returns null without a usable runtime", () => {
    assert.equal(readMoodSnapshot(null), null);
    assert.equal(readMoodSnapshot({}), null);
    assert.equal(readMoodSnapshot({ getMoodSnapshot: () => { throw new Error("boom"); } }), null);
  });
});

describe("createCompanionMoodFeed (spec §3: only while Settings is open, <= 1 per 2 s)", () => {
  function harness({ open = true } = {}) {
    const clock = { now: 10_000 };
    const timers = [];
    const sent = [];
    const sentAt = [];
    let energy = 50;
    const state = { open };
    const feed = createCompanionMoodFeed({
      getSnapshot: () => ({ mood: { energy, contentment: 50, familiarity: 0 }, label: "neutral", personality: null, lastInteractionAt: null }),
      send: (snapshot) => { sent.push(snapshot.mood.energy); sentAt.push(clock.now); },
      isOpen: () => state.open,
      now: () => clock.now,
      setTimeout: (fn, ms) => {
        const timer = { fn, at: clock.now + ms, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer) => { if (timer) timer.cleared = true; },
    });
    function advance(ms) {
      clock.now += ms;
      for (const timer of timers.slice()) {
        if (!timer.cleared && !timer.fired && timer.at <= clock.now) {
          timer.fired = true;
          timer.fn();
        }
      }
    }
    return {
      feed, sent, sentAt, timers, state, advance,
      setEnergy: (v) => { energy = v; },
      pending: () => timers.filter((t) => !t.cleared && !t.fired).length,
    };
  }

  it("uses a 2 s minimum interval", () => {
    assert.equal(MOOD_FEED_MIN_INTERVAL_MS, 2000);
  });

  it("does nothing while Settings is closed: no send, no timer", () => {
    const h = harness({ open: false });
    for (let i = 0; i < 5; i++) h.feed.notify();
    assert.deepEqual(h.sent, []);
    assert.equal(h.timers.length, 0);
  });

  it("sends the first change at once and coalesces a burst into one trailing send", () => {
    const h = harness();
    h.feed.notify();
    assert.deepEqual(h.sent, [50]);
    h.setEnergy(51);
    h.feed.notify();
    h.setEnergy(52);
    h.feed.notify();
    h.feed.notify();
    assert.deepEqual(h.sent, [50]);
    assert.equal(h.pending(), 1, "a single trailing timer");
    h.advance(1999);
    assert.deepEqual(h.sent, [50]);
    h.advance(1);
    assert.deepEqual(h.sent, [50, 52], "latest snapshot after the interval");
  });

  it("never sends faster than one per 2 s under continuous notifications", () => {
    const h = harness();
    const sendTimes = h.sentAt;
    for (let t = 0; t < 10_000; t += 100) {
      h.setEnergy(t);
      h.feed.notify();
      h.advance(100);
    }
    for (let i = 1; i < sendTimes.length; i++) {
      assert.ok(sendTimes[i] - sendTimes[i - 1] >= 2000, `gap ${sendTimes[i] - sendTimes[i - 1]}`);
    }
    assert.ok(sendTimes.length >= 4);
  });

  it("skips an unchanged snapshot", () => {
    const h = harness();
    h.feed.notify();
    h.advance(5000);
    h.feed.notify();
    assert.deepEqual(h.sent, [50]);
  });

  it("drops a pending send when Settings closes, and resends after reopening", () => {
    const h = harness();
    h.feed.notify();
    h.setEnergy(60);
    h.feed.notify();
    h.state.open = false;
    h.advance(3000);
    assert.deepEqual(h.sent, [50]);
    h.feed.notify();
    assert.equal(h.pending(), 0);
    h.state.open = true;
    h.setEnergy(50);
    h.feed.notify();
    assert.deepEqual(h.sent, [50, 50], "a reopened window gets a fresh push");
  });

  it("swallows a throwing snapshot reader or sender", () => {
    const feed = createCompanionMoodFeed({
      getSnapshot: () => { throw new Error("boom"); },
      send: () => { throw new Error("boom"); },
      isOpen: () => true,
    });
    assert.doesNotThrow(() => feed.notify());
    feed.dispose();
  });
});
