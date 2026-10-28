#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { createServer } from '../src/server.js';
import { Stats } from '../src/stats.js';
import { installService, uninstallService, installedService, isRunning, health, waitUntilUp, stopDetached, stopRunning, startDetached } from '../src/service.js';
import { createLogger, logPath } from '../src/log.js';
import { FEATURES, SETTINGS as TUNABLES, parseSetting, readState, writeState, effectiveConfig } from '../src/state.js';
import { summarizeLimits, formatLimits, fmtClock, fmtDur } from '../src/limits.js';
import { handleHook, installHook, hookInstalled } from '../src/hook.js';
import { VERSION, checkForUpdate, readUpdateCache, parseRelease, installKind, downloadDeb, applyUpdate, RELEASES_URL } from '../src/update.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GLOBAL_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const PIDFILE = path.join(config.dataDir, 'ccpager.pid');
const url = (port = config.port) => `http://127.0.0.1:${port}`;
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return undefined; args.splice(i, 1); return true; };
const opt = (name) => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const JSON_OUT = flag('--json');
const fail = (msg) => { if (JSON_OUT) console.log(JSON.stringify({ ok: false, error: msg })); else console.error('✗ ' + msg); process.exit(1); };

// ---------- Claude Code targets ----------
// Every Claude Code surface (VS Code, JetBrains, desktop app, CLI) reads ~/.claude/settings.json.
// A project's .claude/settings.local.json applies to that folder only (and isn't committed to git).
const targetFile = (dir) => (dir ? path.join(dir, '.claude', 'settings.local.json') : GLOBAL_SETTINGS);

function readSettings(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  try { return JSON.parse(raw); } catch {
    fail(`${file} isn't valid JSON. Fix it first; ccpager won't overwrite it.`); // never wipe the user's config
  }
}
function writeSettings(file, s) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!Object.keys(s).length && path.basename(file) === 'settings.local.json') { try { fs.unlinkSync(file); } catch {} return; }
  fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
}
const pointedAt = (file) => readSettings(file).env?.ANTHROPIC_BASE_URL;
const isOurs = (u) => typeof u === 'string' && /^http:\/\/127\.0\.0\.1:\d+$/.test(u);

function point(file, port = config.port) {
  const s = readSettings(file);
  s.env = { ...(s.env || {}), ANTHROPIC_BASE_URL: url(port) };
  writeSettings(file, s);
}
function unpoint(file) {
  const s = readSettings(file);
  if (isOurs(s.env?.ANTHROPIC_BASE_URL)) delete s.env.ANTHROPIC_BASE_URL;
  if (s.env && !Object.keys(s.env).length) delete s.env;
  writeSettings(file, s);
}
function projects() { return (readState(config.dataDir).projects || []).filter((d) => typeof d === 'string'); }
function setProjects(list) { writeState(config.dataDir, { projects: [...new Set(list)] }); }
const allTargets = () => [GLOBAL_SETTINGS, ...projects().map(targetFile)];

function resolveProject(dir) {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) fail(`${abs} isn't a folder`);
  return abs;
}

// ---------- helpers ----------
function listen(log) {
  return new Promise((resolve, reject) => {
    const server = createServer(config, log);
    server.once('error', reject);
    server.listen(config.port, '127.0.0.1', () => resolve(server));
  });
}

