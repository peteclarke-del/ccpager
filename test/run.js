import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { pageRequest, noteUsage } from '../src/pager.js';
import { parseLimitHeaders, recordLimits, summarizeLimits, formatLimits } from '../src/limits.js';
import { protectDecision, applyProtect } from '../src/protect.js';
import { transform } from '../src/server.js';
import { extendCacheTtl, routeModel } from '../src/transforms.js';
import { createServer } from '../src/server.js';
import { createLogger } from '../src/log.js';
import { writeState } from '../src/state.js';
import { costOf, priceFor } from '../src/pricing.js';
import { execFileSync } from 'node:child_process';

let pass = 0;
const test = async (name, fn) => { await fn(); pass++; console.log('  ✓', name); };
const opts = { keepRecentTurns: 4, pageStep: 6, minPageChars: 1200 };

/** Build a fake Claude Code session: each real turn = user text → tool_use Read → tool_result → assistant text. */
function session(turns, { repeatFile = false } = {}) {
  const messages = [];
  for (let t = 0; t < turns; t++) {
    messages.push({ role: 'user', content: [{ type: 'text', text: `turn ${t}: do something` }] });
    const id = `toolu_${t}`;
    const file = repeatFile ? 'src/auth/session.ts' : `src/file${t}.ts`;
    messages.push({ role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: 'sig' + t }, { type: 'tool_use', id, name: 'Read', input: { file_path: file } }] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `// ${file}\n` + 'x'.repeat(5000) }] });
    messages.push({ role: 'assistant', content: [{ type: 'text', text: `done ${t}` }] });
  }
  messages.push({ role: 'user', content: 'next' });
  return { model: 'claude-opus-5-5', system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }], messages };
}
const size = (b) => JSON.stringify(b).length;

console.log('pager');
const HOUR = 3600_000;
const smart = { ...opts, keepRecentTurns: 10, pageStep: 8, pagingMode: 'smart', cacheTtl: '1h' };
/** How Claude Code really works: ONE typed prompt, then many tool rounds. */
function agentic(steps, { reread = null, chars = 5000 } = {}) {
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'fix the auth bug' }] }];
  for (let i = 0; i < steps; i++) {
    const file = reread && i === reread.at ? reread.file : `src/f${i}.ts`;
    messages.push({ role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 's' + i }, { type: 'tool_use', id: 'tu' + i, name: 'Read', input: { file_path: file } }] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu' + i, content: `// ${file}\n` + 'x'.repeat(chars) }] });
  }
  return { model: 'claude-opus-5-5', messages };
}
const results = (b) => b.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((x) => x.type === 'tool_result');
const newSession = () => ({ stubbed: new Map(), boundary: 0, lastAt: null });

