// Plan usage limits, read from the anthropic-ratelimit-* headers Anthropic puts on every
// Messages API response. Nothing is requested; the gateway just looks at what comes back.
//
//  * Claude subscriptions (Pro/Max) get anthropic-ratelimit-unified-<window>-utilization
//    (fraction used, 0..1+), -reset (unix seconds) and -status, for a rolling 5-hour
//    session window ("5h"), the weekly cap ("7d") and sometimes per-model weekly caps.
//  * API keys get the per-minute anthropic-ratelimit-<kind>-limit/remaining/reset headers.
//
// The gateway stores the latest values plus a short history of samples, from which the
// pace and the predicted "run out" time are derived.

const UNIFIED = /^anthropic-ratelimit-unified-(.+)-(utilization|reset|status)$/;
const API = /^anthropic-ratelimit-(requests|tokens|input-tokens|output-tokens)-(limit|remaining|reset)$/;
const HISTORY_MAX = 4000;        // samples kept (one per minute of activity at most)
const SAMPLE_MS = 60_000;

export const LABELS = {
  '5h': 'Session (5-hour window)',
  '7d': 'Weekly, all models',
  '7d_opus': 'Weekly, Opus',
  '7d_sonnet': 'Weekly, Sonnet',
  overage: 'Extra usage',
  'api:requests': 'API requests per minute',
  'api:tokens': 'API tokens per minute',
  'api:input-tokens': 'API input tokens per minute',
  'api:output-tokens': 'API output tokens per minute',
};
const ORDER = ['5h', '7d', '7d_opus', '7d_sonnet', 'overage'];

/** Length of a window from its name: "5h" → 5 hours, "7d_opus" → 7 days, api windows → 1 minute. */
export function windowMs(name) {
  const m = /^(\d+)([hd])/.exec(name);
  if (m) return +m[1] * (m[2] === 'h' ? 3600e3 : 86400e3);
  if (name.startsWith('api:')) return 60e3;
  return null;
}

function epochMs(v) {
  const n = Number(v);
  if (Number.isFinite(n)) return n > 1e12 ? n : n * 1000;
  const d = Date.parse(v);
  return Number.isFinite(d) ? d : null;
}

/**
 * Pull limit information out of response headers (a fetch Headers object or a plain
 * object). Returns null when the response carries none.
 */
export function parseLimitHeaders(headers) {
  const out = { windows: {} };
  const api = {};
  let plan = false, hasApi = false;
  const visit = (k, v) => {
    k = String(k).toLowerCase(); v = String(v);
    let m;
    if (k === 'anthropic-ratelimit-unified-status') { out.status = v; plan = true; }
    else if (k === 'anthropic-ratelimit-unified-reset') out.resetAt = epochMs(v);
    else if (k === 'anthropic-ratelimit-unified-representative-claim') out.claim = v;
    else if (k === 'anthropic-ratelimit-unified-overage-status') out.overage = v;
    else if (k === 'anthropic-ratelimit-unified-overage-disabled-reason') out.overageReason = v;
    else if (k === 'anthropic-ratelimit-unified-fallback-percentage') out.fallback = Number(v);
    else if ((m = UNIFIED.exec(k))) {
      const w = (out.windows[m[1]] ||= { name: m[1] });
      if (m[2] === 'utilization') w.used = Number(v);
      else if (m[2] === 'reset') w.resetAt = epochMs(v);
      else w.status = v;
      plan = true;
    }
    else if ((m = API.exec(k))) { (api[m[1]] ||= {})[m[2]] = v; hasApi = true; }
  };
  if (typeof headers?.forEach === 'function') headers.forEach((v, k) => visit(k, v));
  else for (const [k, v] of Object.entries(headers || {})) visit(k, v);
  if (!plan && hasApi) { // API key: show the per-minute buckets instead
    for (const [n, a] of Object.entries(api)) {
      const limit = Number(a.limit), remaining = Number(a.remaining);
      out.windows['api:' + n] = { name: 'api:' + n, limit, remaining,
        used: limit > 0 && Number.isFinite(remaining) ? Math.max(0, 1 - remaining / limit) : undefined,
        resetAt: a.reset ? epochMs(a.reset) : undefined };
    }
  }
  return plan || hasApi ? out : null;
}

/** Merge a parsed response into the stored limits record and add a history sample. Mutates and returns `L`. */
export function recordLimits(L, parsed, now = Date.now()) {
  L ||= { windows: {}, history: [] };
  L.windows ||= {}; L.history ||= [];
  for (const k of ['status', 'resetAt', 'claim', 'overage', 'overageReason', 'fallback']) if (parsed[k] !== undefined) L[k] = parsed[k];
  L.updatedAt = now;
  const sample = { t: now };
  let any = false;
  for (const [k, w] of Object.entries(parsed.windows)) {
    const prev = L.windows[k] || {};
    // A window that rolled over starts fresh; keep history only for continuity within a window.
    L.windows[k] = { ...prev, ...w };
    if (typeof w.used === 'number' && !k.startsWith('api:')) { sample[k] = w.used; any = true; }
  }
  if (any) {
    const last = L.history[L.history.length - 1];
    if (last && now - last.t < SAMPLE_MS) L.history[L.history.length - 1] = { ...last, ...sample };
    else L.history.push(sample);
    if (L.history.length > HISTORY_MAX) L.history.splice(0, L.history.length - HISTORY_MAX);
  }
  return L;
}

/** Least-squares slope of `used` against time (per ms) over the samples. */
function slope(pts, key) {
  const n = pts.length;
  const mt = pts.reduce((a, p) => a + p.t, 0) / n, mu = pts.reduce((a, p) => a + p[key], 0) / n;
  let num = 0, den = 0;
  for (const p of pts) { num += (p.t - mt) * (p[key] - mu); den += (p.t - mt) ** 2; }
  return den ? num / den : 0;
}