const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k` : String(Math.round(n)));
const fmtUsd = (n) => (n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(n >= 0.01 ? 2 : 3)}` : '$0');
function sumDays(byDay, n) {
  const cutoff = new Date(Date.now() - (n - 1) * 864e5).toISOString().slice(0, 10);
  const b = { requests: 0, tokensSaved: 0, promptTokens: 0, cost: 0, savedLow: 0, savedHigh: 0, rewriteCost: 0 };
  for (const [day, v] of Object.entries(byDay || {})) if (day >= cutoff) for (const k in b) b[k] += v[k] || 0;
  return b;
}
const reduced = (b) => (b.tokensSaved + b.promptTokens ? b.tokensSaved / (b.tokensSaved + b.promptTokens) : 0);
function statsSummary(d) {
  if (!d) return null;
  const u = d.usage, totalIn = u.input + u.cacheRead + u.cacheWrite;
  const period = (b) => { const net = b.savedLow - (b.rewriteCost || 0); return { ...b, rewriteCost: b.rewriteCost || 0, net, reduced: reduced(b), headroom: b.cost ? net / b.cost : null }; };
  return {
    since: d.since, today: period(sumDays(d.byDay, 1)), week: period(sumDays(d.byDay, 7)), all: period(d.totals || sumDays(d.byDay, 9999)),
    cacheHitRate: totalIn ? u.cacheRead / totalIn : 0, busiestHour: d.byHour.indexOf(Math.max(...d.byHour)),
    pagedBlocks: d.pagedBlocks, freshBlocks: d.freshBlocks || 0, freshChars: d.freshChars || 0, routed: d.routed, protected: d.protected || 0, byModel: d.byModel || {}, requests: d.requests,
    cacheWrite1h: u.cacheWrite1h || 0, cacheWrite5m: u.cacheWrite5m || 0,
  };
}

function printStats(d) {
  if (!d || !d.requests) return console.log('No stats yet. Send a message in Claude Code (VS Code or CLI) while ccpager is running.');
  const s = statsSummary(d);
  const cols = [['today', s.today], ['7 days', s.week], ['all time', s.all]];
  const row = (label, f) => `  ${label.padEnd(20)}${cols.map(([, b]) => f(b).padStart(15)).join('')}`;
  const models = Object.entries(s.byModel).sort((a, b) => b[1].requests - a[1].requests).slice(0, 4);
  console.log(`ccpager stats (since ${d.since.slice(0, 10)})

  ${''.padEnd(20)}${cols.map(([n]) => n.padStart(15)).join('')}
${row('requests', (b) => String(b.requests))}
${row('tokens kept out', (b) => `~${fmtTok(b.tokensSaved)}`)}
${row('prompt reduced by', (b) => (b.tokensSaved + b.promptTokens ? `${Math.round(100 * b.reduced)}%` : '–'))}
${row('value saved', (b) => fmtUsd(b.savedLow))}
${row('  − cache rewrites', (b) => fmtUsd(b.rewriteCost))}
${row('net value saved', (b) => (b.net < 0 ? '−' : '') + fmtUsd(Math.abs(b.net)))}
${row('  (if uncached)', (b) => `up to ${fmtUsd(b.savedHigh)}`)}
${row('API cost of the rest', (b) => fmtUsd(b.cost))}
${row('extra work in limit', (b) => (b.headroom == null ? '–' : `${b.headroom < 0 ? '−' : '+'}${Math.abs(100 * b.headroom).toFixed(1)}%`))}
${models.length ? `\n  by model\n${models.map(([m, b]) => `    ${m.padEnd(22)} ${String(b.requests).padStart(5)} req   ~${fmtTok(b.tokensSaved)} kept out   ${fmtUsd(b.savedLow)}–${fmtUsd(b.savedHigh)} saved`).join('\n')}\n` : ''}
  cache hit rate      ${(100 * s.cacheHitRate).toFixed(1)}%      busiest hour ${s.busiestHour}:00      blocks paged ${s.pagedBlocks}${s.freshBlocks ? `      fresh results tidied ${s.freshBlocks} (~${Math.round(s.freshChars / 4 / 1000)}k tok)` : ''}${s.routed ? `      routed ${s.routed}` : ''}${ttlLine(s)}

  Money is API-equivalent value at list prices. On a Pro/Max plan you don't pay it, but
  it is the best guide to your usage limit: cache reads count almost nothing against the
  limit, cache writes count like fresh input. "Value saved" prices removed tokens as
  cache reads (what they'd mostly have been). "Cache rewrites" is the extra cost of
  moving the cutoff while the cache was warm; smart mode only does that when it pays.
  "If uncached" is the ceiling when the cache would have expired anyway. "Extra work in
  limit" is net value as a share of what the requests cost: how many more requests fit.
  Token counts are estimated at ~4 characters per token.`);
  if (s.week.net < 0 && s.week.requests >= 50) console.log(`
  ⚠ Net value this week is negative: cache rewrites cost more than paging saved. That
    happens when the cutoff moves on a warm cache. Check \`ccpager get\`: largeContext
    should be 0 unless you want to delay auto-compaction at a cost, and pagingMode smart.`);
}
const ttlLine = (s) => {
  const w = s.cacheWrite1h + s.cacheWrite5m;
  return w ? `\n  cache writes        ${Math.round(100 * s.cacheWrite1h / w)}% on the 1-hour TTL, ${Math.round(100 * s.cacheWrite5m / w)}% on 5-minute` : '';
};