await test('counts tool steps, not typed prompts: one prompt + 40 tool rounds gets paged', () => {
  const { body, stats } = pageRequest(agentic(40), smart);
  assert.equal(stats.pagedBlocks, 30); // 40 steps − 10 kept: everything older than the kept steps
  assert.match(results(body)[0].content, /^\[ccpager: paged out — Read src\/f0\.ts, \d+ chars, stale/);
  assert.ok(results(body)[30].content.length > 5000);
});
await test('moves are at least pageStep apart, and each one goes as far as it can', () => {
  const s = newSession();
  assert.equal(pageRequest(agentic(30), smart, s, 0).stats.pagedBlocks, 20);   // cold: cutoff at 20
  const r = pageRequest(agentic(34), { ...smart, pagingMode: 'always' }, s, 1000);
  assert.equal(r.stats.moved, false); assert.equal(r.stats.stepsUntil, 4);        // 24 eligible < 20 + 8
  const r2 = pageRequest(agentic(38), { ...smart, pagingMode: 'always' }, s, 2000);
  assert.equal(r2.stats.moved, true); assert.equal(r2.stats.pagedBlocks, 28);
});
await test('short sessions are untouched and report steps until paging can start', () => {
  const b = agentic(12);
  const r = pageRequest(b, smart);
  assert.equal(r.body, b);
  assert.equal(r.stats.stepsUntil, 6); // starts at 10 kept + 8 = 18 steps
});
await test('tool_use ids, thinking signatures and assistant turns are preserved', () => {
  const b = agentic(40);
  const { body } = pageRequest(b, smart);
  b.messages.forEach((m, i) => { if (m.role === 'assistant') assert.equal(body.messages[i], m); });
  const ids = (x) => x.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).map((c) => c.tool_use_id || c.id).filter(Boolean);
  assert.deepEqual(ids(body), ids(b));
});
await test('smart: a new or idle session moves the cutoff for free (cache cold)', () => {
  const s = newSession();
  const r = pageRequest(agentic(30), smart, s, 0);
  assert.equal(r.stats.moved, true); assert.equal(r.stats.reason, 'cache cold'); assert.equal(r.stats.rewriteChars, 0);
  const later = pageRequest(agentic(40), smart, s, 2 * HOUR); // idle 2h → cold again
  assert.equal(later.stats.reason, 'cache cold');
  assert.equal(later.stats.pagedBlocks, 30);
});
await test('smart: on a warm cache a small gain is held, so nothing old changes', () => {
  const s = newSession();
  const a = pageRequest(agentic(30), smart, s, 0);           // cold: cutoff at 20
  const b = pageRequest(agentic(38), smart, s, 60_000);      // warm, cutoff could move to 28
  assert.equal(b.stats.moved, false);
  assert.equal(b.stats.held, 'cache warm');
  assert.ok(b.stats.pendingChars > 0);
  assert.equal(b.stats.pagedBlocks, a.stats.pagedBlocks, 'same blocks as before');
  assert.equal(JSON.stringify(b.body.messages.slice(0, 61)), JSON.stringify(a.body.messages), 'byte-identical prefix: cache keeps hitting');
});
await test('smart: warm cache still moves when it pays off, and reports the rewrite', () => {
  const s = newSession();
  pageRequest(agentic(30, { chars: 5000 }), smart, s, 0);
  const big = agentic(38, { chars: 5000 });
  for (let i = 20; i < 28; i++) big.messages[2 + 2 * i].content[0].content = 'y'.repeat(100_000); // huge stale logs
  const r = pageRequest(big, smart, s, 60_000);
  assert.equal(r.stats.reason, 'pays off');
  assert.ok(r.stats.rewriteChars > 0);
});
await test('large context only forces a warm-cache move when largeContext is set (off by default)', () => {
  const mk = () => { const b = agentic(38, { chars: 2000 }); for (let i = 28; i < 38; i++) b.messages[2 + 2 * i].content[0].content = 'y'.repeat(80_000); return b; };
  const s = newSession();
  pageRequest(agentic(30, { chars: 2000 }), smart, s, 0);
  const held = pageRequest(mk(), smart, s, 60_000);
  assert.equal(held.stats.held, 'cache warm');
  const s2 = newSession();
  pageRequest(agentic(30, { chars: 2000 }), smart, s2, 0);
  const moved = pageRequest(mk(), { ...smart, largeContextTokens: 150_000 }, s2, 60_000);
  assert.equal(moved.stats.reason, 'large context');
});
await test('the cache TTL seen in responses drives cold detection and rewrite pricing', () => {
  const s = newSession();
  const off = { ...smart, cacheTtl: 'off' };
  pageRequest(agentic(30), off, s, 0);
  assert.equal(pageRequest(agentic(31), off, s, 1000).stats.ttl, '5m');
  noteUsage(s, { cache_creation: { ephemeral_1h_input_tokens: 10, ephemeral_5m_input_tokens: 0 } });
  const r = pageRequest(agentic(38), off, s, 10 * 60_000); // 10 min idle: cold on 5m, warm on the 1h Claude Code really uses
  assert.equal(r.stats.ttl, '1h');
  assert.equal(r.stats.held, 'cache warm');
  noteUsage(s, { cache_creation: { ephemeral_5m_input_tokens: 10 } });
  assert.equal(s.ttl, '5m');
});
await test('decisions are frozen: re-reading an old file later never changes old messages', () => {
  const s = newSession();
  const a = pageRequest(agentic(20, { chars: 300 }), { ...smart, minPageChars: 1200 }, s, 0); // small reads: nothing stale yet
  const b = pageRequest(agentic(21, { chars: 300, reread: { at: 20, file: 'src/f0.ts' } }), { ...smart, minPageChars: 1200 }, s, 60_000);
  assert.equal(a.stats.pagedBlocks, 0);
  assert.equal(b.stats.pagedBlocks, 0, 'f0 is now superseded, but flipping it would break the warm cache');
});
await test("'always' mode moves on every boundary and counts the cache rewrite", () => {
  const s = newSession();
  pageRequest(agentic(30), { ...smart, pagingMode: 'always' }, s, 0);
  const r = pageRequest(agentic(38), { ...smart, pagingMode: 'always' }, s, 60_000);
  assert.equal(r.stats.moved, true); assert.ok(r.stats.rewriteChars > 0);
});
await test('superseded reads are paged even when small; errors and stubs are left alone', () => {
  const b = session(12, { repeatFile: true });
  b.messages.forEach((m) => Array.isArray(m.content) && m.content.forEach((c) => { if (c.type === 'tool_result') c.content = 'y'.repeat(500); }));
  assert.match(JSON.stringify(pageRequest(b, opts).body), /superseded by a later call/);
  const e = agentic(40); e.messages[2].content[0].is_error = true;
  const once = pageRequest(e, smart).body;
  assert.ok(once.messages[2].content[0].content.length > 5000);
  assert.equal(pageRequest(once, smart).stats.pagedBlocks, 0); // already-stubbed blocks aren't paged or counted twice
});

