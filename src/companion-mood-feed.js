"use strict";

// Clawd Alive mood card feed (spec 2026-11-04 §3). Main pushes the mood
// snapshot to an open Settings window, at most once per 2 s, driven by the
// events that can move the mood (companion visuals, gestures, events). It
// never polls: with Settings closed notify() returns without arming a timer.

const { moodLabel, PERSONALITY_IDS } = require("./companion-model");

const MOOD_FEED_MIN_INTERVAL_MS = 2000;
const MOOD_LABELS = new Set(["content", "tired", "grumpy", "neutral"]);
const PERSONALITIES = new Set(Array.isArray(PERSONALITY_IDS) ? PERSONALITY_IDS : []);

function bar(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// Shape the renderer may rely on: { mood: {energy, contentment, familiarity}
// (integers 0-100), label, personality|null, lastInteractionAt|null }.
function normalizeMoodSnapshot(raw) {
  if (!raw || typeof raw !== "object" || !raw.mood || typeof raw.mood !== "object") return null;
  const at = Number(raw.lastInteractionAt);
  return {
    mood: {
      energy: bar(raw.mood.energy),
      contentment: bar(raw.mood.contentment),
      familiarity: bar(raw.mood.familiarity),
    },
    label: MOOD_LABELS.has(raw.label) ? raw.label : "neutral",
    personality: PERSONALITIES.has(raw.personality) ? raw.personality : null,
    lastInteractionAt: raw.lastInteractionAt != null && Number.isFinite(at) && at > 0 ? at : null,
  };
}

// runtime.getMoodSnapshot() when present; an older runtime only has getMood().
function readMoodSnapshot(runtime) {
  if (!runtime) return null;
  try {
    if (typeof runtime.getMoodSnapshot === "function") {
      return normalizeMoodSnapshot(runtime.getMoodSnapshot());
    }
    if (typeof runtime.getMood === "function") {
      const mood = runtime.getMood();
      if (!mood || typeof mood !== "object") return null;
      return normalizeMoodSnapshot({ mood, label: moodLabel(mood), personality: null, lastInteractionAt: null });
    }
  } catch {
    return null;
  }
  return null;
}

function createCompanionMoodFeed({
  getSnapshot,
  send,
  isOpen,
  now = Date.now,
  setTimeout: schedule = setTimeout,
  clearTimeout: unschedule = clearTimeout,
  minIntervalMs = MOOD_FEED_MIN_INTERVAL_MS,
} = {}) {
  let lastSentAt = -Infinity;
  let lastJson = null;
  let timer = null;
  let disposed = false;

  function open() {
    try { return isOpen() === true; } catch { return false; }
  }

  function cancel() {
    if (timer) unschedule(timer);
    timer = null;
  }

  function flush() {
    timer = null;
    if (disposed) return false;
    if (!open()) {
      lastJson = null;
      return false;
    }
    let snapshot = null;
    try { snapshot = getSnapshot(); } catch { snapshot = null; }
    if (!snapshot) return false;
    const json = JSON.stringify(snapshot);
    if (json === lastJson) return false;
    lastJson = json;
    lastSentAt = now();
    try {
      send(snapshot);
    } catch {
      // A failed send must not count as delivered: the next notify retries.
      lastJson = null;
    }
    return true;
  }

  function notify() {
    if (disposed) return false;
    if (!open()) {
      cancel();
      lastJson = null;
      return false;
    }
    if (timer) return false;
    // Clamp to [0, minIntervalMs]: a backwards clock step must not stall pushes.
    const wait = Math.min(minIntervalMs, lastSentAt + minIntervalMs - now());
    if (wait <= 0) return flush();
    timer = schedule(flush, wait);
    if (timer && typeof timer.unref === "function") timer.unref();
    return true;
  }

  function dispose() {
    disposed = true;
    cancel();
  }

  return { notify, dispose };
}

module.exports = {
  MOOD_FEED_MIN_INTERVAL_MS,
  normalizeMoodSnapshot,
  readMoodSnapshot,
  createCompanionMoodFeed,
};
