// Run the gateway in the background and start it at login, so editors (VS Code,
// JetBrains, the desktop app) can use it without a terminal open.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ccpager.js');
const NODE = process.execPath;
const LABEL = 'com.ccpager.gateway';

const ccEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('CCPAGER_')));
const run = (cmd, args) => { try { execFileSync(cmd, args, { stdio: 'ignore' }); return true; } catch { return false; } };

/** Returns the running gateway's health info ({ pid, startedAt, config, ... }), or null. */
export async function health(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/ccpager/health`, { signal: AbortSignal.timeout(800) });
    if (!r.ok) return null;
    const t = await r.text();
    try { return JSON.parse(t); } catch { return { ok: true, legacy: true }; } // pre-0.2 gateways answer plain "ok"
  } catch { return null; }
}
export const isRunning = async (port) => !!(await health(port));

/**
 * Stop whatever ccpager is holding the port (an old service, a detached process, or a
 * forgotten `ccpager start`), so a reinstall always runs the new code and settings.
 */
export async function stopRunning(config) {
  const h = await health(config.port);
  if (!h) return false;
  const pids = new Set();
  if (h.pid) pids.add(h.pid);
  try { pids.add(+fs.readFileSync(path.join(config.dataDir, 'ccpager.pid'), 'utf8')); } catch {}
  for (const pid of pids) { try { process.kill(pid); } catch {} }
  const end = Date.now() + 4000;
  while (Date.now() < end && (await isRunning(config.port))) await new Promise((r) => setTimeout(r, 150));
  return true;
}

/** Start a detached gateway now (no autostart). */
export function startDetached(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const log = fs.openSync(path.join(dataDir, 'ccpager.out'), 'a');
  const child = spawn(NODE, [BIN, 'start'], { detached: true, stdio: ['ignore', log, log], windowsHide: true, env: process.env });
  child.unref();
  fs.writeFileSync(path.join(dataDir, 'ccpager.pid'), String(child.pid));
  return child.pid;
}

export function stopDetached(dataDir) {
  const f = path.join(dataDir, 'ccpager.pid');
  try { process.kill(+fs.readFileSync(f, 'utf8')); } catch {}
  try { fs.unlinkSync(f); } catch {}
}

function macPlist(dataDir) {
  const env = Object.entries(ccEnv()).map(([k, v]) => `<key>${k}</key><string>${v}</string>`).join('');
  const log = path.join(dataDir, 'ccpager.out');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${NODE}</string><string>${BIN}</string><string>start</string></array>
  <key>EnvironmentVariables</key><dict>${env}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict></plist>
`;
}

function systemdUnit() {
  const env = Object.entries(ccEnv()).map(([k, v]) => `Environment=${k}=${v}`).join('\n');
  return `[Unit]
Description=ccpager context-paging gateway for Claude Code

[Service]
ExecStart="${NODE}" "${BIN}" start
Restart=always
RestartSec=2
TimeoutStopSec=40
${env}

[Install]
WantedBy=default.target
`;
}

function paths() {
  const home = os.homedir();
  return {
    mac: path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
    linux: path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd', 'user', 'ccpager.service'),
    win: path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'ccpager.vbs'),
  };
}

/**
 * Install autostart for this OS and start the gateway now.
 * Returns { method, file } describing what was set up.
 */
export async function installService(config) {
  const p = paths();
  uninstallServiceFiles(p, { keepFiles: true });
  await stopRunning(config);
  const still = await health(config.port);
  if (still && !still.pid) {
    throw new Error(`An older ccpager is still running on port ${config.port} and couldn't be stopped automatically.
  Stop it, then run this again: ${process.platform === 'win32'
    ? 'Task Manager → Details → end the node.exe running ccpager (or restart Windows).'
    : `kill the node process running ccpager (e.g. \`pkill -f "ccpager.js start"\`), or restart.`}`);
  }
  if (process.platform === 'darwin') {
    fs.mkdirSync(path.dirname(p.mac), { recursive: true });
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(p.mac, macPlist(config.dataDir));
    const uid = process.getuid();
    run('launchctl', ['bootout', `gui/${uid}/${LABEL}`]);
    if (!run('launchctl', ['bootstrap', `gui/${uid}`, p.mac])) run('launchctl', ['load', '-w', p.mac]);
    return { method: 'launchd agent', file: p.mac };
  }
  if (process.platform === 'win32') {
    fs.mkdirSync(path.dirname(p.win), { recursive: true });
    // A .vbs in the Startup folder runs node with no console window at login.
    const env = Object.entries(ccEnv()).map(([k, v]) => `sh.Environment("PROCESS")("${k}") = "${v}"\r\n`).join('');
    fs.writeFileSync(p.win, `Set sh = CreateObject("WScript.Shell")\r\n${env}sh.Run """${NODE}"" ""${BIN}"" start", 0, False\r\n`);
    startDetached(config.dataDir);
    return { method: 'Startup folder script', file: p.win };
  }
  // Linux and others: systemd user service, falling back to a detached process.
  fs.mkdirSync(path.dirname(p.linux), { recursive: true });
  fs.writeFileSync(p.linux, systemdUnit());
  if (run('systemctl', ['--user', 'daemon-reload']) && run('systemctl', ['--user', 'enable', 'ccpager.service'])
      && run('systemctl', ['--user', 'restart', 'ccpager.service'])) {
    return { method: 'systemd user service', file: p.linux };
  }
  try { fs.unlinkSync(p.linux); } catch {}
  startDetached(config.dataDir);
  return { method: 'background process (no systemd; will not restart after reboot)', file: null };
}

function uninstallServiceFiles(p, { keepFiles = false } = {}) {
  if (process.platform === 'darwin') {
    if (fs.existsSync(p.mac)) run('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`]) || run('launchctl', ['unload', '-w', p.mac]);
    if (!keepFiles) try { fs.unlinkSync(p.mac); } catch {}
  } else if (process.platform === 'win32') {
    if (!keepFiles) try { fs.unlinkSync(p.win); } catch {}
  } else if (fs.existsSync(p.linux)) {
    run('systemctl', ['--user', 'stop', 'ccpager.service']);
    if (!keepFiles) { run('systemctl', ['--user', 'disable', 'ccpager.service']); try { fs.unlinkSync(p.linux); } catch {} run('systemctl', ['--user', 'daemon-reload']); }
  }
}

export async function uninstallService(config) {
  uninstallServiceFiles(paths());
  stopDetached(config.dataDir);
  await stopRunning(config);
}

export async function waitUntilUp(port, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await isRunning(port)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** Which autostart mechanism (if any) is installed for this user. */
export function installedService() {
  const p = paths();
  if (process.platform === 'darwin') return fs.existsSync(p.mac) ? 'launchd agent' : null;
  if (process.platform === 'win32') return fs.existsSync(p.win) ? 'Startup folder script' : null;
  return fs.existsSync(p.linux) ? 'systemd user service' : null;
}
