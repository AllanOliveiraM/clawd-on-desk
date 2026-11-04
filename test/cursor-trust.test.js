"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createCursorTrust, MOTION_TRUST_MS, PINNED_STILL_TRUST_MS } = require("../src/cursor-trust");
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

const SETTINGS = { id: 7, bounds: { x: 900, y: 50, width: 400, height: 600 }, pinned: true };
const HUD = { id: 3, bounds: { x: 100, y: 100, width: 200, height: 150 }, pinned: false };

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

test("parked inside Settings / Dashboard after moving in it: trusted while still, up to 90 s", () => {
  const env = setup();
  assert.equal(env.trust.enabled, true);
  assert.equal(PINNED_STILL_TRUST_MS, 90000);
  env.at(990, 400);
  assert.equal(env.at(1000, 400), true, "moved inside Settings");
  for (let i = 0; i < 40; i += 1) assert.equal(env.at(1000, 400, 1000), true, `still ${i}`);
});

test("no leave report: still-trust in Settings ends after 90 s without motion", () => {
  const env = setup();
  env.at(990, 400);
  assert.equal(env.at(1000, 400), true);
  assert.equal(env.at(1000, 400, 89750), true, "90 s still");
  assert.equal(env.at(1000, 400, 1000), false, "91 s still: untrusted");
  assert.equal(env.at(1000, 400, 60000), false);
  assert.equal(env.at(1005, 400), true, "new motion inside re-arms it");
});

test("Settings reopened over a frozen point: untrusted until motion inside it", () => {
  const env = setup();
  env.at(990, 400);
  assert.equal(env.at(1000, 400), true);
  env.windows = [HUD]; // closed with the pointer inside, no leave report
  assert.equal(env.at(1000, 400, 1000), false);
  env.windows = [{ ...SETTINGS, id: 8 }]; // reopened (a new window) over the frozen point
  // Past the 2 s motion window that any app window gets.
  assert.equal(env.at(1000, 400, 1500), false, "no motion inside since it opened");
  assert.equal(env.at(1000, 400, 1000), false);
  assert.equal(env.at(1001, 400), true, "moved inside the reopened window");
  // Hidden and shown again (same window): also needs new motion.
  env.windows = [];
  env.at(1001, 400, 1000);
  env.windows = [{ ...SETTINGS, id: 8 }];
  assert.equal(env.at(1001, 400, 1500), false);
});

test("a first still sample inside Settings (nothing seen before) is not trusted", () => {
  const env = setup();
  assert.equal(env.at(1000, 400), false);
});