console.log('transforms');
await test('ephemeral cache breakpoints get ttl 1h, explicit ttls are kept', () => {
  const b = { system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral', ttl: '5m' } }, { type: 'text', text: 'b', cache_control: { type: 'ephemeral' } }] }] };
  const { body, upgraded } = extendCacheTtl(b, '1h');
  assert.equal(upgraded, 2);
  assert.equal(body.system[0].cache_control.ttl, '1h');
  assert.equal(body.messages[0].content[0].cache_control.ttl, '5m');
  assert.equal(b.system[0].cache_control.ttl, undefined, 'input not mutated');
});
await test('routing: light fresh instruction → small model; heavy or mid-task stays', () => {
  const mk = (content) => ({ model: 'claude-opus-5-5', messages: [{ role: 'user', content }] });
  assert.equal(routeModel(mk('rename this variable to userId'), 'claude-haiku-5-5').body.model, 'claude-haiku-5-5');
  assert.equal(routeModel(mk('design the migration plan for orders'), 'h').routed, null);
  assert.equal(routeModel(mk([{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }]), 'h').routed, null);
});

console.log('gateway (end to end, mock upstream)');
await test('rewrites /v1/messages, streams SSE back, passes auth, records usage', async () => {
  let seen;
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    try { seen = { url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks)) }; } catch {}
    res.writeHead(200, { 'content-type': 'text/event-stream', 'anthropic-ratelimit-unified-5h-utilization': '0.37',
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 7200), 'anthropic-ratelimit-unified-7d-utilization': '0.12',
      'anthropic-ratelimit-unified-7d-reset': String(Math.floor(Date.now() / 1000) + 3 * 86400), 'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-representative-claim': 'five_hour' });
    res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":900,"cache_creation_input_tokens":50}}}\n\n');
    setTimeout(() => {
      res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n');
      res.end('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n');
    }, 20);
  }).listen(0);
  await new Promise((r) => upstream.once('listening', r));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpager-'));
  const gw = createServer({ upstream: `http://127.0.0.1:${upstream.address().port}`, paging: true, ...opts, cacheTtl: '1h', routing: false, dataDir }, { log() {}, warn() {}, error() {} }).listen(0);
  await new Promise((r) => gw.once('listening', r));

  const original = session(12);
  const res = await fetch(`http://127.0.0.1:${gw.address().port}/v1/messages?beta=true`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer sk-ant-oat-test', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(original),
  });
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.match(res.headers.get('x-ccpager'), /paged=10/);
  assert.match(text, /text_delta/);
  assert.equal(res.headers.get('anthropic-ratelimit-unified-5h-utilization'), '0.37', 'limit headers reach Claude Code');
  assert.equal(seen.url, '/v1/messages?beta=true');
  assert.equal(seen.headers.authorization, 'Bearer sk-ant-oat-test');
  assert.equal(seen.body.system[0].cache_control.ttl, '1h');
  assert.ok(size(seen.body) < size(original) * 0.6);
  const u = gw.stats.data.usage;
  assert.deepEqual([u.input, u.cacheRead, u.cacheWrite, u.output], [10, 900, 50, 7]);
  assert.equal(u.cacheWrite1h, 50, 'writes attributed to the 1h tier we asked for');
  const L = gw.stats.data.limits;
  assert.equal(L.windows['5h'].used, 0.37); assert.equal(L.windows['7d'].used, 0.12); assert.equal(L.status, 'allowed');
  assert.equal(L.history.length, 1);
  const sum = summarizeLimits(L);
  assert.equal(sum.windows[0].name, '5h'); assert.ok(sum.windows[0].resetIn > 7000e3 && sum.windows[0].elapsed > 3 * 3600e3);

  // Non-messages endpoints and malformed bodies pass through untouched (fail open).
  const bad = await fetch(`http://127.0.0.1:${gw.address().port}/v1/messages`, { method: 'POST', body: 'not json' });
  assert.equal(bad.status, 200);
  gw.close(); upstream.close();
});

