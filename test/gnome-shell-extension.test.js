"use strict";

// Runs the real extension inside a real, headless GNOME Shell on a private
// session bus. Slow, and needs a desktop's worth of packages, so it is opt-in:
//   CLAWD_GNOME_SHELL_TEST=1 node --test test/gnome-shell-extension.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const UUID = "clawd-pointer@clawd-on-desk";
const SOURCE = path.join(__dirname, "..", "extensions", "gnome-shell", UUID);
const VERSION = JSON.parse(fs.readFileSync(path.join(SOURCE, "metadata.json"), "utf8"))["clawd-version"];

const SHELL_LIMIT_S = 60; // the shell ends by itself even if the script hangs
const SESSION_LIMIT_S = 75;
const TEST_TIMEOUT_MS = 100000;

function onPath(name) {
  return String(process.env.PATH || "").split(path.delimiter)
    .some((dir) => dir && fs.existsSync(path.join(dir, name)));
}

function skipReason() {
  if (process.env.CLAWD_GNOME_SHELL_TEST !== "1") return "set CLAWD_GNOME_SHELL_TEST=1 to run";
  for (const tool of ["gnome-shell", "gnome-extensions", "dbus-run-session", "timeout"]) {
    if (!onPath(tool)) return `needs ${tool}`;
  }
  return false;
}

// Reads the socket for a moment and keeps every line it got.
const CLIENT = `
const fs = require("node:fs");
const net = require("node:net");
const [socketPath, outFile] = process.argv.slice(2);
let text = "";
const socket = net.connect(socketPath);
socket.on("data", (chunk) => { text += chunk; });
socket.on("error", (err) => { text += "client error: " + err.message + "\\n"; });
setTimeout(() => {
  fs.writeFileSync(outFile, text);
  process.exit(0);
}, 1500);
`;

const SESSION = `
unset WAYLAND_DISPLAY DISPLAY XDG_SESSION_TYPE XDG_SESSION_ID
mkdir -p "$XDG_DATA_HOME/gnome-shell/extensions"
cp -r "$CLAWD_SOURCE" "$XDG_DATA_HOME/gnome-shell/extensions/"
timeout -k 5 ${SHELL_LIMIT_S} gnome-shell --headless --wayland --virtual-monitor 1280x720 --no-x11 \\
  > "$CLAWD_ROOT/shell.log" 2>&1 &
shell=$!
sleep 13
# Listing it in enabled-extensions before the shell starts does not stick.
gnome-extensions enable "$CLAWD_UUID" > "$CLAWD_ROOT/enable.log" 2>&1
sleep 2
gnome-extensions info "$CLAWD_UUID" > "$CLAWD_ROOT/info" 2>&1
stat -c %a "$XDG_RUNTIME_DIR/clawd-pointer.sock" > "$CLAWD_ROOT/mode" 2>&1
"$CLAWD_NODE" "$CLAWD_ROOT/client.js" "$XDG_RUNTIME_DIR/clawd-pointer.sock" "$CLAWD_ROOT/lines"
kill "$shell"
wait "$shell"
`;

test("the extension runs in a real GNOME Shell and streams the pointer", {
  skip: skipReason(),
  timeout: TEST_TIMEOUT_MS,
}, (t) => {
  // Short: the socket's path has to fit a unix address.
  const root = path.join(os.tmpdir(), `cgs-${process.pid}`);
  fs.rmSync(root, { recursive: true, force: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, "run");
  fs.mkdirSync(root);
  fs.mkdirSync(runtimeDir, { mode: 0o700 });
  fs.writeFileSync(path.join(root, "client.js"), CLIENT);
  fs.writeFileSync(path.join(root, "session.sh"), SESSION);

  const env = {
    ...process.env,
    LC_ALL: "C",
    HOME: path.join(root, "home"),
    XDG_RUNTIME_DIR: runtimeDir,
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    CLAWD_ROOT: root,
    CLAWD_SOURCE: SOURCE,
    CLAWD_UUID: UUID,
    CLAWD_NODE: process.execPath,
  };
  delete env.DBUS_SESSION_BUS_ADDRESS;
  for (const dir of [env.HOME, env.XDG_DATA_HOME, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const session = spawnSync("timeout", [
    "-k", "5", String(SESSION_LIMIT_S),
    "dbus-run-session", "--", "sh", path.join(root, "session.sh"),
  ], { env, encoding: "utf8" });
  assert.ifError(session.error);

  const read = (name) => {
    const file = path.join(root, name);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  };
  const shellLog = read("shell.log");
  const context = `\n--- enable\n${read("enable.log")}\n--- shell log\n${shellLog.slice(-3000)}`;

  assert.match(read("info"), /State:\s+ACTIVE/, read("info") + context);
  assert.equal(read("mode").trim(), "600", context);

  const lines = read("lines").split("\n").filter(Boolean);
  // New clients first hear which extension they talk to.
  assert.equal(lines[0], `v ${VERSION}`, `${lines.join("|")}${context}`);
  const positions = lines.slice(1);
  assert.ok(positions.length > 0, `no position line after the version${context}`);
  for (const line of positions) assert.match(line, /^\d+ \d+ [01]$/, context);

  const logLines = shellLog.split("\n");
  const errors = logLines.flatMap((line, i) => (
    /JS ERROR/.test(line) ? [logLines.slice(i, i + 6).join("\n")] : []
  ));
  assert.deepEqual(errors.filter((error) => /clawd/i.test(error)), []);
});
