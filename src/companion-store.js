"use strict";

// Bounded, atomic persistence for the opt-in companion ("Clawd Alive").
// Stores only the mood state and a preferred rest spot. No electron dependency.

const nodeFs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createInitialState, sanitizeState } = require("./companion-model");

const FILE_VERSION = 1;

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function unitNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function sanitizeRestSpot(raw) {
  if (!isObject(raw)) return null;
  const { displayId, x, y } = raw;
  if (displayId !== null && !(typeof displayId === "number" && Number.isFinite(displayId))) return null;
  if (!unitNumber(x) || !unitNumber(y)) return null;
  return { displayId, x, y };
}

function createCompanionStore(options = {}) {
  const {
    filePath,
    fs = nodeFs,
    now = Date.now,
    setTimeout: setTimer = setTimeout,
    clearTimeout: clearTimer = clearTimeout,
    debounceMs = 30000,
    maxBytes = 16384,
  } = options;

  let pending = null;
  let timer = null;
  let readOnly = false;

  function warn(message, error) {
    console.warn(message, error && error.message ? error.message : error || "");
  }

  function quarantine() {
    try {
      fs.renameSync(filePath, `${filePath}.corrupt-${now()}`);
    } catch (error) {
      warn("Clawd: companion state could not be quarantined", error);
    }
  }

  function initial() {
    return { state: createInitialState(), restSpot: null };
  }

  function load() {
    if (!filePath) return initial();
    let text;
    try {
      if (fs.statSync(filePath).size > maxBytes) {
        quarantine();
        return initial();
      }
      text = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      if (!error || error.code !== "ENOENT") warn("Clawd: companion state could not be read", error);
      return initial();
    }
    let raw;
    try {
      raw = JSON.parse(text.replace(/^﻿/, ""));
    } catch {
      raw = null;
    }
    if (!isObject(raw) || !Number.isInteger(raw.version) || raw.version < 1 || !isObject(raw.mood)) {
      quarantine();
      return initial();
    }
    if (raw.version > FILE_VERSION) {
      // Written by a newer build: never overwrite it.
      readOnly = true;
      return initial();
    }
    const state = sanitizeState({
      mood: raw.mood,
      label: raw.label,
      lastAdvanceAt: raw.lastAdvanceAt,
      lastInteractionAt: raw.lastInteractionAt,
    }, now());
    return { state, restSpot: sanitizeRestSpot(raw.restSpot) };
  }

  function clearTimer_() {
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
  }

  function flush() {
    clearTimer_();
    if (!pending || !filePath) return;
    const payload = pending;
    pending = null;
    if (readOnly) return;
    const { state } = payload;
    const body = JSON.stringify({
      version: FILE_VERSION,
      mood: state.mood,
      label: state.label,
      lastAdvanceAt: state.lastAdvanceAt,
      lastInteractionAt: state.lastInteractionAt,
      restSpot: sanitizeRestSpot(payload.restSpot),
    });
    const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(tmpPath, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
      fs.renameSync(tmpPath, filePath);
    } catch (error) {
      try { fs.unlinkSync(tmpPath); } catch {}
      warn("Clawd: companion state could not be saved", error);
    }
  }

  function schedule(payload) {
    if (!filePath || !payload || !payload.state) return;
    pending = { state: payload.state, restSpot: payload.restSpot || null };
    if (readOnly || timer) return;
    timer = setTimer(() => {
      timer = null;
      flush();
    }, debounceMs);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  function remove() {
    clearTimer_();
    pending = null;
    readOnly = false;
    if (!filePath) return;
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      if (!error || error.code !== "ENOENT") warn("Clawd: companion state could not be removed", error);
    }
  }

  function dispose() {
    flush();
  }

  return { load, schedule, flush, remove, dispose };
}

module.exports = { createCompanionStore };
