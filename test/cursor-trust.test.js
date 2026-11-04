"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createCursorTrust } = require("../src/cursor-trust");
const { isXWaylandSession } = require("../src/linux-ozone");

const WAYLAND = { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" };

test("XWayland session: Linux, x11 backend, Wayland session", () => {
  assert.equal(isXWaylandSession({ platform: "linux", env: WAYLAND, ozonePlatform: "x11" }), true);
  assert.equal(isXWaylandSession({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" }, ozonePlatform: "x11" }), true);
  // Xorg login, native Wayland (no cursor at all), other platforms.
  assert.equal(isXWaylandSession({ platform: "linux", env: { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" }, ozonePlatform: "x11" }), false);
  assert.equal(isXWaylandSession({ platform: "linux", env: WAYLAND, ozonePlatform: "wayland" }), false);
  assert.equal(isXWaylandSession({ platform: "linux", env: WAYLAND, ozonePlatform: "" }), false);
  for (const platform of ["win32", "darwin"]) {
    assert.equal(isXWaylandSession({ platform, env: WAYLAND, ozonePlatform: "x11" }), false, platform);
  }
});

function setup({ enabled = true, windows = [] } = {}) {
  const env = { t: 0, reads: 0, windows };
  env.trust = createCursorTrust({
    enabled,
    now: () => env.t,
    getWindowBounds: () => { env.reads += 1; return env.windows; },
  });
  return env;
}

test("outside XWayland every sample is trusted and no window is read", () => {
  const env = setup({ enabled: false, windows: [] });
  assert.equal(env.trust.isTrusted({ x: 5000, y: 5000 }), true);
  assert.equal(env.reads, 0);
});

test("under XWayland a sample is trusted only inside a visible app window", () => {
  const env = setup({ windows: [{ x: 100, y: 100, width: 200, height: 150 }, { x: 900, y: 50, width: 400, height: 600 }] });
  assert.equal(env.trust.isTrusted({ x: 150, y: 120 }), true, "pet / hit");
  env.t += 2000;
  assert.equal(env.trust.isTrusted({ x: 1000, y: 400 }), true, "settings");
  env.t += 2000;
  assert.equal(env.trust.isTrusted({ x: 600, y: 400 }), false, "another app");
  env.t += 2000;
  assert.equal(env.trust.isTrusted({ x: 300, y: 250 }), true, "edges count");
  env.t += 2000;
  assert.equal(env.trust.isTrusted(null), false);
  assert.equal(env.trust.isTrusted({ x: NaN, y: 1 }), false);
  const bad = setup({ windows: [null, { x: 0, y: 0, width: "a", height: 5 }] });
  assert.equal(bad.trust.isTrusted({ x: 1, y: 1 }), false);
  const broken = createCursorTrust({ enabled: true, getWindowBounds: () => { throw new Error("gone"); } });
  assert.equal(broken.isTrusted({ x: 1, y: 1 }), false);
});

test("the same point within a second reuses the answer (no window read per tick)", () => {
  const env = setup({ windows: [{ x: 0, y: 0, width: 100, height: 100 }] });
  assert.equal(env.trust.isTrusted({ x: 50, y: 50 }), true);
  env.windows = [];
  env.t += 999;
  assert.equal(env.trust.isTrusted({ x: 50, y: 50 }), true);
  assert.equal(env.reads, 1);
  env.t += 1;
  assert.equal(env.trust.isTrusted({ x: 50, y: 50 }), false);
  assert.equal(env.trust.isTrusted({ x: 51, y: 50 }), false);
  assert.equal(env.reads, 3, "a moved point reads again");
});