await test('on/off: off forwards original bytes untouched, on resumes, no restart; log file + health', async () => {
  let lastRaw;
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    lastRaw = Buffer.concat(chunks).toString();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10 } }));
  }).listen(0);
  await new Promise((r) => upstream.once('listening', r));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpager-'));
  const log = createLogger(dataDir, { echo: false });
  const gw = createServer({ upstream: `http://127.0.0.1:${upstream.address().port}`, paging: true, ...opts, cacheTtl: '1h', routing: false, dataDir }, log).listen(0);
  await new Promise((r) => gw.once('listening', r));
  const base = `http://127.0.0.1:${gw.address().port}`;
  const body = JSON.stringify(session(12));
  const send = () => fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });

  let r = await send(); await r.text();
  assert.match(r.headers.get('x-ccpager'), /paged=10/);
  assert.notEqual(lastRaw, body);

  writeState(dataDir, { enabled: false });
  r = await send(); await r.text();
  assert.equal(r.headers.get('x-ccpager'), 'off');
  assert.equal(lastRaw, body, 'off = byte-identical pass-through');

  writeState(dataDir, { enabled: true, paging: false });
  await new Promise((r) => setTimeout(r, 15)); // distinct mtime
  r = await send(); await r.text();
  assert.match(r.headers.get('x-ccpager'), /paged=0/);
  assert.match(lastRaw, /"ttl":"1h"/, 'cache still on when only paging is off');

  const h = await (await fetch(`${base}/ccpager/health`)).json();
  assert.equal(h.config.paging, false);
  assert.equal(h.pid, process.pid);
  const logText = fs.readFileSync(path.join(dataDir, 'ccpager.log'), 'utf8');
  assert.match(logText, /\/v1\/messages model=claude-opus-5-5 msgs=49 paged=10 .*cutoff moved \(cache cold\)/);
  assert.match(logText, /OFF \(pass-through, unchanged\)/);
  assert.equal(gw.stats.data.totals.requests, 3, 'savings accounting ran for every response');
  gw.close(); upstream.close();
});

