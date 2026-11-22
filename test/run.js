import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { pageRequest, noteUsage, digestOf, Sessions } from '../src/pager.js';
import { parseLimitHeaders, recordLimits, summarizeLimits, formatLimits } from '../src/limits.js';
import { protectDecision, applyProtect } from '../src/protect.js';
import { transform } from '../src/server.js';
import { tidy, lineDiff, compressFresh, pinnedBases, budgetText, summarizeMatches, looksMechanical } from '../src/fresh.js';
import { rewriteCommand, handleHook, installHook, hookInstalled } from '../src/hook.js';
import { compareVersions, parseRelease, installKind, checkForUpdate, VERSION } from '../src/update.js';
import { extendCacheTtl, routeModel } from '../src/transforms.js';
import { createServer } from '../src/server.js';
import { createLogger } from '../src/log.js';
import { writeState } from '../src/state.js';
import { costOf, priceFor } from '../src/pricing.js';
import { effectiveConfig } from '../src/state.js';
import { classify } from '../src/session-type.js';
import { applyTerse } from '../src/terse.js';
import { Stats } from '../src/stats.js';
import { execFileSync, execFile } from 'node:child_process';

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

await test('old Write/Edit inputs are paged at the cutoff, frozen, and signatures untouched', () => {
  const b = agentic(40);
  b.messages[1].content[1] = { type: 'tool_use', id: 'tu0', name: 'Write', input: { file_path: 'a.ts', content: 'y'.repeat(9000) } };
  const recent = b.messages[b.messages.length - 2].content[1];
  recent.name = 'Write'; recent.input = { file_path: 'z.ts', content: 'q'.repeat(9000) };
  const sess = newSession();
  const r = pageRequest(b, smart, sess, 0).body;
  const w = r.messages[1].content[1];
  assert.ok(w.input.content.startsWith('[ccpager: paged out'), 'old Write content stubbed');
  assert.equal(w.input.file_path, 'a.ts');
  assert.equal(r.messages[1].content[0].signature, 's0');
  assert.equal(r.messages[r.messages.length - 2].content[1].input.content.length, 9000, 'recent kept');
  const again = pageRequest(b, smart, sess, 1000).body;                 // held: same bytes replayed
  assert.equal(JSON.stringify(again.messages[1]), JSON.stringify(r.messages[1]));
});

await test('hookInstalled recognises the installed absolute-path command', () => {
  const f = path.join(os.tmpdir(), `ccp-hook-${process.pid}.json`);
  fs.writeFileSync(f, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '"/n/node" "/x/bin/ccpager.js" hook run' }] }] } }));
  assert.equal(hookInstalled(f), true);
  fs.unlinkSync(f);
});

await test('inputs switch: `off inputs` disables input paging via effectiveConfig', () => {
  assert.equal(effectiveConfig({ pageInputs: true }, { inputs: false }).pageInputs, false);
  assert.equal(effectiveConfig({ pageInputs: true }, {}).pageInputs, true);
});

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
  assert.equal(health.version, VERSION);
  gw.close(); upstream.close();
});

