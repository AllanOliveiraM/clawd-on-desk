"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createGnomePointerExtension, parseExtensionList, EXTENSION_UUID } = require("../src/gnome-pointer-extension");

const SOURCE = path.join(__dirname, "..", "extensions", "gnome-shell", EXTENSION_UUID);
const VERSION = JSON.parse(fs.readFileSync(path.join(SOURCE, "metadata.json"), "utf8"))["clawd-version"];

function make(t, opts = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-ext-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { list: "@as []", sets: [], loaded: null, fail: null };
  const ext = createGnomePointerExtension({
    supported: true,
    sourceDir: SOURCE,
    dataDir: home,
    getLoadedVersion: () => env.loaded,
    gsettings: async (args) => {
      if (env.fail) throw new Error(env.fail);
      if (args[0] === "get") return env.list;
      env.sets.push(args[3]);
      env.list = args[3];
      return "";
    },
    ...opts,
  });
  const target = path.join(home, "gnome-shell", "extensions", EXTENSION_UUID);
  return { ext, env, target };
}

function plantOld(target, version = 0) {
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "metadata.json"), JSON.stringify({ "clawd-version": version }));
  fs.writeFileSync(path.join(target, "stale.js"), "old");
}

test("reads the gsettings list", () => {
  assert.deepEqual(parseExtensionList("@as []"), []);
  assert.deepEqual(parseExtensionList("['a@b', 'c@d']\n"), ["a@b", "c@d"]);
});

test("outside a supported session it is unsupported and does nothing", async (t) => {
  const { ext, env, target } = make(t, { supported: false });
  assert.equal(ext.getState(), "unsupported");
  assert.equal(await ext.install(), "unsupported");
  ext.syncInstalled();
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(env.sets, []);
});

test("not installed is missing, and sync never installs by itself", (t) => {
  const { ext, target } = make(t);
  assert.equal(ext.getState(), "missing");
  ext.syncInstalled();
  assert.equal(fs.existsSync(target), false);
});

test("install copies the files and enables it, keeping the user's other extensions", async (t) => {
  const { ext, env, target } = make(t);
  env.list = "['caffeine@patapon.info']";
  assert.equal(await ext.install(), "needs-login");
  for (const file of ["metadata.json", "extension.js", "pointerServer.js"]) {
    assert.ok(fs.existsSync(path.join(target, file)), file);
  }
  assert.deepEqual(env.sets, [`['caffeine@patapon.info', '${EXTENSION_UUID}']`]);
});

test("install works from an empty list and never adds it twice", async (t) => {
  const { ext, env } = make(t);
  await ext.install();
  assert.deepEqual(env.sets, [`['${EXTENSION_UUID}']`]);
  await ext.install();
  assert.equal(env.sets.length, 1);
});

test("a failed enable reaches the caller", async (t) => {
  const { ext, env } = make(t);
  env.fail = "no gsettings";
  await assert.rejects(ext.install(), /no gsettings/);
});

test("active needs the session to run this very version", async (t) => {
  const { ext, env } = make(t);
  await ext.install();
  assert.equal(ext.getState(), "needs-login");
  env.loaded = VERSION - 1;
  assert.equal(ext.getState(), "needs-login", "the old one is still loaded");
  env.loaded = VERSION;
  assert.equal(ext.getState(), "active");
});

test("an older install is updated in place, leaving nothing behind and the settings alone", (t) => {
  const { ext, env, target } = make(t);
  plantOld(target);
  ext.syncInstalled();
  const metadata = JSON.parse(fs.readFileSync(path.join(target, "metadata.json"), "utf8"));
  assert.equal(metadata["clawd-version"], VERSION);
  assert.equal(fs.existsSync(path.join(target, "stale.js")), false);
  assert.deepEqual(env.sets, []);
});

test("a current install is not touched", (t) => {
  const { ext, target } = make(t);
  plantOld(target, VERSION);
  ext.syncInstalled();
  assert.ok(fs.existsSync(path.join(target, "stale.js")));
});

test("a broken metadata file counts as older, and a failed update never throws", (t) => {
  const { ext, target } = make(t);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "metadata.json"), "not json");
  ext.syncInstalled();
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, "metadata.json"), "utf8"))["clawd-version"], VERSION);
  const broken = make(t, { sourceDir: "/does/not/exist" });
  plantOld(broken.target);
  assert.doesNotThrow(() => broken.ext.syncInstalled());
  assert.ok(fs.existsSync(path.join(broken.target, "stale.js")), "the old install survives a failed copy");
});
