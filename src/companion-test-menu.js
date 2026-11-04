"use strict";

// Clawd Alive test mode (spec 2026-11-04 §2): a "Test animations" submenu on
// the pet context menu. It is a developer tool, so labels are fixed English.
// Pure helpers only — menu.js owns the template and main.js the runtime wiring.

const TEST_MENU_LABEL = "Test animations";

const BLOCK_REASON_TEXT = Object.freeze({
  "agent-busy": "busy: agent working",
  permission: "blocked: permission pending",
  dnd: "blocked: do not disturb",
  mini: "blocked: mini mode",
  sleeping: "blocked: sleeping",
  disabled: "blocked: Clawd Alive off",
  "missing-art": "missing art",
  "no-roam": "needs Free Roam",
});

// Dev builds (app.isPackaged === false) always; packaged builds only on
// Shift + right-click; both only with companionEnabled. Anything that is not a
// strict boolean closes the gate, and unknown packaging counts as packaged.
function shouldShowCompanionTestMenu({ isPackaged, shiftKey, companionEnabled } = {}) {
  if (companionEnabled !== true) return false;
  if (isPackaged === false) return true;
  return shiftKey === true;
}

// Menu-time gate (the runtime re-checks on play): agents, permissions, DND and
// mini always win.
function resolveCompanionTestGate({ companionEnabled = true, agentBusy, permission, dnd, mini } = {}) {
  if (companionEnabled === false) return "disabled";
  if (agentBusy) return "agent-busy";
  if (permission) return "permission";
  if (dnd) return "dnd";
  if (mini) return "mini";
  return null;
}

function describeTestBlockReason(reason) {
  return Object.prototype.hasOwnProperty.call(BLOCK_REASON_TEXT, reason)
    ? BLOCK_REASON_TEXT[reason]
    : "unavailable";
}

function isCatalogRow(row) {
  return !!row && typeof row === "object"
    && typeof row.group === "string" && row.group
    && typeof row.id === "string" && row.id
    && typeof row.label === "string" && row.label;
}

function buildCompanionTestMenuItem({
  catalog,
  gateReason = null,
  play,
  runAfterMenuClose = (fn) => fn(),
  logWarn = (msg) => console.warn(msg),
} = {}) {
  const rows = Array.isArray(catalog) ? catalog.filter(isCatalogRow) : [];
  if (rows.length === 0) {
    return { label: TEST_MENU_LABEL, submenu: [{ label: "No test animations available", enabled: false }] };
  }
  const suffix = gateReason ? ` (${describeTestBlockReason(gateReason)})` : "";
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.group)) groups.set(row.group, []);
    const opts = typeof row.variant === "string" && row.variant ? { variant: row.variant } : {};
    groups.get(row.group).push({
      label: `${row.label}${suffix}`,
      enabled: !gateReason,
      click: () => runAfterMenuClose(() => {
        try {
          const result = typeof play === "function" ? play(row.id, opts) : null;
          if (result && result.ok === false) {
            logWarn(`Clawd: test animation ${row.id} refused (${describeTestBlockReason(result.reason)})`);
          }
        } catch (err) {
          logWarn(`Clawd: test animation ${row.id} failed: ${err && err.message}`);
        }
      }),
    });
  }
  return {
    label: TEST_MENU_LABEL,
    submenu: Array.from(groups, ([group, items]) => ({ label: group, submenu: items })),
  };
}

module.exports = {
  TEST_MENU_LABEL,
  shouldShowCompanionTestMenu,
  resolveCompanionTestGate,
  describeTestBlockReason,
  buildCompanionTestMenuItem,
};