await test('a dropped upstream connection is retried once instead of returning 502', async () => {
  let n = 0;
  const upstream = http.createServer((req, res) => {
    if (n++ === 0) { req.socket.destroy(); return; } // first attempt: connection reset before any response
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }));
  }).listen(0);
  await new Promise((r) => upstream.once('listening', r));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpager-'));
  const warns = [];
  const gw = createServer({ upstream: `http://127.0.0.1:${upstream.address().port}`, paging: false, ...opts, cacheTtl: 'off', routing: false, dataDir }, { log() {}, warn: (...a) => warns.push(a.join(' ')), error() {} }).listen(0);
  await new Promise((r) => gw.once('listening', r));
  const r = await fetch(`http://127.0.0.1:${gw.address().port}/v1/messages`, { method: 'POST', body: JSON.stringify({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }] }) });
  assert.equal(r.status, 200); await r.text();
  assert.equal(n, 2);
  assert.match(warns.join('\n'), /retrying once/);
  assert.equal(gw.inflight, 0);
  gw.close(); upstream.close();
});

console.log('plan usage limits');
await test('parses subscription headers, falls back to per-minute API headers', () => {
  const h = new Headers({ 'anthropic-ratelimit-unified-5h-utilization': '0.42', 'anthropic-ratelimit-unified-5h-reset': '1800000000',
    'anthropic-ratelimit-unified-7d_opus-utilization': '0.9', 'anthropic-ratelimit-unified-7d_opus-status': 'allowed_warning',
    'anthropic-ratelimit-unified-status': 'allowed', 'anthropic-ratelimit-unified-overage-status': 'disabled', 'x-other': '1' });
  const p = parseLimitHeaders(h);
  assert.equal(p.windows['5h'].used, 0.42); assert.equal(p.windows['5h'].resetAt, 1800000000000);
  assert.equal(p.windows['7d_opus'].status, 'allowed_warning'); assert.equal(p.overage, 'disabled');
  const api = parseLimitHeaders({ 'anthropic-ratelimit-input-tokens-limit': '2000000', 'anthropic-ratelimit-input-tokens-remaining': '1500000', 'anthropic-ratelimit-input-tokens-reset': '2026-10-27T10:00:00Z' });
  assert.equal(api.windows['api:input-tokens'].used, 0.25);
  assert.equal(parseLimitHeaders({ 'content-type': 'text/plain' }), null);
});
await test('predicts the run-out time from the pace within the window', () => {
  const H = 3600e3, t0 = 1_800_000_000_000;
  const reset = t0 + 3 * H; // 5h window: started 2h before t0
  let L = null;
  for (const [dt, used] of [[0, 0.20], [20 * 60e3, 0.25], [40 * 60e3, 0.30], [60 * 60e3, 0.35]]) {
    L = recordLimits(L, { windows: { '5h': { name: '5h', used, resetAt: reset } }, status: 'allowed' }, t0 + dt);
  }
  assert.equal(L.history.length, 4);
  const now = t0 + H;
  const w = summarizeLimits(L, now).windows[0];
  assert.equal(w.used, 0.35); assert.equal(w.startedAt, reset - 5 * H); assert.equal(w.resetIn, 2 * H);
  assert.ok(Math.abs(w.ratePerHour - 0.15) < 1e-9);                  // +15%/h
  assert.ok(Math.abs(w.runOutAt - (now + (0.65 / 0.15) * H)) < 1000); // ~4h20m away
  assert.equal(w.runsOutBeforeReset, false);
  // faster pace: 0.2 → 0.8 in an hour, 0.2 left at 0.6/h = 20 min, well before the reset
  let F = null;
  for (const [dt, used] of [[0, 0.2], [30 * 60e3, 0.5], [60 * 60e3, 0.8]]) F = recordLimits(F, { windows: { '5h': { name: '5h', used, resetAt: reset } } }, t0 + dt);
  const f = summarizeLimits(F, now).windows[0];
  assert.equal(f.runsOutBeforeReset, true);
  assert.match(formatLimits(summarizeLimits(F, now), now), /BEFORE the reset/);
  // after the reset time passes with no new request, the stale share is flagged
  assert.equal(summarizeLimits(F, reset + 1).windows[0].expired, true);
  assert.match(formatLimits(null), /No plan usage seen yet/);
  // samples within a minute collapse into one
  let C = null; for (let i = 0; i < 5; i++) C = recordLimits(C, { windows: { '5h': { name: '5h', used: 0.1 + i / 100 } } }, t0 + i * 1000);
  assert.equal(C.history.length, 1); assert.equal(C.history[0]['5h'], 0.14);
});

