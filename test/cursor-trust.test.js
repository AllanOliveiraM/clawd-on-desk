"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createCursorTrust, MOTION_TRUST_MS } = require("../src/cursor-trust");
const { isXWaylandSession } = require("../src/linux-ozone");

const WAYLAND = { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" };

test("XWayland session: Linux, x11 backend, Wayland session (XDG_SESSION_TYPE first)", () => {
  assert.equal(isXWaylandSession({ platform: "linux", env: WAYLAND, ozonePlatform: "x11" }), true);
  assert.equal(isXWaylandSession({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" }, ozonePlatform: "x11" }), true);
  // Xorg login, even with a stray WAYLAND_DISPLAY: the session type wins.
  assert.equal(isXWaylandSession({ platform: "linux", env: { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" }, ozonePlatform: "x11" }), false);
  assert.equal(isXWaylandSession({
    platform: "linux", env: { XDG_SESSION_TYPE: "x11", WAYLAND_DISPLAY: "wayland-0" }, ozonePlatform: "x11",
  }), false);
  assert.equal(isXWaylandSession({ platform: "linux", env: WAYLAND, ozonePlatform: "wayland" }), false);
  assert.equal(isXWaylandSession({ platform: "linux", env: WAYLAND, ozonePlatform: "" }), false);
  for (const platform of ["win32", "darwin"]) {
    assert.equal(isXWaylandSession({ platform, env: WAYLAND, ozonePlatform: "x11" }), false, platform);
  }
});

const SETTINGS = { bounds: { x: 900, y: 50, width: 400, height: 600 }, pinned: true };
const HUD = { bounds: { x: 100, y: 100, width: 200, height: 150 }, pinned: false };

function setup({ enabled = true, windows = [SETTINGS, HUD] } = {}) {
  const env = { t: 0, reads: 0, windows };
  env.trust = createCursorTrust({
    enabled,
    now: () => env.t,
    getWindows: () => { env.reads += 1; return env.windows; },
  });
  env.at = (x, y, dt = 250) => { env.t += dt; return env.trust.isTrusted({ x, y }); };
  return env;
}

test("outside XWayland every sample is trusted and no window is read", () => {
  const env = setup({ enabled: false });
  assert.equal(env.trust.enabled, false);
  assert.equal(env.at(5000, 5000), true);
  env.trust.notePointerLeft();
  assert.equal(env.at(5000, 5000, 60000), true);
  assert.equal(env.reads, 0);
});

test("parked inside Settings / Dashboard: trusted even when still", () => {
  const env = setup();
  assert.equal(env.trust.enabled, true);
  assert.equal(env.at(1000, 400), true);
  for (let i = 0; i < 40; i += 1) assert.equal(env.at(1000, 400, 1000), true, `still ${i}`);
});

test("cursor left Settings: the frozen point is untrusted until new motion inside a window", () => {
  const env = setup();
  assert.equal(env.at(1000, 400), true);
  env.trust.notePointerLeft();
  assert.equal(env.at(1000, 400), false, "frozen at the last point inside Settings");
  assert.equal(env.at(1000, 400, 60000), false);
  assert.equal(env.at(1010, 400), true, "the pointer came back and moved");
  assert.equal(env.at(1010, 400, 5000), true, "and may park again");
});

test("HUD, bubbles and the hit rect: trusted only while the point moved within 2 s", () => {
  const env = setup();
  assert.equal(env.at(150, 120), false, "a first still sample is not motion");
  assert.equal(env.at(160, 120), true, "moved");
  assert.equal(env.at(160, 120, MOTION_TRUST_MS - 250), true, "still, within 2 s");
  assert.equal(env.at(160, 120, 250), true, "exactly 2 s");
  assert.equal(env.at(160, 120, 1), false, "still point over the HUD after 2 s");
  assert.equal(env.at(170, 130), true);
  env.trust.notePointerLeft();
  assert.equal(env.at(170, 130, 0), false, "a leave report also drops the motion trust");
});

test("anywhere else (another app, the transparent pet window area) is never trusted", () => {
  const env = setup();
  assert.equal(env.at(600, 400), false);
  assert.equal(env.at(620, 410), false, "moving over another app");
  assert.equal(env.trust.isTrusted(null), false);
  assert.equal(env.trust.isTrusted({ x: NaN, y: 1 }), false);
  const bad = setup({ windows: [null, { bounds: { x: 0, y: 0, width: "a", height: 5 }, pinned: true }] });
  assert.equal(bad.at(1, 1), false);
  const broken = createCursorTrust({ enabled: true, getWindows: () => { throw new Error("gone"); } });
  assert.equal(broken.isTrusted({ x: 1, y: 1 }), false);
});

test("the window list is read at most once per second", () => {
  const env = setup();
  for (let i = 0; i < 8; i += 1) env.at(1000 + i, 400, 100);
  assert.equal(env.reads, 1);
  env.at(1000, 400, 300);
  assert.equal(env.reads, 2);
});