async function statusObject() {
  const h = await health(config.port);
  const st = readState(config.dataDir);
  const eff = effectiveConfig(config, st);
  const mine = url();
  const cachedRel = readUpdateCache(config.dataDir)?.release;
  const update = eff.updateCheck && cachedRel ? { ...parseRelease(cachedRel), kind: installKind() } : null;
  return {
    ok: true,
    version: VERSION,
    install: installKind(),
    hook: hookInstalled(),
    // The gateway reports the version it loaded; after an update it differs until restarted.
    restartNeeded: !!h && !!h.version && h.version !== VERSION,
    update: update && update.newer ? update : null,
    gateway: { running: !!h, version: h?.version ?? null, legacy: !!h?.legacy, pid: h?.pid ?? null, startedAt: h?.startedAt ?? null, url: mine, port: config.port },
    service: installedService(),
    targets: {
      global: { file: GLOBAL_SETTINGS, pointed: pointedAt(GLOBAL_SETTINGS) === mine },
      projects: projects().map((dir) => ({ dir, file: targetFile(dir), pointed: pointedAt(targetFile(dir)) === mine })),
    },
    mode: { enabled: eff.enabled, paging: eff.paging, fresh: eff.fresh, cache: eff.cacheTtl !== 'off', routing: eff.routing, protect: eff.protect, updates: eff.updateCheck },
    protect: h?.protect || { active: false, reason: null },
    settings: Object.fromEntries(Object.entries(TUNABLES).map(([n, s]) => [n, eff[s.key]])),
    settingsHelp: Object.fromEntries(Object.entries(TUNABLES).map(([n, s]) => [n, s.help])),
    logFile: logPath(config.dataDir),
    stats: statsSummary(Stats.read(config.dataDir)),
    limits: summarizeLimits(Stats.read(config.dataDir)?.limits),
  };
}
const usageLine = (lim) => {
  if (!lim) return 'not seen yet';
  return lim.windows.filter((w) => w.used != null).map((w) => `${w.label.toLowerCase()} ${Math.round(100 * w.used)}%` +
    (w.runOutAt && w.runsOutBeforeReset ? ` (runs out ${fmtClock(w.runOutAt)} at this pace ⚠)` : w.resetIn != null && !w.expired ? ` (resets in ${fmtDur(w.resetIn)})` : '')).join(' · ')
    || 'not seen yet';
};

/** Make sure a gateway is running (service if installed, else a background process). */
async function ensureRunning() {
  if (await isRunning(config.port)) return true;
  if (installedService()) await installService(config); else startDetached(config.dataDir);
  return waitUntilUp(config.port);
}

const modeLine = (eff) => (eff.enabled
  ? `ON  paging ${eff.paging ? 'on' : 'off'} · fresh ${eff.fresh ? 'on' : 'off'} · cache ${eff.cacheTtl === 'off' ? 'off' : eff.cacheTtl} · routing ${eff.routing ? 'on' : 'off'} · protect ${eff.protect ? 'on' : 'off'} · updates ${eff.updateCheck ? 'on' : 'off'}`
  : 'OFF: pass-through, requests forwarded unchanged');

// ---------- commands ----------
const [cmd = 'help', ...rest] = args;