console.log('fresh tool results (cache-safe)');
await test('tidy strips ANSI, progress bars, trailing space, blank runs, repeated lines, pretty JSON', () => {
  const noisy = '\x1b[32mok\x1b[0m   \n\n\n\nprogress 10%\rprogress 50%\rprogress 100%\nsame\nsame\nsame\nsame\nend\n\n';
  assert.equal(tidy(noisy), 'ok\n\nprogress 100%\nsame   [× 4]\nend');
  const pretty = JSON.stringify({ a: Array.from({ length: 200 }, (_, i) => ({ i, name: 'x' + i })) }, null, 4);
  assert.ok(tidy(pretty).length < pretty.length * 0.8);
  assert.equal(tidy('plain\ntext'), 'plain\ntext');
});
await test('lineDiff produces compact hunks and null when too big', () => {
  const a = Array.from({ length: 100 }, (_, i) => 'line ' + i).join('\n');
  const b = a.replace('line 50', 'line fifty').replace('line 90\n', 'line 90\nnew line\n');
  const d = lineDiff(a, b);
  assert.match(d, /@@ -49,5 \+49,5 @@/); assert.match(d, /-line 50\n\+line fifty/); assert.match(d, /\+new line/);
  assert.ok(d.length < b.length / 4);
  assert.equal(lineDiff(a, a), '');
  assert.equal(lineDiff('x\n'.repeat(7000), 'y'), null);
});
const freshBody = (results) => { // results: [{target, text, err?}] in order, each a Read step
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }];
  results.forEach((r, i) => {
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'u' + i, name: 'Read', input: { file_path: r.target } }] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u' + i, content: r.text, is_error: !!r.err }] });
  });
  return messages;
};
await test('fresh: decides only on the newest result, then replays byte-identically; errors untouched', () => {
  const s = { stubbed: new Map(), fresh: new Map(), boundary: 0, lastAt: null };
  const noisy = '\x1b[31m' + 'x'.repeat(300) + '\x1b[0m\n\n\n\n' + 'dup\n'.repeat(80);
  const m1 = freshBody([{ target: 'a.log', text: noisy }]);
  const r1 = compressFresh(m1, s);
  assert.equal(r1.freshBlocks, 1); assert.ok(r1.charsSaved > 150); assert.equal(s.fresh.size, 1);
  const first = r1.out[2].content[0].content;
  const m2 = freshBody([{ target: 'a.log', text: noisy }, { target: 'b.txt', text: 'clean text '.repeat(60) }]);
  const r2 = compressFresh(m2, s);
  assert.equal(r2.out[2].content[0].content, first, 'older decision replays unchanged');
  assert.equal(r2.out[4].content[0].content, 'clean text '.repeat(60), 'nothing to tidy: untouched');
  assert.equal(s.fresh.size, 1);
  const m3 = freshBody([{ target: 'a.log', text: noisy }, { target: 'e.log', text: noisy, err: true }]);
  assert.equal(compressFresh(m3, s).freshBlocks, 1, 'error results are never rewritten');
  assert.equal(compressFresh(m1, s, { enabled: false }).freshBlocks, 0);
});
await test('fresh: a re-read becomes a reference when identical, a diff when slightly changed, the file when very different', () => {
  const s = { stubbed: new Map(), fresh: new Map(), boundary: 0, lastAt: null };
  const file = Array.from({ length: 120 }, (_, i) => `const v${i} = ${i};`).join('\n');
  const same = freshBody([{ target: 'src/a.js', text: file }, { target: 'src/a.js', text: file }]);
  const r = compressFresh(same, s);
  assert.match(r.out[4].content[0].content, /^\[ccpager: Read src\/a\.js is identical to the result at message 3/);
  assert.equal(s.fresh.get('u1').base, 'u0');
  assert.deepEqual([...pinnedBases(same, s)], ['u0'], 'the base is pinned against paging');
  const edited = file.replace('const v60 = 60;', 'const v60 = 61; // bumped');
  const s2 = { stubbed: new Map(), fresh: new Map(), boundary: 0, lastAt: null };
  const d = compressFresh(freshBody([{ target: 'src/a.js', text: file }, { target: 'src/a.js', text: edited }]), s2);
  const body = d.out[4].content[0].content;
  assert.match(body, /changed since message 3; unified diff/); assert.match(body, /-const v60 = 60;\n\+const v60 = 61; \/\/ bumped/);
  assert.ok(body.length < edited.length / 3);
  const s3 = { stubbed: new Map(), fresh: new Map(), boundary: 0, lastAt: null };
  const other = Array.from({ length: 120 }, (_, i) => `let w${i} = "${i}";`).join('\n');
  const f = compressFresh(freshBody([{ target: 'src/a.js', text: file }, { target: 'src/a.js', text: other }]), s3);
  assert.equal(f.out[4].content[0].content, other, 'a rewrite that would be bigger than the file is not used');
  const off = compressFresh(freshBody([{ target: 'src/a.js', text: file }, { target: 'src/a.js', text: file }]), { fresh: new Map() }, { rereadDiff: false });
  assert.equal(off.freshBlocks, 0);
});
await test('fresh + paging, step by step like the gateway: a diff pins its base against later paging', () => {
  const s = newSession(); s.fresh = new Map();
  const file = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n');
  const steps = Array.from({ length: 34 }, (_, i) => ({ target: 'f' + i, text: 'y'.repeat(3000) }));
  steps[20] = { target: 'src/a.js', text: file };
  steps[25] = { target: 'src/a.js', text: file + '\nextra' };
  const opts = { ...smart, keepRecentTurns: 4, pageStep: 8, cacheTtl: 'off' }; // 5m price ratio: moves at steps 12, 20, 28
  let sawDiffPastBase = false;
  for (let n = 1; n <= steps.length; n++) {
    const msgs = freshBody(steps.slice(0, n));
    const r = pageRequest({ model: 'claude-opus-5-5', messages: msgs }, { ...opts, pinned: pinnedBases(msgs, s) }, s, n * 1000);
    const f = compressFresh(r.body.messages, s);
    if (n === 26) assert.equal(s.fresh.get('u25')?.base, 'u20', 'the re-read was decided as a diff while its base was still in full');
    if (n >= 26 && !s.stubbed.has('u25')) { // while the diff is live, its base must be too, whatever paging did around it
      assert.ok(!s.stubbed.has('u20'), `pinned base survives paging at step ${n}`);
      assert.match(f.out[2 + 2 * 25].content[0].content, /changed since message \d+; unified diff/);
      assert.equal(f.out[2 + 2 * 20].content[0].content, file, 'the base is still sent in full');
      if (s.boundary > 20) { sawDiffPastBase = true; assert.ok(s.stubbed.has('u19'), 'its neighbours were paged as usual'); }
    }
  }
  assert.ok(sawDiffPastBase, 'the cutoff moved past the base while the diff was live');
});

console.log('fresh trims: budget, match summaries and pinned bases');
await test('budgetText elides the middle of an oversized result and leaves everything else alone', () => {
  const lines = Array.from({ length: 3000 }, (_, i) => `2026-11-14T10:00:${String(i % 60).padStart(2, '0')}Z INFO processed item ${i}`);
  const big = lines.join('\n');
  const b = budgetText(big, 24000);
  assert.ok(b, 'a six-figure log is trimmed');
  assert.ok(b.length < big.length / 2);
  assert.match(b, /of 3000 lines elided; re-run with a narrower range/);
  assert.ok(b.includes(lines[0]), 'head kept');
  assert.ok(b.includes(lines[lines.length - 1]), 'tail kept');
  assert.ok(!b.includes(lines[1500]), 'the middle is what goes');
  assert.equal(budgetText(big, 0), null, '0 = off');
  assert.equal(budgetText(big, 10_000_000), null, 'under budget');
  assert.equal(budgetText('one line '.repeat(5000), 1000), null, 'one long line has no middle to drop');
  assert.equal(budgetText(Array.from({ length: 350 }, (_, i) => `l${i}`).join('\n'), 24000), null, 'under the budget in chars');
});
await test('the budget never elides an ordinary source-file read', () => {
  const code = Array.from({ length: 700 }, (_, i) => `  const value${i} = compute(${i}, options);`);
  const src = code.join('\n');
  assert.ok(src.length > 24000, `the fixture is over the budget (${src.length} chars)`);
  assert.equal(looksMechanical(src), false);
  assert.equal(budgetText(src, 24000), null, 'a file read comes whole, however long');
  const log = Array.from({ length: 3000 }, (_, i) => `ok ${i} - case ${i % 9} completed in ${i % 50}ms`);
  assert.equal(looksMechanical(log.join('\n')), true);
  const msgs = (name, input, text) => [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name, input }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: text }] },
  ];
  const read = compressFresh(msgs('Read', { file_path: 'src/big.ts' }, src), { fresh: new Map() }, { budget: 24000, matches: true });
  assert.equal(read.freshBlocks, 0, 'a Read result is never budgeted');
  const bash = compressFresh(msgs('Bash', { command: 'npm test' }, log.join('\n')), { fresh: new Map() }, { budget: 24000, matches: true });
  assert.equal(bash.budgeted, 1, 'a test log still is');
  assert.match(bash.out[2].content[0].content, /lines elided/);
  // a shell command that cats a source file looks like code, so it is left alone too
  const cat = compressFresh(msgs('Bash', { command: 'cat src/big.ts' }, src), { fresh: new Map() }, { budget: 24000, matches: true });
  assert.equal(cat.freshBlocks, 0, 'mechanical means mechanical, not just "not Read"');
});
await test('summarizeMatches keeps the first matches per file and counts the rest', () => {
  const files = 12, per = 10;
  const text = Array.from({ length: files }, (_, f) =>
    Array.from({ length: per }, (_, i) => `src/m${f}.ts:${i + 1}:  const t${i} = 1;`).join('\n')).join('\n');
  const s = summarizeMatches(text);
  assert.match(s, /^\[ccpager: 120 matches in 12 files; first 3 per file\]/);
  assert.match(s, /\+7 more in src\/m0\.ts/);
  assert.equal(s.split('\n').filter((l) => l.startsWith('src/')).length, files * 3, 'three kept lines per file');
  assert.equal(summarizeMatches('src/a.js:1: only one'), null);
  assert.equal(summarizeMatches('no matches here\nat all'), null);
});
await test('compressFresh applies the budget and the match summary once, then replays them', () => {
  const log = Array.from({ length: 3000 }, (_, i) => `ok ${i} - case ${i % 41}`).join('\n');
  const s1 = { fresh: new Map() };
  const r1 = compressFresh(freshBody([{ target: 'run.log', text: log }]), s1, { budget: 24000, matches: true });
  assert.equal(r1.freshBlocks, 1);
  assert.equal(r1.budgeted, 1);
  const first = r1.out[2].content[0].content;
  assert.match(first, /lines elided/);
  assert.equal(compressFresh(freshBody([{ target: 'run.log', text: log }]), s1, { budget: 24000, matches: true }).out[2].content[0].content, first,
    'the decision replays byte-identically');
  assert.equal(s1.fresh.size, 1);
  const r2 = compressFresh(freshBody([{ target: 'run.log', text: log }]), { fresh: new Map() }, { budget: 0, matches: false });
  assert.equal(r2.freshBlocks, 0, 'budget 0 and matches off leave it alone');
  const hits = Array.from({ length: 12 }, (_, f) =>
    Array.from({ length: 10 }, (_, i) => `src/g${f}.ts:${i + 1}:  token ${i}`).join('\n')).join('\n');
  const r3 = compressFresh(freshBody([{ target: 'src/g0.ts', text: hits }]), { fresh: new Map() }, { budget: 24000, matches: true });
  assert.equal(r3.matched, 1);
  assert.match(r3.out[2].content[0].content, /matches in 12 files/);
});
await test('pinned bases are capped, keeping the most recent diffs protected', () => {
  const s = { fresh: new Map(), stubbed: new Map() };
  for (let i = 0; i < 12; i++) s.fresh.set('d' + i, { text: 'x', base: 'b' + i });
  const pinned = pinnedBases([], s);
  assert.equal(pinned.size, 8);
  assert.ok(pinned.has('b11') && pinned.has('b4'));
  assert.ok(!pinned.has('b3'), 'older bases may be paged again');
  s.stubbed.set('d11', { reason: 'stale', text: 'x' });
  assert.ok(!pinnedBases([], s).has('b11'), 'a diff that was itself paged stops pinning its base');
});

