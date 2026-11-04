"use strict";

// Clawd Alive test mode (spec 2026-11-04 §2): the pet context menu grows a
// "Test animations" submenu only in dev builds or on Shift + right-click in
// packaged builds, and only with companionEnabled. Otherwise the template must
// be identical to the plain menu.

const assert = require("node:assert/strict");
const Module = require("node:module");
const { describe, it } = require("node:test");

const MENU_MODULE_PATH = require.resolve("../src/menu");

function loadMenu(fakeElectron) {
  delete require.cache[MENU_MODULE_PATH];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") return fakeElectron;
    if (request === "./taskbar") return { keepOutOfTaskbar: () => {} };
    return originalLoad.apply(this, arguments);
  };
  try {
    return require("../src/menu");
  } finally {
    Module._load = originalLoad;
  }
}

function createHarness({ isPackaged = true, companionEnabled = true, gateReason = null, withHook = true } = {}) {
  const plays = [];
  let closeCallback = null;
  const fakeElectron = {
    app: { quit: () => {}, setActivationPolicy: () => {}, dock: { show: () => {}, hide: () => {} } },
    BrowserWindow: function BrowserWindow() {},
    Menu: {
      buildFromTemplate: (template) => ({
        template,
        popup: (opts) => { closeCallback = opts.callback; },
      }),
    },
    Tray: function Tray() {},
    nativeImage: { createFromPath() { return { resize() { return this; }, setTemplateImage() {} }; } },
    screen: {
      getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }],
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => ({ id: 1 }),
    },
  };
  const initMenu = loadMenu(fakeElectron);
  const owner = { isDestroyed: () => false, setBounds() {}, show() {}, focus() {}, hide() {} };
  const ctx = {
    win: { isDestroyed: () => false, showInactive() {}, setAlwaysOnTop() {} },
    lang: "en",
    doNotDisturb: false,
    menuOpen: false,
    contextMenuOwner: owner,
    contextMenu: null,
    petHidden: false,
    getMiniMode: () => false,
    getMiniTransitioning: () => false,
    getDisableMiniMode: () => false,
    getActiveThemeCapabilities: () => ({ miniMode: true }),
    openSettingsWindow: () => {},
    reapplyMacVisibility: () => {},
    isAppPackaged: () => isPackaged,
  };
  if (withHook) {
    ctx.getCompanionTestMenu = () => ({
      companionEnabled,
      gateReason,
      catalog: [
        { group: "Moods", id: "mood.content", label: "Content" },
        { group: "Mischief", id: "fetch", label: "Fetch: ball", variant: "ball" },
      ],
      play: (id, opts) => { plays.push([id, opts]); return { ok: true }; },
    });
  }
  const menu = initMenu(ctx);
  return {
    ctx,
    menu,
    plays,
    close: () => closeCallback(),
    labels: () => ctx.contextMenu.template.map((item) => item.label || item.type),
    // Whole template minus click handlers: the "identical" checks compare this.
    json: () => JSON.stringify(ctx.contextMenu.template),
  };
}

function plainLabels(opts) {
  const h = createHarness({ ...opts, withHook: false });
  h.menu.showPetContextMenu();
  return h.labels();
}

function plainJson(opts) {
  const h = createHarness({ ...opts, withHook: false });
  h.menu.showPetContextMenu();
  return h.json();
}

function findTestItem(h) {
  return h.ctx.contextMenu.template.find((item) => item.label === "Test animations");
}

describe("context menu test mode (spec §2)", () => {
  it("packaged build without Shift keeps the template identical", () => {
    const h = createHarness({ isPackaged: true });
    h.menu.showPetContextMenu({ shiftKey: false });
    assert.equal(h.json(), plainJson({ isPackaged: true }));
    assert.equal(findTestItem(h), undefined);
  });

  it("Clawd Alive off keeps the template identical, even in dev with Shift", () => {
    for (const isPackaged of [true, false]) {
      const h = createHarness({ isPackaged, companionEnabled: false });
      h.menu.showPetContextMenu({ shiftKey: true });
      assert.equal(h.json(), plainJson({ isPackaged }));
    }
  });

  it("menu rebuilds outside a right-click never carry the submenu", () => {
    const h = createHarness({ isPackaged: false });
    h.menu.buildContextMenu();
    assert.equal(h.json(), plainJson({ isPackaged: false }));
  });

  it("packaged build with Shift adds the submenu before the app group, leaving Quit last", () => {
    const h = createHarness({ isPackaged: true });
    h.menu.showPetContextMenu({ shiftKey: true });
    const labels = h.labels();
    const plain = plainLabels({ isPackaged: true });
    const settingsIdx = plain.indexOf("Settings…") >= 0 ? plain.indexOf("Settings…") : plain.findIndex((l) => /^Settings/.test(l));
    assert.ok(settingsIdx > 0);
    const expected = [...plain.slice(0, settingsIdx), "Test animations", "separator", ...plain.slice(settingsIdx)];
    assert.deepStrictEqual(labels, expected);
    assert.equal(labels[labels.length - 1], "Quit");
  });

  it("dev build shows the submenu without Shift", () => {
    const h = createHarness({ isPackaged: false });
    h.menu.showPetContextMenu({ shiftKey: false });
    const item = findTestItem(h);
    assert.ok(item);
    assert.deepStrictEqual(item.submenu.map((g) => g.label), ["Moods", "Mischief"]);
  });

  it("an item click plays only after the menu has closed", () => {
    const h = createHarness({ isPackaged: false });
    h.menu.showPetContextMenu();
    assert.equal(h.ctx.menuOpen, true);
    findTestItem(h).submenu[1].submenu[0].click();
    assert.deepStrictEqual(h.plays, [], "the open menu still closes the gate");
    h.close();
    assert.deepStrictEqual(h.plays, [["fetch", { variant: "ball" }]]);
    h.close();
    assert.equal(h.plays.length, 1, "a pending play runs once");
  });

  it("an item click after the close callback plays immediately", () => {
    const h = createHarness({ isPackaged: false });
    h.menu.showPetContextMenu();
    const item = findTestItem(h);
    h.close();
    item.submenu[0].submenu[0].click();
    assert.deepStrictEqual(h.plays, [["mood.content", {}]]);
  });

  it("a closed gate disables the items with the reason", () => {
    const h = createHarness({ isPackaged: false, gateReason: "permission" });
    h.menu.showPetContextMenu();
    const entry = findTestItem(h).submenu[0].submenu[0];
    assert.equal(entry.enabled, false);
    assert.equal(entry.label, "Content (blocked: permission pending)");
  });

  it("a throwing hook falls back to the plain menu", () => {
    const h = createHarness({ isPackaged: false });
    h.ctx.getCompanionTestMenu = () => { throw new Error("boom"); };
    h.menu.showPetContextMenu({ shiftKey: true });
    assert.equal(h.json(), plainJson({ isPackaged: false }));
  });
});
