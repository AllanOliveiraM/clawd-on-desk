"use strict";

// Client of the optional GNOME Shell extension in extensions/gnome-shell: it
// streams the real pointer position over a private socket, which XWayland
// cannot see by itself. No extension, no connection: getPoint() stays null and
// callers use Electron's cursor as usual.

const net = require("net");
const path = require("path");

const SOCKET_NAME = "clawd-pointer.sock";
const RETRY_MS = 5000;
const MAX_BUFFER_CHARS = 256;

function defaultSocketPath(env = process.env) {
  return env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, SOCKET_NAME) : null;
}

function parseLine(line) {
  const match = /^(-?\d+) (-?\d+)(?: ([01]))?$/.exec(line);
  return match ? { x: Number(match[1]), y: Number(match[2]), shift: match[3] === "1" } : null;
}

function createPointerBridge({
  socketPath = defaultSocketPath(),
  connect = net.connect,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let active = false;
  let socket = null;
  let retryTimer = null;
  let point = null;
  let shiftHeld = false;
  let buffer = "";

  function forget() {
    point = null;
    shiftHeld = false;
    buffer = "";
  }

  function clearRetry() {
    if (retryTimer === null) return;
    clearTimer(retryTimer);
    retryTimer = null;
  }

  function scheduleRetry() {
    if (!active || retryTimer !== null) return;
    retryTimer = setTimer(() => {
      retryTimer = null;
      open();
    }, RETRY_MS);
    if (retryTimer && typeof retryTimer.unref === "function") retryTimer.unref();
  }

  function onData(chunk) {
    buffer += String(chunk);
    const lines = buffer.split("\n");
    buffer = lines.pop();
    if (buffer.length > MAX_BUFFER_CHARS) buffer = "";
    for (const line of lines) {
      const next = parseLine(line);
      if (next) {
        point = { x: next.x, y: next.y };
        shiftHeld = next.shift;
      }
    }
  }

  function onGone(owner) {
    if (socket !== owner) return;
    socket = null;
    forget();
    scheduleRetry();
  }

  function open() {
    if (!active || socket || !socketPath) return;
    let next;
    try {
      next = connect(socketPath);
    } catch {
      scheduleRetry();
      return;
    }
    socket = next;
    next.on("data", onData);
    next.on("error", () => onGone(next));
    next.on("close", () => onGone(next));
  }

  function setActive(on) {
    active = on === true;
    if (active) {
      open();
      return;
    }
    clearRetry();
    const current = socket;
    socket = null;
    forget();
    if (current) current.destroy();
  }

  return {
    setActive,
    getPoint: () => point,
    isShiftHeld: () => shiftHeld,
    dispose: () => setActive(false),
  };
}

module.exports = { createPointerBridge, defaultSocketPath, parseLine };
