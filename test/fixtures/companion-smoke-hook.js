"use strict";

// Loaded with `electron -r` ahead of the real app (src/main.js), so everything
// here observes the shipped wiring instead of replacing it. Records what main
// really sent to the renderers, drives the real hit window, writes JSON lines
// to CLAWD_SMOKE_OUT and exits the app. See companion-electron-smoke.test.js.

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { app, BrowserWindow, ipcMain, screen } = require("electron");

const REPO = path.resolve(__dirname, "..", "..");
const OUT = process.env.CLAWD_SMOKE_OUT;
const PLAN = String(process.env.CLAWD_SMOKE_PLAN || "").split(",").filter(Boolean);
const HARD_TIMEOUT_MS = Number(process.env.CLAWD_SMOKE_HARD_TIMEOUT_MS) || 70000;

const REST_FILE = "clawd-idle-follow.svg";
const MIN_SETTLE_MS = 6000;
const SETTLE_TIMEOUT_MS = 25000;
const STROKE_STEP_MS = 16;
const STROKE_MS = 5000;
const STROKE_PERIOD = 90;
const BRIDGE_LINE_MS = 60;
const BRIDGE_MIN_STREAM_MS = 5000;
// Walks are random: keep the stream going a little to see one under it.
const BRIDGE_MAX_STREAM_MS = 18000;
const BRIDGE_WALK_WATCH_MS = 1500;

const startedAt = Date.now();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let phase = "startup";
function emit(type, data = {}) {
  const line = JSON.stringify({ type, phase, t: Date.now() - startedAt, ...data });
  fs.appendFileSync(OUT, `${line}\n`);
}

function finish(code) {
  emit("exit", { code });
  app.exit(code);
}

setTimeout(() => {
  emit("hard-timeout");
  finish(3);
}, HARD_TIMEOUT_MS);

// ---- what main sends ----

let files = [];
let eyeMoves = 0;

function noteVisual(args) {
  const payload = args[0] && typeof args[0] === "object" ? args[0] : null;
  const file = payload ? payload.file : args[1];
  const state = payload ? payload.displayState || payload.state : args[0];
  files.push(file);
  emit("visual", { file, state });
}

app.on("web-contents-created", (_event, contents) => {
  const send = contents.send.bind(contents);
  contents.send = (channel, ...args) => {
    if (channel === "state-change") noteVisual(args);
    else if (channel === "eye-move") eyeMoves += 1;
    return send(channel, ...args);
  };
});

ipcMain.on("pet-interaction:gesture", (_event, kind) => emit("gesture", { kind }));

// ---- the real runtime and roam, captured as main creates them ----

let runtime = null;
let streamed = null; // points written by the fake extension, once streaming

const runtimeModule = require(path.join(REPO, "src", "companion-runtime.js"));
const createCompanionRuntime = runtimeModule.createCompanionRuntime;
runtimeModule.createCompanionRuntime = (options) => {
  const created = createCompanionRuntime(options);
  const tick = created.tick;
  created.tick = (cursor, info) => {
    if (streamed) {
      emit("tick", {
        x: cursor ? cursor.x : null,
        y: cursor ? cursor.y : null,
        cursorTrusted: !!(info && info.cursorTrusted),
      });
    }
    return tick(cursor, info);
  };
  runtime = created;
  return created;
};

let roam = null;
const roamPath = require.resolve(path.join(REPO, "src", "roam.js"));
const initRoam = require(roamPath);
require.cache[roamPath].exports = (ctx) => {
  const created = initRoam(ctx);
  const cancelRoam = created.cancelRoam;
  created.cancelRoam = (...args) => {
    // Also drops the pause before a walk, so a call with no walk on still counts.
    emit("roam-cancelled", { walking: created.isRoamAnimating() });
    return cancelRoam(...args);
  };
  roam = created;
  return created;
};

// ---- the fake GNOME extension: listening before the app starts ----

const bridgeClients = new Set();
function startBridgeServer() {
  const socketPath = path.join(process.env.XDG_RUNTIME_DIR, "clawd-pointer.sock");
  const server = net.createServer((socket) => {
    bridgeClients.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => bridgeClients.delete(socket));
    emit("bridge-connected");
  });
  server.on("error", (err) => emit("failure", { message: `bridge server: ${err.message}` }));
  server.listen(socketPath);
}

// Sweeps the top of the screen, far from the pet's corner: his eyes follow the
// direction, so a small circle far away would not move them.
function bridgePoint(i) {
  const leg = i % 20;
  return { x: 200 + (leg < 10 ? leg : 20 - leg) * 160, y: 100 + (i % 7) * 5 };
}

