"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createCompanionStore } = require("../src/companion-store");
const { createInitialState } = require("../src/companion-model");

function makeTimers() {
  const timers = [];
  return {
    timers,
    setTimeout(fn, ms) { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimeout(t) { if (t) t.cleared = true; },
    fire() { for (const t of timers.splice(0)) if (!t.cleared) t.fn(); },
    active() { return timers.filter((t) => !t.cleared).length; },
  };
}

describe("companion store", () => {
  let dir, file, tm;
  const make = (extra = {}) => createCompanionStore({
    filePath: file, now: () => 1000, setTimeout: tm.setTimeout, clearTimeout: tm.clearTimeout, ...extra,
  });
  const goodState = () => {
    const s = createInitialState();
    s.mood = { energy: 20, contentment: 90, familiarity: 40 };
    s.label = "content";
    s.lastAdvanceAt = 500;
    s.lastInteractionAt = 400;
    return s;
  };
  const corrupts = () => fs.readdirSync(dir).filter((f) => f.includes(".corrupt-"));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "companion-store-"));
    file = path.join(dir, "companion-state.json");
    tm = makeTimers();
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("missing file loads initial state", () => {
    const r = make().load();
    assert.deepStrictEqual(r.state, createInitialState());
    assert.strictEqual(r.restSpot, null);
  });

  it("round trip preserves mood and restSpot", () => {
    const store = make();
    store.schedule({ state: goodState(), restSpot: { displayId: 3, x: 0.25, y: 0.75 } });
    store.flush();
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.strictEqual(raw.version, 1);
    assert.ok(!("streak" in raw));
    const r = make().load();
    assert.deepStrictEqual(r.state.mood, { energy: 20, contentment: 90, familiarity: 40 });
    assert.strictEqual(r.state.label, "content");
    assert.strictEqual(r.state.streak, null);
    assert.deepStrictEqual(r.restSpot, { displayId: 3, x: 0.25, y: 0.75 });
  });

  it("corrupt json is quarantined", () => {
    fs.writeFileSync(file, "{not json");
    const r = make().load();
    assert.deepStrictEqual(r.state, createInitialState());
    assert.strictEqual(corrupts().length, 1);
    assert.ok(!fs.existsSync(file));
  });

  it("oversized file is quarantined", () => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, pad: "x".repeat(200) }));
    const r = make({ maxBytes: 100 }).load();
    assert.deepStrictEqual(r.state, createInitialState());
    assert.strictEqual(corrupts().length, 1);
  });

  it("future version is not overwritten", () => {
    const content = JSON.stringify({ version: 2, mood: {} });
    fs.writeFileSync(file, content);
    const store = make();
    assert.deepStrictEqual(store.load().state, createInitialState());
    store.schedule({ state: goodState(), restSpot: null });
    store.flush();
    assert.strictEqual(fs.readFileSync(file, "utf8"), content);
  });

  it("remove clears readOnly after a future version", () => {
    fs.writeFileSync(file, JSON.stringify({ version: 2 }));
    const store = make();
    store.load();
    store.remove();
    assert.ok(!fs.existsSync(file));
    store.schedule({ state: goodState(), restSpot: null });
    store.flush();
    assert.ok(fs.existsSync(file));
  });

  it("out of range values are clamped", () => {
    fs.writeFileSync(file, JSON.stringify({
      version: 1, mood: { energy: 500, contentment: -3, familiarity: 50 }, label: "bogus",
    }));
    const { state } = make().load();
    assert.deepStrictEqual(state.mood, { energy: 100, contentment: 0, familiarity: 50 });
  });

  it("invalid restSpot becomes null", () => {
    for (const spot of [{ displayId: 1, x: 2, y: 0.5 }, { displayId: 1, x: 0.5, y: -1 },
      { displayId: "a", x: 0.5, y: 0.5 }, "nope", { x: "0.5", y: 0.5 }]) {
      fs.writeFileSync(file, JSON.stringify({ version: 1, mood: {}, restSpot: spot }));
      assert.strictEqual(make().load().restSpot, null, JSON.stringify(spot));
    }
    fs.writeFileSync(file, JSON.stringify({ version: 1, mood: {}, restSpot: { displayId: null, x: 0, y: 1 } }));
    assert.deepStrictEqual(make().load().restSpot, { displayId: null, x: 0, y: 1 });
  });

  it("schedule debounces to one write", () => {
    let writes = 0;
    const realFs = { ...fs, writeFileSync: (...a) => { writes++; return fs.writeFileSync(...a); } };
    const store = make({ fs: realFs });
    for (let i = 0; i < 50; i++) store.schedule({ state: goodState(), restSpot: null });
    assert.strictEqual(tm.active(), 1);
    assert.strictEqual(tm.timers[0].ms, 30000);
    assert.strictEqual(writes, 0);
    tm.fire();
    assert.strictEqual(writes, 1);
    assert.ok(fs.existsSync(file));
  });

  it("flush writes pending immediately and dispose flushes", () => {
    const store = make();
    store.schedule({ state: goodState(), restSpot: null });
    store.flush();
    assert.ok(fs.existsSync(file));
    assert.strictEqual(tm.active(), 0);
    fs.unlinkSync(file);
    store.schedule({ state: goodState(), restSpot: null });
    store.dispose();
    assert.ok(fs.existsSync(file));
    assert.strictEqual(tm.active(), 0);
  });

  it("remove deletes file and cancels pending write", () => {
    const store = make();
    store.schedule({ state: goodState(), restSpot: null });
    store.flush();
    store.schedule({ state: goodState(), restSpot: null });
    store.remove();
    assert.ok(!fs.existsSync(file));
    tm.fire();
    store.flush();
    assert.ok(!fs.existsSync(file));
    store.remove(); // ENOENT is ignored
  });

  it("write failure does not throw", () => {
    const badFs = { ...fs, renameSync: () => { throw new Error("boom"); } };
    const warn = console.warn;
    console.warn = () => {};
    try {
      const store = make({ fs: badFs });
      store.schedule({ state: goodState(), restSpot: null });
      assert.doesNotThrow(() => store.flush());
    } finally { console.warn = warn; }
    assert.deepStrictEqual(fs.readdirSync(dir), []);
  });
});