test("cursor left Settings: the frozen point is untrusted until new motion inside a window", () => {
  const env = setup();
  env.at(990, 400);
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

test("a pinned window opened inside the 1 s cache gap arms on later motion inside it", () => {
  const env = setup({ windows: [HUD] });
  env.at(5000, 5000, 100); // cache read: no Settings yet
  env.windows = [HUD, SETTINGS]; // opened inside the cache gap
  env.at(990, 400, 100);
  env.at(1000, 400, 100);
  env.at(1010, 400, 100);
  assert.equal(env.at(1010, 400, 5000), true, "parked in the freshly opened Settings");
});

test("a pinned window closed and reopened (new id) inside the cache gap is not armed", () => {
  const env = setup();
  env.at(990, 400);
  assert.equal(env.at(1000, 400), true);
  env.windows = [HUD, { ...SETTINGS, id: 9 }]; // closed + reopened within 1 s
  env.at(1010, 400, 100);
  env.at(1020, 400, 100);
  assert.equal(env.at(1020, 400, 5000), false, "no motion since the new window appeared");
  assert.equal(env.at(1030, 400, 100), true, "motion after the re-read arms it");
});

test("pinned still-trust is inclusive at exactly 90 s and ends at 90 s + 1 ms", () => {
  const env = setup();
  env.at(990, 400);
  env.at(1000, 400); // motion at t
  assert.equal(env.at(1000, 400, PINNED_STILL_TRUST_MS), true, "exactly 90 s since the motion");
  assert.equal(env.at(1000, 400, 1), false, "90 s + 1 ms");
});

test("a leave report clears every pinned arm: two pinned windows (G3)", () => {
  const dash = { id: 8, bounds: { x: 0, y: 700, width: 400, height: 300 }, pinned: true };
  const env = setup({ windows: [SETTINGS, dash, HUD] });
  env.at(990, 400);
  assert.equal(env.at(1000, 400), true, "armed in Settings");
  env.at(10, 710);
  assert.equal(env.at(20, 710), true, "armed in Dashboard");
  env.trust.notePointerLeft();
  assert.equal(env.at(20, 710, 3000), false, "left: frozen point untrusted");
  assert.equal(env.at(20, 710, 60000), false, "still untrusted long after the leave");
  // Motion in either pinned window re-arms that window only.
  assert.equal(env.at(1001, 400, 100), true, "motion in Settings");
  assert.equal(env.at(1001, 400, 5000), true, "parked in Settings");
  assert.equal(env.at(21, 710, 100), true, "motion in Dashboard");
  assert.equal(env.at(21, 710, 5000), true, "parked in Dashboard");
  env.trust.notePointerLeft();
  assert.equal(env.at(21, 710, 100), false, "a second leave clears again");
});

test("id churn: a new id is not armed; windows without id are keyed by bounds", () => {
  const env = setup();
  env.at(990, 400);
  assert.equal(env.at(1000, 400), true);
  env.windows = [{ ...SETTINGS, id: 99 }]; // same bounds, different window
  assert.equal(env.at(1000, 400, 3000), false, "new id over a frozen point");

  const noId = { bounds: SETTINGS.bounds, pinned: true };
  const e2 = setup({ windows: [noId] });
  e2.at(990, 400);
  assert.equal(e2.at(1000, 400), true);
  assert.equal(e2.at(1000, 400, 60000), true, "armed by its bounds key");
  e2.windows = [{ bounds: { ...SETTINGS.bounds, x: 901 }, pinned: true }]; // moved: another key
  assert.equal(e2.at(1000, 400, 3000), false, "moved window is a new key");
  const id0 = setup({ windows: [{ ...SETTINGS, id: 0 }] });
  id0.at(990, 400);
  assert.equal(id0.at(1000, 400), true);
  assert.equal(id0.at(1000, 400, 60000), true, "id 0 is a real id");
});

test("pinned must be exactly true: the string 'true' is an ordinary window", () => {
  const env = setup({ windows: [{ ...SETTINGS, pinned: "true" }] });
  env.at(990, 400);
  assert.equal(env.at(1000, 400), true, "moved: motion trust");
  assert.equal(env.at(1000, 400, 5000), false, "no pinned still-trust");
});

test("a clock that goes backwards is untrusted until the next motion", () => {
  const env = setup();
  env.at(990, 400);
  assert.equal(env.at(1000, 400), true);
  assert.equal(env.at(1000, 400, -500), false);
  assert.equal(env.at(1010, 400, 0), true, "motion restores it");
});

test("window bounds are inclusive and invalid bounds are filtered", () => {
  const env = setup({ windows: [HUD] });
  env.at(100, 100);
  assert.equal(env.at(101, 100), true, "top-left corner area");
  assert.equal(env.at(300, 250), true, "bottom-right corner is inside");
  assert.equal(env.at(301, 250), false, "one past the right edge");
  assert.equal(env.at(300, 251), false, "one past the bottom edge");
  const bad = setup({ windows: [
    { id: 1, bounds: { x: 0, y: 0, width: NaN, height: 100 }, pinned: true },
    { id: 2, bounds: { x: 0, y: 0, width: Infinity, height: 100 }, pinned: true },
    { id: 3, bounds: null, pinned: true },
    { id: 4, pinned: true },
  ] });
  bad.at(5, 5);
  assert.equal(bad.at(6, 5), false);
  assert.equal(bad.at(6, 5, 5000), false);
  const zero = setup({ windows: [{ id: 5, bounds: { x: 10, y: 10, width: 0, height: 0 }, pinned: true }] });
  zero.at(0, 0);
  assert.equal(zero.at(5, 5), false, "a zero-size window contains nothing but its own point");
});

test("a non-array window list is treated as no windows; enabled:false never reads", () => {
  for (const list of [null, undefined, {}, "x", 5]) {
    const t = createCursorTrust({ enabled: true, now: () => 0, getWindows: () => list });
    assert.equal(t.isTrusted({ x: 1, y: 1 }), false);
    assert.equal(t.isTrusted({ x: 2, y: 1 }), false);
  }
  let reads = 0;
  const off = createCursorTrust({ enabled: false, getWindows: () => { reads += 1; return []; } });
  assert.equal(off.isTrusted(null), true);
  assert.equal(off.isTrusted({ x: NaN, y: 0 }), true);
  assert.equal(reads, 0);
  assert.equal(createCursorTrust().enabled, false, "disabled by default");
});