console.log('bash output hook');
await test('rewrites noisy commands to quiet equivalents, leaves pipelines and unknown commands alone', () => {
  assert.equal(rewriteCommand('git status'), 'git status --short --branch');
  assert.equal(rewriteCommand('git log'), 'git --no-pager log --oneline -n 30');
  assert.equal(rewriteCommand('git log --oneline -5'), 'git --no-pager log --oneline -5');
  assert.equal(rewriteCommand('git push origin main'), 'git push --quiet origin main');
  assert.equal(rewriteCommand('git push -q origin main'), null);
  assert.match(rewriteCommand('npm install'), /--no-fund --no-audit --loglevel=error/);
  assert.match(rewriteCommand('npm test'), /npm test --silent 2>&1 \| tail -n 60/);
  assert.match(rewriteCommand('pytest tests/x.py'), /pytest -q --no-header/);
  assert.equal(rewriteCommand('pytest -q'), null);
  assert.equal(rewriteCommand('cargo build --release'), 'cargo build -q --release');
  assert.equal(rewriteCommand('curl https://x'), 'curl -sS https://x');
  assert.equal(rewriteCommand('ls -la'), 'ls -la | head -n 100');
  assert.equal(rewriteCommand('git status | head'), null, 'pipelines are the user\'s own');
  assert.equal(rewriteCommand('rm -rf build && make'), null);
  assert.equal(rewriteCommand('echo $HOME'), null);
  assert.equal(rewriteCommand('node bin/ccpager.js status'), null);
  assert.equal(rewriteCommand(''), null); assert.equal(rewriteCommand(42), null);
});
await test('search and log commands get bounded, and ones already bounded are left alone', () => {
  assert.equal(rewriteCommand('rg TODO'), 'rg --max-columns=250 --max-count=200 TODO');
  assert.equal(rewriteCommand('rg --max-columns=100 TODO'), null);
  assert.equal(rewriteCommand('rg -l TODO'), null);
  assert.equal(rewriteCommand('grep -rn foo .'), 'grep --max-count=200 -rn foo .');
  assert.equal(rewriteCommand('grep -m 5 foo x'), null);
  assert.equal(rewriteCommand('git grep TODO'), 'git grep -n TODO');
  assert.equal(rewriteCommand('git grep -n TODO'), null);
  assert.equal(rewriteCommand('find . -name "*.ts"'), 'find . -name "*.ts" | head -n 200');
  assert.equal(rewriteCommand('find . -maxdepth 2'), null);
  assert.equal(rewriteCommand('docker logs web'), 'docker logs --tail 200 web');
  assert.equal(rewriteCommand('docker logs -n 50 web'), null);
  assert.equal(rewriteCommand('journalctl -u api'), 'journalctl -n 200 --no-pager -u api');
  assert.equal(rewriteCommand('journalctl -n 20 -u api'), null);
  assert.match(rewriteCommand('pytest tests/x.py'), /--tb=short/);
  const dup = rewriteCommand('pytest --tb=long tests/x.py');
  assert.equal((dup.match(/--tb/g) || []).length, 1, 'never adds a second --tb');
});
await test('handleHook answers Bash only, with updatedInput and no permission decision', () => {
  const out = handleHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status', description: 'x' } }));
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.deepEqual(out.hookSpecificOutput.updatedInput, { command: 'git status --short --branch', description: 'x' });
  assert.equal('permissionDecision' in out.hookSpecificOutput, false, 'never bypasses the permission prompt');
  assert.equal(handleHook({ tool_name: 'Read', tool_input: { file_path: 'x' } }), null);
  assert.equal(handleHook({ tool_name: 'Bash', tool_input: { command: 'cat x' } }), null);
  assert.equal(handleHook('not json'), null);
});
await test('installHook adds one PreToolUse entry, is idempotent, keeps other hooks, and removes cleanly', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccpager-')), 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ env: { A: '1' }, hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'other' }] }], Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }));
  installHook({ file, command: 'ccpager hook run' }); installHook({ file, command: 'ccpager hook run' });
  let s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(s.hooks.PreToolUse.length, 2); assert.equal(s.env.A, '1'); assert.equal(s.hooks.Stop.length, 1);
  assert.equal(hookInstalled(file), true);
  installHook({ file, remove: true });
  s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(s.hooks.PreToolUse.length, 1); assert.equal(s.hooks.PreToolUse[0].matcher, 'Write');
  assert.equal(hookInstalled(file), false);
});