console.log('adaptive protection');
await test('decides from the usage summary: run-out before reset, threshold, or used up', () => {
  const cfg = { protect: true, protectAt: 80, protectModel: 'claude-sonnet-5-5' };
  const sum = (w) => ({ plan: true, windows: [{ name: '5h', label: 'Session (5-hour window)', used: 0.3, runsOutBeforeReset: false, expired: false, ...w }] });
  assert.equal(protectDecision(sum({}), cfg).active, false);
  assert.equal(protectDecision(sum({ runsOutBeforeReset: true }), cfg).active, true);
  assert.match(protectDecision(sum({ runsOutBeforeReset: true }), cfg).reason, /runs out before/);
  assert.equal(protectDecision(sum({ used: 0.85 }), cfg).active, true);
  assert.equal(protectDecision(sum({ used: 0.85, expired: true }), cfg).active, false, 'stale window after reset is ignored');
  assert.equal(protectDecision(sum({ used: 0.85 }), { ...cfg, protect: false }).active, false);
  assert.equal(protectDecision(null, cfg).active, false);
  assert.equal(protectDecision({ plan: false, windows: [{ name: 'api:tokens', used: 0.9 }] }, cfg).active, false, 'API keys have no plan window');
});
await test('routes only NEW big-model sessions, keeps them routed, never switches a running one', () => {
  const cfg = { protect: true, protectAt: 80, protectModel: 'claude-sonnet-5-5', routing: false, routeSmallModel: 'claude-haiku-5-5', paging: false, cacheTtl: 'off' };
  const on = { active: true, reason: 'test' }, off = { active: false };
  const fresh = { model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'Explore the repo for auth handling and report the files involved, thoroughly' }] };
  const s = newSession();
  const r = transform(fresh, cfg, s, on);
  assert.equal(r.body.model, 'claude-sonnet-5-5'); assert.equal(r.report.routed.why, 'protect');
  // the same session later, protection already off: stays on Sonnet so its cache survives
  const later = { ...fresh, messages: [...fresh.messages, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, { role: 'user', content: 'go on' }] };
  s.lastAt = 1;
  assert.equal(transform(later, cfg, s, off).body.model, 'claude-sonnet-5-5');
  // a conversation that was already under way when protection started is left alone
  const s2 = newSession(); s2.lastAt = 1; s2.boundary = 0;
  assert.equal(transform(agentic(10), cfg, s2, on).body.model, 'claude-opus-5-5');
  assert.equal(transform({ ...fresh, messages: agentic(10).messages }, cfg, newSession(), on).body.model, 'claude-opus-5-5', 'long first sight is not fresh');
  // Haiku/Sonnet requests are not touched; light turns get Haiku while protection is on even with routing off
  assert.equal(transform({ ...fresh, model: 'claude-sonnet-5-5' }, cfg, newSession(), on).body.model, 'claude-sonnet-5-5');
  const light = { model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'rename this variable to count' }] };
  const s3 = newSession(); s3.lastAt = 1;
  assert.equal(transform(light, cfg, s3, on).body.model, 'claude-haiku-5-5');
  assert.equal(transform(light, cfg, newSession(), off).body.model, 'claude-opus-5-5');
  // applyProtect directly, with no session (count_tokens): routes but records nothing
  assert.equal(applyProtect(fresh, on, cfg, null).body.model, 'claude-sonnet-5-5');
});
await test('end to end: a session running out before its reset makes the next new session start on Sonnet', async () => {
  const H = 3600e3; let util = 0.2;
  const upstream = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', 'anthropic-ratelimit-unified-5h-utilization': String(util),
        'anthropic-ratelimit-unified-5h-reset': String(Math.floor((Date.now() + 2 * H) / 1000)), 'anthropic-ratelimit-unified-status': 'allowed' });
      res.end(JSON.stringify({ model: JSON.parse(b).model, usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  }).listen(0);
  await new Promise((r) => upstream.once('listening', r));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpager-'));
  const gw = createServer({ upstream: `http://127.0.0.1:${upstream.address().port}`, ...opts, paging: false, cacheTtl: 'off', routing: false, protect: true, protectAt: 80, protectModel: 'claude-sonnet-5-5', routeSmallModel: 'claude-haiku-5-5', dataDir }, { log() {}, warn() {}, error() {} }).listen(0);
  await new Promise((r) => gw.once('listening', r));
  const send = async (i) => { const r = await fetch(`http://127.0.0.1:${gw.address().port}/v1/messages`, { method: 'POST', body: JSON.stringify({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'new session number ' + i + ' please investigate the build pipeline thoroughly' }] }) }); return (await r.json()).model; };
  assert.equal(await send(1), 'claude-opus-5-5');
  // fake a steep climb in the sample history: 0.2 → 0.9 over the last hour, 2h to the reset ⇒ runs out first
  const L = gw.stats.data.limits; const now = Date.now();
  L.history = [{ t: now - 60 * 60e3, '5h': 0.2 }, { t: now - 30 * 60e3, '5h': 0.55 }, { t: now - 1000, '5h': 0.9 }];
  util = 0.9;
  await send(2); // this one still sees the pre-climb decision (cached up to 5 s) and records the header
  await new Promise((r) => setTimeout(r, 5100));
  assert.equal(await send(3), 'claude-sonnet-5-5');
  assert.equal(gw.stats.data.protected, 1);
  const health = await (await fetch(`http://127.0.0.1:${gw.address().port}/ccpager/health`)).json();
  assert.equal(health.protect.active, true);
  gw.close(); upstream.close();
});

