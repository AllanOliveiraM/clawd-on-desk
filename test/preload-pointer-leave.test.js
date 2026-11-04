"use strict";

// Clawd Alive XWayland cursor trust (Ruling N2): Settings and Dashboard tell
// main when the pointer leaves the window.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function load(file) {
  const sends = [];
  const listeners = new Map();
  const ipcRenderer = {
    invoke: () => Promise.resolve(null),
    send: (...args) => sends.push(args),
    on: () => {},
    removeListener: () => {},
  };
  const context = {
    console,
    process: { argv: [], platform: "linux" },
    window: {
      addEventListener: (name, fn, opts) => listeners.set(name, { fn, opts }),
    },
    require(name) {
      if (name === "electron") return { contextBridge: { exposeInMainWorld() {} }, ipcRenderer };
      throw new Error(`Unexpected preload dependency: ${name}`);
    },
  };
  vm.createContext(context);
  const full = path.join(__dirname, "..", "src", file);
  vm.runInContext(fs.readFileSync(full, "utf8"), context, { filename: full });
  return { sends, listeners };
}

for (const file of ["preload-settings.js", "preload-dashboard.js"]) {
  test(`${file} reports a pointer leaving the window, not moves between elements`, () => {
    const { sends, listeners } = load(file);
    const entry = listeners.get("mouseout");
    assert.ok(entry, "mouseout listener");
    assert.equal(entry.opts && entry.opts.passive, true);
    entry.fn({ relatedTarget: { tagName: "DIV" } });
    assert.deepEqual(sends, []);
    entry.fn({ relatedTarget: null });
    assert.deepEqual(sends, [["companion:pointer-left"]]);
  });
}

test("the preloads still load without a window (tests, early boot)", () => {
  for (const file of ["preload-settings.js", "preload-dashboard.js"]) {
    const full = path.join(__dirname, "..", "src", file);
    const context = {
      console,
      process: { argv: [], platform: "linux" },
      require: () => ({ contextBridge: { exposeInMainWorld() {} }, ipcRenderer: { send() {}, on() {}, invoke() {}, removeListener() {} } }),
    };
    vm.createContext(context);
    assert.doesNotThrow(() => vm.runInContext(fs.readFileSync(full, "utf8"), context, { filename: full }), file);
  }
});