console.log('updates');
await test('version comparison and release parsing', () => {
  assert.equal(compareVersions('0.6.0', '0.5.9'), 1); assert.equal(compareVersions('v0.6.0', '0.6.0'), 0);
  assert.equal(compareVersions('0.6.0', '0.10.0'), -1); assert.equal(compareVersions('1.0.0-rc1', '1.0.0'), -1);
  const rel = { tag_name: 'v9.9.9', html_url: 'https://x/rel', body: '## Notes\n- thing', assets: [{ name: 'ccpager_9.9.9_all.deb', browser_download_url: 'https://x/d.deb', size: 5 }, { name: 'SHA256SUMS', browser_download_url: 'https://x/s' }] };
  const p = parseRelease(rel, '0.6.0');
  assert.equal(p.newer, true); assert.equal(p.latest, '9.9.9'); assert.equal(p.deb.name, 'ccpager_9.9.9_all.deb'); assert.equal(p.sums, 'https://x/s');
  assert.equal(parseRelease({ tag_name: 'v0.1.0' }, '0.6.0').newer, false);
  assert.equal(parseRelease({}), null);
  assert.equal(installKind(os.tmpdir()), 'manual');
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});
await test('checkForUpdate caches for a day, forces on demand, and degrades to the cache offline', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpager-'));
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: true, json: async () => ({ tag_name: 'v99.0.0', html_url: 'u', assets: [] }) }; };
  const a = await checkForUpdate({ dataDir, fetchImpl, now: 1000 });
  assert.equal(a.newer, true); assert.equal(a.cached, false); assert.equal(calls, 1);
  const b = await checkForUpdate({ dataDir, fetchImpl, now: 2000 });
  assert.equal(b.cached, true); assert.equal(calls, 1);
  await checkForUpdate({ dataDir, fetchImpl, now: 2000, force: true }); assert.equal(calls, 2);
  const c = await checkForUpdate({ dataDir, fetchImpl, now: 1000 + 25 * 3600e3 }); assert.equal(c.cached, false); assert.equal(calls, 3);
  const down = await checkForUpdate({ dataDir, fetchImpl: async () => { throw new Error('offline'); }, force: true });
  assert.equal(down.error, 'offline'); assert.equal(down.latest, '99.0.0'); assert.equal(down.cached, true);
  const fresh = await checkForUpdate({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ccpager-')), fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(fresh.latest, null); assert.equal(fresh.newer, false); assert.equal(fresh.error, 'offline');
});
await test('CLI: version, update --check against a mock release endpoint, status shows the update', async () => {
  const srv = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ tag_name: 'v99.0.0', html_url: 'https://example/rel', body: 'big news', assets: [] })); }).listen(0);
  await new Promise((r) => srv.once('listening', r));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpager-'));
  const env = { ...process.env, CCPAGER_HOME: dataDir, CCPAGER_PORT: '18999', HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'home-')), CCPAGER_UPDATE_URL: `http://127.0.0.1:${srv.address().port}/latest` };
  // The mock server lives in this process, so the CLI must run asynchronously or it never gets served.
  const cli = (...a) => new Promise((resolve, reject) => execFile(process.execPath, ['bin/ccpager.js', ...a], { env, encoding: 'utf8' }, (e, out, err) => e ? reject(new Error(err || e.message)) : resolve(out)));
  assert.match(await cli('version'), /^ccpager \d+\.\d+\.\d+ \((git|deb|manual) install\)/);
  assert.match(await cli('update', '--check'), /Version 99\.0\.0 is available/);
  const j = JSON.parse((await cli('update', '--check', '--json')).trim().split('\n').pop());
  assert.equal(j.newer, true); assert.equal(j.cached, true);
  assert.match(await cli('status'), /version   \d+\.\d+\.\d+ \(\w+\) · 99\.0\.0 available: run `ccpager update`/);
  const st = JSON.parse((await cli('status', '--json')).trim().split('\n').pop());
  assert.equal(st.update.latest, '99.0.0'); assert.equal(st.restartNeeded, false);
  assert.match(await cli('off', 'updates'), /updates off/);
  assert.equal(JSON.parse((await cli('status', '--json')).trim().split('\n').pop()).update, null, 'notice hidden when checks are off');
  srv.close();
});

