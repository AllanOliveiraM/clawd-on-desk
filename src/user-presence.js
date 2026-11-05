"use strict";

// How long the user has really been away, for sessions where the cursor cannot
// tell: under XWayland the app only sees the pointer over its own windows, and
// Electron's powerMonitor reports 0 there. GNOME's idle monitor sees every
// input. Asked on demand (no timer of its own), so it costs nothing unless a
// caller is near sleep time. Elsewhere, or after repeated failures, sample()
// stays null and callers keep using the mouse clock.

const { execFile } = require("child_process");

const REFRESH_MS = 3000;
const MAX_SAMPLE_AGE_MS = 10000;
const MAX_FAILURES = 3;
const GDBUS_TIMEOUT_MS = 2000;

const GDBUS_ARGS = [
  "call", "--session",
  "--dest", "org.gnome.Mutter.IdleMonitor",
  "--object-path", "/org/gnome/Mutter/IdleMonitor/Core",
  "--method", "org.gnome.Mutter.IdleMonitor.GetIdletime",
];

function parseIdleTime(output) {
  const match = /uint64\s+(\d+)/.exec(String(output));
  return match ? Number(match[1]) : null;
}

function runGdbus(done) {
  execFile("gdbus", GDBUS_ARGS, { timeout: GDBUS_TIMEOUT_MS }, (err, stdout) => done(err, stdout));
}

function createUserPresence({ enabled = false, run = runGdbus, now = Date.now } = {}) {
  let idleMs = null;
  let sampledAt = 0;
  let askedAt = -Infinity;
  let inFlight = false;
  let failures = 0;

  function settle(err, output) {
    inFlight = false;
    const parsed = err ? null : parseIdleTime(output);
    if (parsed === null) {
      failures += 1;
      return;
    }
    failures = 0;
    idleMs = parsed;
    sampledAt = now();
  }

  function refresh() {
    const t = now();
    if (!enabled || inFlight || failures >= MAX_FAILURES) return;
    if (t >= askedAt && t - askedAt < REFRESH_MS) return;
    askedAt = t;
    inFlight = true;
    try {
      run(settle);
    } catch (err) {
      settle(err);
    }
  }

  // Latest idle time in ms, aged to now; null without a recent answer.
  function sample() {
    refresh();
    if (idleMs === null) return null;
    const age = now() - sampledAt;
    if (age < 0 || age > MAX_SAMPLE_AGE_MS) return null;
    return idleMs + age;
  }

  return { sample };
}

module.exports = { createUserPresence, parseIdleTime };
