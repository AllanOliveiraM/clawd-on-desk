"use strict";

// Installs the optional GNOME Shell extension from the app's own files, for the
// current user only. Runs when the user asks for it in Settings. Later app
// updates refresh an extension the user already installed.

const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const EXTENSION_UUID = "clawd-pointer@clawd-on-desk";

function parseExtensionList(output) {
  return [...String(output).matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

function readVersion(dir) {
  try {
    const metadata = JSON.parse(fs.readFileSync(path.join(dir, "metadata.json"), "utf8"));
    return Number.isInteger(metadata["clawd-version"]) ? metadata["clawd-version"] : null;
  } catch {
    return null;
  }
}

function runGsettings(args) {
  return new Promise((resolve, reject) => {
    execFile("gsettings", args, { timeout: 5000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

function createGnomePointerExtension({
  supported = false,
  sourceDir,
  dataDir = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"),
  getLoadedVersion = () => null,
  gsettings = runGsettings,
} = {}) {
  const extensionsDir = path.join(dataDir, "gnome-shell", "extensions");
  const targetDir = path.join(extensionsDir, EXTENSION_UUID);

  // The copy is finished before the old folder goes away, so a failure
  // leaves the previous install working.
  function copyFiles() {
    const staging = `${targetDir}.tmp`;
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(extensionsDir, { recursive: true });
    try {
      fs.cpSync(sourceDir, staging, { recursive: true });
      fs.rmSync(targetDir, { recursive: true, force: true });
      fs.renameSync(staging, targetDir);
    } catch (err) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw err;
    }
  }

  async function enable() {
    const enabled = parseExtensionList(await gsettings(["get", "org.gnome.shell", "enabled-extensions"]));
    if (enabled.includes(EXTENSION_UUID)) return;
    const next = [...enabled, EXTENSION_UUID].map((uuid) => `'${uuid}'`).join(", ");
    await gsettings(["set", "org.gnome.shell", "enabled-extensions", `[${next}]`]);
  }

  function getState() {
    if (!supported) return "unsupported";
    if (!fs.existsSync(targetDir)) return "missing";
    const available = readVersion(sourceDir);
    return available !== null && getLoadedVersion() === available ? "active" : "needs-login";
  }

  async function install() {
    if (!supported) return "unsupported";
    copyFiles();
    await enable();
    return getState();
  }

  function syncInstalled() {
    if (!supported || !fs.existsSync(targetDir)) return;
    if (readVersion(targetDir) === readVersion(sourceDir)) return;
    try {
      copyFiles();
    } catch (err) {
      console.warn("Clawd: pointer extension update failed:", err && err.message);
    }
  }

  return { getState, install, syncInstalled };
}

module.exports = { EXTENSION_UUID, createGnomePointerExtension, parseExtensionList };