console.log('pricing & savings');
await test('per-model prices, Haiku long-context tier, unknown model falls back', () => {
  assert.equal(priceFor('claude-opus-5-5-20261001').input, 4);
  assert.equal(priceFor('claude-sonnet-5').read, 0.2);
  assert.equal(priceFor('claude-fable-5-2').input, 8);
  assert.equal(priceFor('claude-fable-5-2').read, 0.2);
  assert.equal(priceFor('claude-mythos-5-2').output, 40);
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
await test('savings are priced for what they avoided: a first elision at the write rate, everything else at the read rate', () => {
  const u = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 4_000_000,
    cache_creation: { ephemeral_5m_input_tokens: 4_000_000, ephemeral_1h_input_tokens: 0 } };
  const tok = 25_000;
  const paged = costOf('claude-opus-5-5', u, tok);                        // old history: a cache read
  const wrote = costOf('claude-opus-5-5', u, tok, { writeTokens: tok });   // elided this turn: a cache write
  const replay = costOf('claude-opus-5-5', u, tok, { writeTokens: 0 });    // same stub next turn: a read again
  assert.equal(+paged.savedLow.toFixed(4), 0.005);
  assert.equal(+wrote.savedLow.toFixed(4), 0.125);
  assert.equal(replay.savedLow, paged.savedLow, 'a replayed trim is worth a cache read, not the write again');
  assert.equal(Math.round(wrote.savedLow / paged.savedLow), 25, 'a write token is worth 25 read tokens on a 5m cache');
  const u1h = { ...u, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 4_000_000 } };
  assert.equal(+costOf('claude-opus-5-5', u1h, tok, { writeTokens: tok }).savedLow.toFixed(3), 0.2, '40x on a 1h cache');
  const mixed = costOf('claude-opus-5-5', u, 25_000, { writeTokens: 15_000 });
  assert.equal(+mixed.savedLow.toFixed(4), 0.077, '10k read-rate + 15k write-rate');
  assert.equal(+mixed.savedHigh.toFixed(4), 0.115);
  for (const c of [paged, wrote, mixed]) assert.ok(c.savedHigh >= c.savedLow, 'the "if uncached" ceiling is a real upper bound');
  // No cache write at all (TTL off, or a prompt too short to cache): the removed token was input.
  const noCache = { input_tokens: 100_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  assert.equal(+costOf('claude-opus-5-5', noCache, tok, { writeTokens: tok }).savedLow.toFixed(4), 0.1,
    'priced as the fresh input it would have been, not as a write that never happened');
});

console.log('helper sessions, terse caps, digest stubs and the baseline');
await test('digest stubs: deterministic, keep head/errors/tail, and are hard-capped', () => {
  const text = ['$ npm test', ...Array.from({ length: 500 }, (_, i) => `ok ${i} - suite ${i % 7}`),
    'FAIL src/auth/session.test.ts > refreshes an expired token',
    'AssertionError: expected 401 to be 200',
    '    at Object.<anonymous> (src/auth/session.test.ts:42:11)',
    ...Array.from({ length: 60 }, (_, i) => `  noise ${i}`),
    'Tests: 1 failed, 412 passed, 413 total'].join('\n');
  const block = { type: 'tool_result', tool_use_id: 't1', content: text };
  const use = { name: 'Bash', input: { command: 'npm test' } };
  const a = digestOf(block, use, text.length, 'stale');
  const b = digestOf(block, use, text.length, 'stale');
  assert.equal(a, b, 'byte-identical replay is what keeps the cache intact');
  assert.ok(a.length <= 700, `digest is capped (was ${a.length})`);
  assert.match(a, /^\[ccpager: paged out — Bash npm test, \d+ chars, stale/);
  assert.match(a, /FAIL src\/auth\/session\.test\.ts/);
  assert.match(a, /AssertionError: expected 401 to be 200/);
  assert.match(a, /Tests: 1 failed, 412 passed/);
  assert.match(a, /more line\(s\) elided/);
  const small = { type: 'tool_result', tool_use_id: 't2', content: 'one\ntwo' };
  assert.match(digestOf(small, use, 7, 'stale'), /first line: one/, 'small results keep the one-liner');
});
await test('a stub is frozen to the bytes first sent, even as the session continues', () => {
  const s = newSession();
  const first = pageRequest(agentic(30), smart, s, 0).body;
  const stub = results(first)[0].content;
  assert.match(stub, /^\[ccpager: paged out/);
  assert.ok(stub.length > 200, 'a 5000-char result gets a digest, not one line');
  const later = pageRequest(agentic(38), smart, s, 2000).body;
  assert.equal(results(later)[0].content, stub);
});
await test('classify: only subagent system prompts are helpers', () => {
  assert.equal(classify({ system: "You are Claude Code, Anthropic's official CLI for Claude.", messages: [{ role: 'user', content: 'hi' }] }).kind, 'main');
  assert.equal(classify({ system: [{ type: 'text', text: "You are an agent for Claude Code, Anthropic's official CLI." }] }).kind, 'helper');
  assert.equal(classify({ system: 'You are a file search specialist for Claude Code.' }).marker, 'file-search specialist');
  assert.equal(classify({ messages: [{ role: 'user', content: 'You are an agent for Claude Code' }] }).kind, 'main', 'user text is never a classification signal');
});
await test('helper routing: downgrades a marked session once, sticks, leaves main and small models alone', () => {
  const cfg = { paging: false, cacheTtl: 'off', routing: false, protect: true, protectAt: 80, protectModel: 'claude-sonnet-5-5',
    helperRouting: true, helperModel: 'claude-haiku-5-5', terseHelper: false, helperMaxTokens: 8000, helperThinkTokens: 4000 };
  const helperBody = { model: 'claude-opus-5-5', system: 'You are a file search specialist for Claude Code.', messages: [{ role: 'user', content: 'find the auth code' }] };
  const s = newSession(); s.kind = 'helper';   // the gateway classifies the session when it first sees it
  const r = transform(helperBody, cfg, s, { active: false });
  assert.equal(r.body.model, 'claude-haiku-5-5');
  assert.equal(r.report.routed.why, 'helper');
  s.lastAt = 1;
  const later = { ...helperBody, messages: [...helperBody.messages, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'more' }] };
  assert.equal(transform(later, cfg, s, { active: false }).body.model, 'claude-haiku-5-5', 'sticky for the session');
  const main = { model: 'claude-opus-5-5', system: 'You are Claude Code.', messages: [{ role: 'user', content: 'hello' }] };
  assert.equal(transform(main, cfg, newSession(), { active: false }).body.model, 'claude-opus-5-5');
  assert.equal(transform({ ...helperBody, model: 'claude-sonnet-5-5' }, cfg, newSession(), { active: false }).body.model, 'claude-sonnet-5-5');
  assert.equal(transform(helperBody, { ...cfg, helperRouting: false }, newSession(), { active: false }).body.model, 'claude-opus-5-5');
});
await test('terse: one cached system block, identical next time, caps output and thinking', () => {
  const cfg = { terseHelper: true, helperMaxTokens: 8000, helperThinkTokens: 4000 };
  const body = { model: 'claude-opus-5-5', max_tokens: 32000, thinking: { type: 'enabled', budget_tokens: 12000 },
    system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } }], messages: [] };
  const s = { kind: 'helper' };
  const a = applyTerse(body, cfg, s);
  assert.equal(a.max_tokens, 8000);
  assert.equal(a.thinking.budget_tokens, 4000);
  assert.equal(a.system.length, 2);
  assert.equal(a.system[0].cache_control, undefined, 'the breakpoint moves onto the terse block');
  assert.ok(a.system[1].cache_control, 'so the terse text is cached too');
  assert.match(a.system[1].text, /Output style: terse/);
  assert.equal(applyTerse(a, cfg, s), a, 'idempotent: the same bytes on every request');
  assert.equal(body.system[0].cache_control.ttl, '1h', 'the cached block itself is never edited');
  assert.equal(applyTerse({ ...body, system: 'sys' }, cfg, { kind: 'main' }).max_tokens, 32000);
  assert.equal(applyTerse(body, { ...cfg, terseHelper: false }, s).max_tokens, 32000);
});
await test('session keys survive <env> churn and tell different agent toolsets apart', () => {
  const S = new Sessions();
  const mk = (env, tool) => ({ system: 'sys', tools: [{ name: tool }], metadata: { user_id: 'u1' },
    messages: [{ role: 'user', content: `<env>${env}</env>\nfix the bug ${'x'.repeat(300)}` }] });
  assert.equal(S.key(mk('cwd=/a', 'Read')), S.key(mk('cwd=/b platform=linux', 'Read')),
    'a changing environment block must not start a new session');
  assert.notEqual(S.key(mk('cwd=/a', 'Read')), S.key(mk('cwd=/a', 'Grep')), 'a different toolset is a different agent');
});
await test('stats keep the on and off sides apart, with output and rounds, so a baseline is comparable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpager-stats-'));
  const st = new Stats(dir);
  const u = { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 5 };
  st.record({ pagedBlocks: 1, charsSaved: 40, rounds: 1 });
  st.usage(u, { model: 'claude-opus-5-5', rounds: 1 });
  st.record({ pagedBlocks: 0, charsSaved: 0, rounds: 0, off: true });
  st.usage(u, { model: 'claude-opus-5-5', off: true, rounds: 0 });
  st.flush();
  const d = JSON.parse(fs.readFileSync(path.join(dir, 'stats.json'), 'utf8'));
  const day = d.byDay[new Date().toISOString().slice(0, 10)];
  assert.equal(day.onRequests, 1); assert.equal(day.offRequests, 1);
  assert.equal(day.onPromptTokens, 130); assert.equal(day.offPromptTokens, 130);
  assert.equal(day.onOutput, 5); assert.equal(day.offOutput, 5);
  assert.equal(day.onRounds, 1); assert.equal(day.offRounds, 0);
});
await test('a fresh-trimmed request books write-rate money in the buckets, a paged one the read rate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpager-stats-'));
  const st = new Stats(dir);
  const u = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 400_000 };
  st.usage(u, { model: 'claude-opus-5-5', charsSaved: 100_000, writeChars: 100_000 });  // first elision: a write
  st.usage(u, { model: 'claude-opus-5-5', charsSaved: 100_000 });                        // replayed stub: a read
  st.usage(u, { model: 'claude-opus-5-5', charsSaved: 100_000 });                        // paged history: a read
  const day = st.data.byDay[new Date().toISOString().slice(0, 10)];
  assert.equal(+day.savedLow.toFixed(4), 0.135, '$0.125 write + $0.005 replayed read + $0.005 paged read');
  assert.ok(day.savedLow < 0.2, 'the replayed stub was not booked as a second cache write');
  assert.ok(day.savedHigh >= day.savedLow, 'ceiling still above value saved once the three are mixed');
});
await test('a fresh trim books as a cache write once, then as a cache read while it is replayed', () => {
  const hits = Array.from({ length: 300 }, (_, i) => `src/feature${i % 9}.ts:${i + 1}:export const value${i} = ${i};`).join('\n');
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'value', path: 'src' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: hits }] },
  ];
  const s = { fresh: new Map() };
  const first = compressFresh(messages, s, {});
  assert.ok(first.charsSaved > 0, 'the hit list was summarised');
  assert.equal(first.writeChars, first.charsSaved, 'on the request that elides it, the saving is a cache write');
  const again = compressFresh(messages, s, {});      // the same messages again, decision reused
  assert.equal(again.charsSaved, first.charsSaved, 'the same characters stay out of the prompt');
  assert.equal(again.writeChars, 0, 'but nothing new was elided, so no write is avoided a second time');
});

console.log('cli');
await test('on/off/status/stats commands', () => {
  const env = { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'home-')), CCPAGER_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-')), CCPAGER_PORT: '18765' };
  const cli = (...a) => execFileSync(process.execPath, ['bin/ccpager.js', ...a], { env, encoding: 'utf8' });
  assert.match(cli('off'), /OFF: requests now pass through unchanged/);
  assert.match(cli('on', 'routing'), /ON  paging on · fresh on · inputs on · cache off · routing on · protect on · updates on/); // 1h upgrade is off by default
  assert.match(cli('on', 'cache'), /cache 1h/);
  assert.match(cli('off', 'cache'), /cache off/);
  assert.throws(() => execFileSync(process.execPath, ['bin/ccpager.js', 'off', 'bogus'], { env, encoding: 'utf8', stdio: 'pipe' }));
  assert.match(cli('status'), /mode      ON  paging on · fresh on · inputs on · cache off · routing on · protect on · updates on/);
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
