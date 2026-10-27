// Runtime on/off switches, stored in ~/.ccpager/state.json.
// The CLI writes the file; the running gateway re-reads it when it changes, so
// toggling takes effect on the next request with no restart and no editor reload.
import fs from 'node:fs';
import path from 'node:path';

export const FEATURES = { paging: 'paging', cache: 'cacheTtl', routing: 'routing', protect: 'protect' };

export const statePath = (dataDir) => path.join(dataDir, 'state.json');

export function readState(dataDir) {
  try { return JSON.parse(fs.readFileSync(statePath(dataDir), 'utf8')); } catch { return {}; }
}

export function writeState(dataDir, patch) {
  const next = { ...readState(dataDir), ...patch };
  if ('keepTurns' in patch || 'pageStep' in patch) next.units = 'steps';
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = statePath(dataDir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, statePath(dataDir)); // atomic, so the gateway never reads half a file
  return next;
}

/**
 * Settings the GUI and `ccpager set` can change. All except `port` apply live on the
 * next request; `port` needs a gateway restart (the CLI handles that).
 */
export const SETTINGS = {
  keepTurns:  { key: 'keepRecentTurns', type: 'int', min: 1, max: 200, help: 'recent steps (tool rounds) always sent in full' },
  pageStep:   { key: 'pageStep', type: 'int', min: 1, max: 100, help: 'steps between possible cutoff moves' },
  pagingMode: { key: 'pagingMode', type: 'enum', values: ['smart', 'always'], help: 'smart: page only when the cache is cold or it pays off; always: every step boundary' },
  minChars:   { key: 'minPageChars', type: 'int', min: 0, max: 1_000_000, help: 'tool outputs smaller than this are never paged' },
  largeContext: { key: 'largeContextTokens', type: 'int', min: 0, max: 2_000_000, help: 'above this many prompt tokens, page even on a warm cache to delay auto-compaction (0 = off)' },
  smallModel: { key: 'routeSmallModel', type: 'string', pattern: /^[a-z0-9.\-]+$/, help: 'model that light turns are routed to' },
  protectModel: { key: 'protectModel', type: 'string', pattern: /^[a-z0-9.\-]+$/, help: 'model new sessions start on while a usage limit is under pressure' },
  protectAt:  { key: 'protectAt', type: 'int', min: 1, max: 100, help: 'percent of a usage window at which protection kicks in regardless of pace' },
  port:       { key: 'port', type: 'int', min: 1024, max: 65535, help: 'local port the gateway listens on (restarts it)' },
};

export function parseSetting(name, value) {
  const s = SETTINGS[name];
  if (!s) throw new Error(`Unknown setting "${name}". Settings: ${Object.keys(SETTINGS).join(', ')}`);
  if (s.type === 'int') {
    const n = Number(value);
    if (!Number.isInteger(n) || n < s.min || n > s.max) throw new Error(`${name} must be a whole number from ${s.min} to ${s.max}`);
    return n;
  }
  if (s.type === 'enum') {
    if (!s.values.includes(String(value))) throw new Error(`${name} must be one of: ${s.values.join(', ')}`);
    return String(value);
  }
  if (!s.pattern.test(String(value))) throw new Error(`${name} has an invalid value`);
  return String(value);
}

/** Combine startup config with the saved switches and settings. Saved values win. */
export function effectiveConfig(config, state) {
  const c = { ...config, enabled: state.enabled !== false };
  if (typeof state.paging === 'boolean') c.paging = state.paging;
  if (typeof state.routing === 'boolean') c.routing = state.routing;
  if (typeof state.protect === 'boolean') c.protect = state.protect;
  for (const [name, s] of Object.entries(SETTINGS)) {
    if (name === 'port' || state[name] === undefined) continue;
    // Before 0.4 these counted typed prompts, not steps; old saved values would page far too aggressively.
    if ((name === 'keepTurns' || name === 'pageStep') && state.units !== 'steps') continue;
    try { c[s.key] = parseSetting(name, state[name]); } catch {} // ignore hand-edited junk
  }
  if (state.cache === false) c.cacheTtl = 'off';
  else if (state.cache === true && c.cacheTtl === 'off') c.cacheTtl = '1h';
  return c;
}

/** Cheap per-request lookup: only re-reads the file when its mtime changes. */
export function liveConfig(config) {
  const file = statePath(config.dataDir);
  let mtime = -1, cached = effectiveConfig(config, {});
  return () => {
    let m = 0;
    try { m = fs.statSync(file).mtimeMs; } catch {}
    if (m !== mtime) { mtime = m; cached = effectiveConfig(config, m ? readState(config.dataDir) : {}); }
    return cached;
  };
}