switch (cmd) {
  case 'start': {
    const log = createLogger(config.dataDir, { echo: !!process.stdout.isTTY });
    let server;
    try { server = await listen(log); } catch (e) {
      if (e.code === 'EADDRINUSE' && await isRunning(config.port)) { console.log(`ccpager is already running on ${url()}`); process.exit(0); }
      throw e;
    }
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(PIDFILE, String(process.pid));
    let stopping = false;
    const cleanup = async () => { // stop listening at once, but let replies in flight finish before exiting
      if (stopping) return; stopping = true;
      try { if (fs.readFileSync(PIDFILE, 'utf8') === String(process.pid)) fs.unlinkSync(PIDFILE); } catch {}
      if (server.inflight) log.log(`gateway stopping; waiting for ${server.inflight} reply(ies) in flight`);
      await server.drain(30_000);
      log.log('gateway stopped');
      process.exit(0);
    };
    process.on('SIGINT', cleanup); process.on('SIGTERM', cleanup);
    const eff = effectiveConfig(config, readState(config.dataDir));
    log.log(`gateway started pid=${process.pid} port=${config.port} upstream=${config.upstream} ${modeLine(eff)}`);
    if (process.stdout.isTTY) console.log(`✓ ccpager listening on ${url()} → ${config.upstream}\n  ${modeLine(eff)}\n  Log: ${log.file}`);
    break;
  }
  case 'claude': { // start the gateway and run claude through it in one go
    const server = await listen(createLogger(config.dataDir, { echo: false }));
    const child = spawn('claude', rest, { stdio: 'inherit', env: { ...process.env, ANTHROPIC_BASE_URL: url() } });
    child.on('exit', (code) => { server.close(); server.stats.flush(); process.exit(code ?? 0); });
    child.on('error', (e) => { console.error('Could not run `claude`:', e.message); process.exit(1); });
    break;
  }
  case 'vscode':   // VS Code, JetBrains, desktop app and CLI all read ~/.claude/settings.json
  case 'install': {
    let method, file;
    try { ({ method, file } = await installService(config)); } catch (e) { fail(e.message); }
    if (!(await waitUntilUp(config.port))) fail(`The gateway didn't come up on ${url()}. Check ${logPath(config.dataDir)}. Claude Code settings were NOT changed.`);
    point(GLOBAL_SETTINGS);
    if (JSON_OUT) { console.log(JSON.stringify({ ok: true, method, file })); break; }
    console.log(`✓ Gateway running on ${url()} via ${method}${file ? `\n  ${file}` : ''}
✓ Claude Code pointed at it in ${GLOBAL_SETTINGS}

Next: reload VS Code (Command Palette → "Developer: Reload Window") or open a new
Claude Code panel. The CLI and desktop app pick it up on their next start.
Check anytime with: ccpager status     Undo with: ccpager uninstall`);
    break;
  }
  case 'uninstall': {
    for (const f of allTargets()) unpoint(f);   // settings first, so Claude Code never points at a dead port
    setProjects([]);
    await uninstallService(config);
    if (JSON_OUT) { console.log(JSON.stringify({ ok: true })); break; }
    console.log('✓ ccpager removed from startup and stopped; Claude Code talks to Anthropic directly again.\n  Reload VS Code to apply.');
    break;
  }
  case 'service': { // background service only, without touching Claude Code settings
    const sub = rest[0];
    if (sub === 'install' || sub === 'restart') {
      let r; try { r = await installService(config); } catch (e) { fail(e.message); }
      if (!(await waitUntilUp(config.port))) fail(`The gateway didn't come up on ${url()}. Check ${logPath(config.dataDir)}.`);
      JSON_OUT ? console.log(JSON.stringify({ ok: true, ...r })) : console.log(`✓ Gateway running on ${url()} via ${r.method}`);
    } else if (sub === 'remove') {
      const pointed = allTargets().filter((f) => pointedAt(f) === url());
      if (pointed.length && !rest.includes('--force')) fail(`Claude Code is still pointed at ccpager (${pointed.join(', ')}). Turn those off first, or use \`ccpager uninstall\`.`);
      await uninstallService(config);
      JSON_OUT ? console.log(JSON.stringify({ ok: true })) : console.log('✓ Background service removed and stopped.');
    } else fail('Usage: ccpager service install|restart|remove');
    break;
  }
  case 'status': {
    const s = await statusObject();
    if (JSON_OUT) { console.log(JSON.stringify(s)); break; }
    const g = s.gateway;
    const eff = effectiveConfig(config, readState(config.dataDir));
    const anyPointed = s.targets.global.pointed || s.targets.projects.some((p) => p.pointed);
    console.log(`gateway   ${g.running ? `✓ running on ${g.url}${g.pid ? ` (pid ${g.pid}, since ${g.startedAt})` : ''}` : '✗ not running'}${s.service ? `  [${s.service}]` : ''}
claude    ${s.targets.global.pointed ? `✓ all Claude Code apps use ccpager (${GLOBAL_SETTINGS})` : '– not routed globally'}${s.targets.projects.map((p) => `\n          ${p.pointed ? '✓' : '✗'} project ${p.dir}`).join('')}
mode      ${modeLine(eff)}
settings  ${Object.entries(s.settings).map(([k, v]) => `${k}=${v}`).join(' ')}
usage     ${usageLine(s.limits)}
hook      ${s.hook ? 'installed: noisy Bash commands run in their quiet form' : 'not installed: run `ccpager hook install` to trim Bash output at the source'}
version   ${s.version} (${s.install})${s.restartNeeded ? ` · gateway is running ${s.gateway.version}: run \`ccpager service restart\`` : ''}${s.update ? ` · ${s.update.latest} available: run \`ccpager update\`` : ''}
protect   ${!s.mode.protect ? 'off' : s.protect.active ? `ACTIVE: ${s.protect.reason}; new sessions start on ${s.settings.protectModel}` : `armed (kicks in when a window would run out before its reset, or passes ${s.settings.protectAt}%)`}
requests  ${s.stats?.requests ?? 0} so far
log       ${s.logFile}${fs.existsSync(s.logFile) ? '' : ' (not created yet)'}`);
    if (g.legacy) console.log('\n⚠ An older ccpager is running. Run `ccpager install` to replace it.');
    if (anyPointed && !g.running) console.log(`\n⚠ Claude Code is pointed at ccpager but it isn't running, so requests will fail.\n  Fix: ccpager install   (or ccpager disable to go direct)`);
    process.exit(anyPointed && !g.running ? 1 : 0);
  }
  case 'stop': {
    stopDetached(config.dataDir);
    await stopRunning(config);
    console.log(allTargets().some((f) => pointedAt(f) === url())
      ? '✓ Stopped. Note: Claude Code still points at ccpager; run `ccpager disable` or it will fail.\n  (If installed as a service it will restart; use `ccpager uninstall` to remove it.)'
      : '✓ Stopped.');
    break;
  }
  case 'on':
  case 'off': {
    const want = cmd === 'on';
    const feature = rest[0];
    if (feature && !FEATURES[feature]) fail(`Unknown feature "${feature}". Use one of: ${Object.keys(FEATURES).join(', ')}`);
    const st = writeState(config.dataDir, feature ? { [feature]: want, ...(want ? { enabled: true } : {}) } : { enabled: want });
    const eff = effectiveConfig(config, st);
    if (JSON_OUT) { console.log(JSON.stringify({ ok: true })); break; }
    console.log(eff.enabled ? `✓ ccpager ${modeLine(eff)}` : '✓ ccpager OFF: requests now pass through unchanged (gateway stays in place, no reload needed)');
    console.log('  Takes effect on the next request.' + (await isRunning(config.port) ? '' : ' (Gateway isn\'t running right now; this applies when it starts.)'));
    break;
  }
  case 'set': {
    const [name, value] = rest;
    if (!name || value === undefined) fail(`Usage: ccpager set <name> <value>. Settings: ${Object.entries(TUNABLES).map(([n, s]) => `\n  ${n.padEnd(11)} ${s.help}`).join('')}`);
    let v; try { v = parseSetting(name, value); } catch (e) { fail(e.message); }
    if (name !== 'port') {
      writeState(config.dataDir, { [name]: v });
      JSON_OUT ? console.log(JSON.stringify({ ok: true })) : console.log(`✓ ${name} = ${v} (applies on the next request)`);
      break;
    }
    // Port change: start the gateway on the new port, repoint everything that used the old one, then stop the old one.
    const old = config.port;
    if (v === old) { JSON_OUT ? console.log(JSON.stringify({ ok: true })) : console.log(`port is already ${v}`); break; }
    const oldHealth = await health(old);
    const pointed = allTargets().filter((f) => pointedAt(f) === url(old));
    if (await health(v)) fail(`Port ${v} is already in use.`);
    writeState(config.dataDir, { port: v });
    config.port = v;
    if (oldHealth || installedService()) {
      try { await installService(config); } catch (e) { writeState(config.dataDir, { port: old }); fail(e.message); }
      if (!(await waitUntilUp(v))) { writeState(config.dataDir, { port: old }); config.port = old; await ensureRunning(); fail(`Gateway didn't start on port ${v}; kept ${old}.`); }
    }
    for (const f of pointed) point(f, v);
    if (oldHealth?.pid) { try { process.kill(oldHealth.pid); } catch {} }
    JSON_OUT ? console.log(JSON.stringify({ ok: true, repointed: pointed.length }))
      : console.log(`✓ port = ${v}${pointed.length ? `; repointed ${pointed.length} Claude Code setting(s). Reload VS Code to apply.` : ''}`);
    break;
  }
  case 'get': {
    const eff = effectiveConfig(config, readState(config.dataDir));
    const out = Object.fromEntries(Object.entries(TUNABLES).map(([n, s]) => [n, eff[s.key]]));
    JSON_OUT ? console.log(JSON.stringify(out)) : console.log(Object.entries(out).map(([k, v]) => `${k.padEnd(11)} ${String(v).padEnd(18)} ${TUNABLES[k].help}`).join('\n'));
    break;
  }
  case 'logs': {
    const file = logPath(config.dataDir);
    if (!fs.existsSync(file)) {
      console.log(`No log yet at ${file}.\n` + (await isRunning(config.port)
        ? 'The running gateway is an older version that doesn\'t write its own log. Run `ccpager install` to replace it.'
        : 'The gateway isn\'t running. Start it with `ccpager install`.'));
      process.exit(1);
    }
    console.log(fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-20).join('\n'));
    if (rest.includes('--no-follow')) break;
    console.log('— following; send a message in VS Code to see it here (Ctrl+C to stop) —');
    let pos = fs.statSync(file).size;
    setInterval(() => {
      let size; try { size = fs.statSync(file).size; } catch { return; }
      if (size < pos) pos = 0; // rotated
      if (size > pos) {
        const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(size - pos);
        fs.readSync(fd, buf, 0, buf.length, pos); fs.closeSync(fd); pos = size;
        process.stdout.write(buf);
      }
    }, 300);
    break;
  }
  case 'enable': {   // ccpager enable [--project DIR]
    const dir = opt('--project');
    const proj = dir ? resolveProject(dir) : null;
    if (proj) setProjects([...projects(), proj]);
    const up = await ensureRunning();
    point(targetFile(proj));
    if (JSON_OUT) { console.log(JSON.stringify({ ok: true, running: up })); break; }
    console.log(`✓ ${proj ? `Claude Code in ${proj}` : 'All Claude Code apps'} will use ${url()} (${targetFile(proj)}).` +
      (up ? '' : `\n⚠ The gateway didn't start; check ${logPath(config.dataDir)}.`) + `\n  Undo with: ccpager disable${proj ? ` --project ${proj}` : ''}`);
    break;
  }
  case 'disable': {  // ccpager disable [--project DIR]
    const dir = opt('--project');
    const proj = dir ? path.resolve(dir) : null;
    unpoint(targetFile(proj));
    if (proj) setProjects(projects().filter((p) => p !== proj));
    JSON_OUT ? console.log(JSON.stringify({ ok: true }))
      : console.log(`✓ ${proj ? `Claude Code in ${proj}` : 'Claude Code'} talks to Anthropic directly again.`);
    break;
  }
  case 'stats': {
    const d = Stats.read(config.dataDir);
    JSON_OUT ? console.log(JSON.stringify(statsSummary(d))) : printStats(d);
    break;
  }
  case 'version': console.log(JSON_OUT ? JSON.stringify({ version: VERSION, install: installKind() }) : `ccpager ${VERSION} (${installKind()} install)`); break;
  case 'update': {  // --check only looks; otherwise download/pull, install, and restart the gateway
    const st = readState(config.dataDir);
    const force = rest.includes('--force') || !rest.includes('--check');
    const check = await checkForUpdate({ dataDir: config.dataDir, force });
    if (rest.includes('--check')) {
      if (JSON_OUT) console.log(JSON.stringify(check));
      else if (check.error && !check.latest) console.log(`✗ Couldn't check for updates: ${check.error}`);
      else console.log(check.newer ? `Version ${check.latest} is available (you have ${check.current}). Run \`ccpager update\`.\n${check.url}` : `ccpager ${check.current} is the latest version.${check.error ? ` (check failed: ${check.error}; showing the last answer)` : ''}`);
      break;
    }
    if (check.error && !check.latest) fail(`Couldn't check for updates: ${check.error}`);
    if (!check.newer) { JSON_OUT ? console.log(JSON.stringify({ ok: true, updated: false, version: VERSION })) : console.log(`ccpager ${VERSION} is already the latest version.`); break; }
    const kind = installKind();
    if (kind === 'manual') fail(`ccpager ${check.latest} is available, but this copy was unpacked by hand so it can't update itself.\n  Download it from ${check.url}`);
    let file = null;
    if (kind === 'deb') {
      if (!check.deb) fail(`Release ${check.latest} has no Debian package yet: ${check.url}`);
      if (!JSON_OUT) console.log(`Downloading ${check.deb.name}…`);
      file = await downloadDeb(check, path.join(config.dataDir, 'updates'));
    }
    if (!JSON_OUT) console.log(kind === 'git' ? 'Pulling the latest code…' : 'Installing (your desktop will ask for your password)…');
    const did = applyUpdate({ kind, file, interactive: !JSON_OUT });
    let restarted = false;
    if (installedService() && await isRunning(config.port)) {
      execFileSync(process.execPath, [fileURLToPath(import.meta.url), 'service', 'restart'], { stdio: JSON_OUT ? 'pipe' : 'inherit' });
      restarted = true;
    }
    const now = execFileSync(process.execPath, [fileURLToPath(import.meta.url), 'version', '--json'], { encoding: 'utf8' });
    const to = JSON.parse(now.trim().split('\n').pop()).version;
    JSON_OUT ? console.log(JSON.stringify({ ok: true, updated: true, from: VERSION, to, did, restarted }))
      : console.log(`✓ ${did}: ccpager ${VERSION} → ${to}${restarted ? ', gateway restarted' : ''}. Reopen the settings window to use the new version.`);
    break;
  }
  case 'usage': {   // plan limits: session window, weekly cap, pace and predicted run-out
    const lim = summarizeLimits(Stats.read(config.dataDir)?.limits);
    JSON_OUT ? console.log(JSON.stringify(lim)) : console.log(formatLimits(lim));
    break;
  }
  case 'hook': {   // run: answer a Claude Code PreToolUse hook on stdin · install/--remove: edit ~/.claude/settings.json
    const sub = rest[0];
    if (sub === 'run') {
      let input = ''; for await (const c of process.stdin) input += c;
      const out = handleHook(input);
      if (out) process.stdout.write(JSON.stringify(out));
      break;
    }
    if (sub === 'install' || sub === 'remove' || rest.includes('--remove')) {
      const remove = sub === 'remove' || rest.includes('--remove');
      const bin = installKind() === 'deb' ? 'ccpager' : `"${process.execPath}" "${fileURLToPath(import.meta.url)}"`;
      const r = installHook({ remove, command: `${bin} hook run` });
      JSON_OUT ? console.log(JSON.stringify({ ok: true, ...r })) : console.log(remove ? `✓ Bash output hook removed from ${r.file}` : `✓ Bash output hook installed in ${r.file}. New Claude Code sessions run noisy commands (git, npm, pytest…) in their quiet form.`);
      break;
    }
    fail('Usage: ccpager hook install|remove|run');
  }
  case 'gui': {
    if (rest.includes('--uninstall')) {
      const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
      for (const f of [path.join(base, 'applications', 'io.github.ccpager.desktop'), path.join(base, 'icons', 'hicolor', 'scalable', 'apps', 'ccpager.svg')]) { try { fs.unlinkSync(f); } catch {} }
      JSON_OUT ? console.log(JSON.stringify({ ok: true })) : console.log('✓ Removed ccpager from your app menu.');
      break;
    }
    const gui = path.join(ROOT, 'gui', 'ccpager_gui.py');
    // Use a Python that can actually load GTK 4 + libadwaita (the system one usually; a newer
    // Python installed alongside often lacks the bindings).
    const candidates = ['/usr/bin/python3', ...['3.14', '3.13', '3.12', '3.11', '3.10'].map((v) => `/usr/bin/python${v}`), 'python3'];
    const probe = 'import gi; gi.require_version("Gtk","4.0"); gi.require_version("Adw","1"); from gi.repository import Gtk, Adw';
    const python = candidates.find((p) => { try { execFileSync(p, ['-c', probe], { stdio: 'ignore', timeout: 10000 }); return true; } catch { return false; } });
    if (!python) fail('The settings window needs Python 3 with GTK 4 + libadwaita.\n  Ubuntu/Debian: sudo apt install python3-gi gir1.2-gtk-4.0 gir1.2-adw-1\n  Fedora: sudo dnf install python3-gobject gtk4 libadwaita\n  Arch: sudo pacman -S python-gobject gtk4 libadwaita');
    const appsDir = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'applications');
    const iconDir = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'icons', 'hicolor', 'scalable', 'apps');
    const desktop = path.join(appsDir, 'io.github.ccpager.desktop'); // must match the GUI's application id
    if (rest.includes('--install')) {
      fs.mkdirSync(appsDir, { recursive: true }); fs.mkdirSync(iconDir, { recursive: true });
      fs.copyFileSync(path.join(ROOT, 'gui', 'ccpager.svg'), path.join(iconDir, 'ccpager.svg'));
      // Absolute paths: menu launchers don't get your shell's PATH (nvm etc.).
      fs.writeFileSync(desktop, `[Desktop Entry]
Type=Application
Name=ccpager
GenericName=Claude Code context gateway
Comment=Turn context paging on or off, set up Claude Code, view logs and savings
Exec=${python} "${gui}" --node "${process.execPath}"
Icon=ccpager
Terminal=false
Categories=Development;Utility;
Keywords=claude;claude code;tokens;context;vscode;
StartupNotify=true
StartupWMClass=io.github.ccpager
`);
      fs.chmodSync(desktop, 0o755);
      JSON_OUT ? console.log(JSON.stringify({ ok: true, file: desktop })) : console.log(`✓ Added ccpager to your app menu (${desktop}). Search for "ccpager".`);
      break;
    }
    const child = spawn(python, [gui, '--node', process.execPath], { stdio: 'inherit', detached: !rest.includes('--wait') });
    child.on('error', (e) => fail(`Could not start the GUI: ${e.message}`));
    if (!rest.includes('--wait')) child.unref(); else child.on('exit', (c) => process.exit(c ?? 0));
    break;
  }
  default:
    console.log(`ccpager — context paging gateway for Claude Code

  ccpager gui              open the settings window  (--install adds it to your app menu)

  ccpager vscode           set up for every Claude Code app (VS Code, JetBrains, desktop, CLI):
                           run in the background at login and point Claude Code at it (alias: install)
  ccpager uninstall        undo everything
  ccpager enable [--project DIR]   route Claude Code through ccpager (everywhere, or one project)
  ccpager disable [--project DIR]  send it straight to Anthropic again
  ccpager status           what's running, where it's routed, what's switched on   (--json)
  ccpager logs             recent requests, then follow live
  ccpager off [feature]    switch optimizations off instantly (all, or paging | fresh | cache | routing | protect | updates)
  ccpager hook install     trim noisy Bash output at the source (git, npm, pytest…) via a Claude Code hook  (--remove)
  ccpager on [feature]     switch back on
  ccpager set NAME VALUE   change a setting (saved; applies live). \`ccpager get\` lists them
  ccpager stats            tokens and money saved   (--json)
  ccpager usage            plan usage: 5-hour session, weekly cap, pace and predicted run-out   (--json)
  ccpager update           update to the latest release and restart the gateway  (--check only looks)
  ccpager version          installed version and how it was installed
  ccpager service install|restart|remove   background service only
  ccpager claude [args]    start the gateway and launch the claude CLI through it
  ccpager start | stop     run in the foreground / stop a background gateway

Settings and switches are saved in ${path.join(config.dataDir, 'state.json')}.`);
}