/**
 * What to show: each window with its share used, when it started and resets, the pace
 * over the recent past and, if usage is climbing, when it would run out at that pace.
 */
export function summarizeLimits(L, now = Date.now()) {
  if (!L || !L.windows || !Object.keys(L.windows).length) return null;
  const windows = Object.values(L.windows).map((w) => {
    const span = windowMs(w.name);
    const r = { name: w.name, label: LABELS[w.name] || (/^7d_/.test(w.name) ? `Weekly, ${w.name.slice(3)}` : /^5h_/.test(w.name) ? `Session, ${w.name.slice(3)}` : w.name), used: typeof w.used === 'number' ? w.used : null,
      status: w.status || null, resetAt: w.resetAt ?? null, span, startedAt: null, elapsed: null, resetIn: null,
      expired: false, ratePerHour: null, runOutAt: null, runsOutBeforeReset: null, limit: w.limit, remaining: w.remaining };
    if (r.resetAt != null) {
      r.resetIn = Math.max(0, r.resetAt - now);
      r.expired = now > r.resetAt;   // the window rolled over since the last request; the share shown is stale
      if (span) { r.startedAt = r.resetAt - span; r.elapsed = Math.min(span, Math.max(0, now - r.startedAt)); }
    }
    if (span && span >= 3600e3 && r.used != null && !r.expired) {
      const lookback = Math.min(span, span <= 6 * 3600e3 ? 90 * 60e3 : 48 * 3600e3);
      const pts = (L.history || []).filter((p) => typeof p[w.name] === 'number' && p.t >= (r.startedAt ?? 0) && now - p.t <= lookback);
      if (pts.length >= 2 && pts[pts.length - 1].t - pts[0].t >= 5 * 60e3) {
        const rate = slope(pts, w.name);
        r.ratePerHour = rate * 3600e3;
        if (rate > 0 && r.used < 1) {
          r.runOutAt = now + (1 - r.used) / rate;
          r.runsOutBeforeReset = r.resetAt != null ? r.runOutAt < r.resetAt : null;
        }
      }
    }
    return r;
  });
  const order = (n) => { const i = ORDER.indexOf(n); return i < 0 ? ORDER.length + (n.startsWith('api:') ? 10 : 0) : i; };
  windows.sort((a, b) => order(a.name) - order(b.name) || a.name.localeCompare(b.name));
  return { updatedAt: L.updatedAt ?? null, ageMs: L.updatedAt ? now - L.updatedAt : null, status: L.status ?? null, claim: L.claim ?? null,
    overage: L.overage ?? null, overageReason: L.overageReason ?? null, plan: windows.some((w) => !w.name.startsWith('api:')), windows };
}

// ---------- formatting (CLI) ----------
export const fmtDur = (ms) => {
  if (ms == null) return '?';
  const m = Math.round(ms / 60e3);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
};
export const fmtClock = (ms, now = Date.now()) => {
  if (ms == null) return '?';
  const d = new Date(ms), n = new Date(now);
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === n.toDateString() ? hm : `${d.toLocaleDateString([], { weekday: 'short' })} ${hm}`;
};
const bar = (used, width = 20) => {
  const f = Math.max(0, Math.min(width, Math.round((used ?? 0) * width)));
  return '[' + '█'.repeat(f) + '░'.repeat(width - f) + ']';
};

/** Human-readable usage report for the terminal. */
export function formatLimits(summary, now = Date.now()) {
  if (!summary) {
    return 'No plan usage seen yet. It appears after Claude Code\'s first request through ccpager\n' +
      '(Pro/Max accounts report a 5-hour session window and a weekly cap; API keys report per-minute limits).';
  }
  const lines = [`plan usage (from Anthropic's response headers, updated ${summary.ageMs != null ? fmtDur(summary.ageMs) + ' ago' : '?'})\n`];
  for (const w of summary.windows) {
    const pct = w.used == null ? '  ?' : `${Math.round(100 * w.used)}%`.padStart(4);
    const when = [];
    if (w.startedAt != null && w.span >= 3600e3) when.push(`started ${fmtClock(w.startedAt, now)} (${fmtDur(w.elapsed)} in)`);
    if (w.resetAt != null) when.push(w.expired ? 'window has reset; waiting for the next request' : `resets ${fmtClock(w.resetAt, now)} (in ${fmtDur(w.resetIn)})`);
    lines.push(`  ${w.label.padEnd(26)} ${bar(w.used)} ${pct}   ${when.join(' · ')}`);
    const pace = w.ratePerHour != null ? `${w.ratePerHour >= 0 ? '+' : ''}${(100 * w.ratePerHour).toFixed(1)}%/h` : null;
    if (w.used != null && w.used >= 1) lines.push(`  ${''.padEnd(26)} ⚠ limit reached`);
    else if (w.runOutAt != null) lines.push(`  ${''.padEnd(26)} at this pace (${pace}): runs out ${fmtClock(w.runOutAt, now)}, ${w.runsOutBeforeReset ? 'BEFORE the reset ⚠' : 'after the reset ✓'}`);
    else if (pace) lines.push(`  ${''.padEnd(26)} pace ${pace}: won't run out before the reset ✓`);
  }
  const tail = [];
  if (summary.status) tail.push(`status ${summary.status}`);
  if (summary.claim) tail.push(`binding window ${summary.claim}`);
  if (summary.overage) tail.push(`extra usage ${summary.overage}${summary.overageReason ? ` (${summary.overageReason})` : ''}`);
  if (tail.length) lines.push(`\n  ${tail.join(' · ')}`);
  return lines.join('\n');
}