async function streamBridge() {
  streamed = [];
  const before = eyeMoves;
  let walkSeenAt = null;
  const started = Date.now();
  for (let i = 0; ; i += 1) {
    const elapsed = Date.now() - started;
    if (walkSeenAt === null && roam.isRoamAnimating()) {
      walkSeenAt = Date.now();
      emit("walk-seen");
    }
    const walkWatched = walkSeenAt !== null && Date.now() - walkSeenAt >= BRIDGE_WALK_WATCH_MS;
    if (elapsed >= BRIDGE_MAX_STREAM_MS || (elapsed >= BRIDGE_MIN_STREAM_MS && walkWatched)) break;
    const point = bridgePoint(i);
    streamed.push(point);
    for (const client of bridgeClients) client.write(`${point.x} ${point.y} 0\n`);
    await wait(BRIDGE_LINE_MS);
  }
  emit("bridge-done", { lines: streamed.length, eyeMoves: eyeMoves - before, streamed });
}

// ---- driving the real hit window ----

function hitWindow() {
  return BrowserWindow.getAllWindows()
    .find((win) => !win.isDestroyed() && /hit/.test(win.webContents.getURL())) || null;
}

async function until(label, check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await wait(50);
  }
  emit("wait-timeout", { label });
  return false;
}

function isResting() {
  return !runtime.isAnimating() && files[files.length - 1] === REST_FILE;
}

async function settle() {
  const ready = await until("settle", () => {
    const hit = hitWindow();
    return Date.now() - startedAt >= MIN_SETTLE_MS
      && !!hit && !hit.webContents.isLoading()
      && !!runtime && !!roam
      && runtime.debugCatalog().length > 0
      && isResting();
  }, SETTLE_TIMEOUT_MS);
  emit("settled", {
    ready,
    catalog: runtime ? runtime.debugCatalog().length : 0,
    hit: hitWindow() ? hitWindow().getBounds() : null,
  });
  return ready;
}

// A sine stroke across the hit window. Outside [0, width) the pointer is off
// the window, so it only gets the leave, as on a real desktop.
async function stroke(amplitude) {
  const hit = hitWindow();
  const { width, height } = hit.getBounds();
  const cx = Math.floor(width / 2);
  const y = Math.floor(height / 2);
  const send = (type, x) => hit.webContents.sendInputEvent({ type, x, y });
  send("mouseEnter", cx);
  let inside = true;
  const started = Date.now();
  while (Date.now() - started < STROKE_MS) {
    const x = Math.round(cx + amplitude * Math.sin((Date.now() - started) / STROKE_PERIOD));
    const nowInside = x >= 0 && x < width;
    if (nowInside && !inside) send("mouseEnter", x);
    else if (!nowInside && inside) send("mouseLeave", Math.max(0, Math.min(width - 1, x)));
    if (nowInside) send("mouseMove", x);
    inside = nowInside;
    await wait(STROKE_STEP_MS);
  }
  if (inside) send("mouseLeave", width - 1);
  emit("strokes-stopped", { width });
}

// Input events reach the hit window only; the desktop cursor under Xvfb never
// moves, and with it the app would look away at 20 s and doze at 60 s, part way
// through a shared launch. One pixel of mouse between phases, as any user makes.
let cursorOffset = 0;
function installCursorNudge() {
  const read = screen.getCursorScreenPoint.bind(screen);
  screen.getCursorScreenPoint = () => {
    const point = read();
    return { x: point.x + cursorOffset, y: point.y };
  };
}

async function nudgeCursor() {
  cursorOffset = cursorOffset === 0 ? 1 : 0;
  await wait(200);
}

const PHASES = {
  async petting() {
    await stroke(25);
    await until("petting rest", () => files.includes("clawd-alive-petting-out.svg") && isResting(), 12000);
  },
  async overshoot() {
    await stroke(62);
    await until("overshoot rest", () => files.includes("clawd-alive-petting-out.svg") && isResting(), 12000);
  },
  async fakeNap() {
    emit("debug-play", { id: "fakeNap", result: runtime.debugPlay("fakeNap") });
    // The nap lasts until something wakes him: the next phase takes over.
    await until("fake nap", () => files.includes("clawd-alive-fake-nap.svg"), 8000);
  },
  async mood() {
    emit("debug-play", { id: "mood", result: runtime.debugPlay("mood", { variant: "content" }) });
    await until("mood started", () => files.length > 0, 3000);
    await until("mood rest", isResting, 12000);
  },
  async bridge() {
    await streamBridge();
  },
};

async function run() {
  if (!(await settle())) return finish(2);
  for (const name of PLAN) {
    await nudgeCursor();
    phase = name;
    files = [];
    emit("phase");
    await PHASES[name]();
  }
  return finish(0);
}

if (PLAN.includes("bridge")) startBridgeServer();

app.whenReady().then(() => {
  if (!PLAN.includes("bridge")) installCursorNudge();
  return run();
}).catch((err) => {
  emit("failure", { message: String(err && err.stack || err) });
  finish(2);
});