console.log('pricing & savings');
await test('per-model prices, Haiku long-context tier, unknown model falls back', () => {
  assert.equal(priceFor('claude-opus-5-5-20261001').input, 4);
  assert.equal(priceFor('claude-sonnet-5').read, 0.2);
  assert.equal(priceFor('claude-sonnet-5-5').read, 0.1);
  assert.equal(priceFor('claude-haiku-5-5', 50_000).input, 0.1);
  assert.equal(priceFor('claude-haiku-5-5', 150_000).input, 0.5);
  assert.equal(priceFor('mystery-model').known, false);
});
await test('cost uses the 1h write rate when the API reports it, and values savings low–high', () => {
  const u = { input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, output_tokens: 1_000_000,
    cache_creation_input_tokens: 2_000_000, cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 } };
  const c = costOf('claude-opus-5-5', u, 1_000_000);
  assert.equal(+c.cost.toFixed(2), 4 + 0.2 + 20 + 5 + 8);
  assert.equal(+c.savedLow.toFixed(2), 0.2);
  assert.equal(+c.savedHigh.toFixed(2), 4);
});

console.log('cli');
await test('on/off/status/stats commands', () => {
  const env = { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'home-')), CCPAGER_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-')), CCPAGER_PORT: '18765' };
  const cli = (...a) => execFileSync(process.execPath, ['bin/ccpager.js', ...a], { env, encoding: 'utf8' });
  assert.match(cli('off'), /OFF: requests now pass through unchanged/);
  assert.match(cli('on', 'routing'), /ON  paging on · cache off · routing on · protect on/); // 1h upgrade is off by default
  assert.match(cli('on', 'cache'), /cache 1h/);
  assert.match(cli('off', 'cache'), /cache off/);
  assert.throws(() => execFileSync(process.execPath, ['bin/ccpager.js', 'off', 'bogus'], { env, encoding: 'utf8', stdio: 'pipe' }));
  assert.match(cli('status'), /mode      ON  paging on · cache off · routing on · protect on/);
  assert.match(cli('status'), /protect   armed/);
  assert.match(cli('off', 'protect'), /protect off/);
  assert.match(cli('status'), /usage     not seen yet/);
  assert.match(cli('stats'), /No stats yet/);
  assert.match(cli('usage'), /No plan usage seen yet/);
  assert.match(cli('set', 'largeContext', '150000'), /largeContext = 150000/);
  assert.match(cli('get'), /largeContext 150000/);
});

console.log(`\n${pass} passed`);
process.exit(0);
