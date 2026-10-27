// Simulate this machine's workload through ccpager's pager with real Anthropic caching rules,
// to compare paging policies by API-equivalent cost (which is also the best available proxy for
// subscription limit consumption: cache reads count ~nothing, writes ~like uncached input).
//
// Usage: node test/bench.js [src-dir]   (EXTRA='{"name":{"page":true,"opts":{...}}}' adds policies)
import path from 'node:path';
const SRC = process.argv[2] || new URL("../src/", import.meta.url).pathname;
const { pageRequest } = await import(path.join(SRC, 'pager.js'));
const { priceFor } = await import(path.join(SRC, 'pricing.js'));

const MODEL = 'claude-opus-5-5';
const P = priceFor(MODEL);
const CPT = 4;
const SYSTEM_TOKENS = 25_000;          // system prompt + tools, cached, never changes
const COMPACT_AT = 180_000;            // Claude Code auto-compacts around here on a 200k window
const COMPACT_KEEP = 20_000;           // context after compaction (summary + recent)

function mulberry(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

/** One Claude Code session: a typed prompt then `steps` tool rounds; tool outputs of varied size. */
function* session(steps, rnd, { thinkTok = 300, rereadRate = 0.15 } = {}) {
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'please fix the thing ' + 'x'.repeat(400) }] }];
  const files = [];
  for (let i = 0; i < steps; i++) {
    // log-normal-ish tool output: mostly 1-6k chars, occasional 30-80k dumps
    const r = rnd();
    const chars = r < 0.6 ? 800 + rnd() * 5000 : r < 0.92 ? 6000 + rnd() * 12000 : 30_000 + rnd() * 50_000;
    const reread = files.length && rnd() < rereadRate;
    const file = reread ? files[Math.floor(rnd() * files.length)] : `src/f${i}.ts`;
    if (!reread) files.push(file);
    messages.push({ role: 'assistant', content: [{ type: 'thinking', thinking: 't'.repeat(thinkTok * CPT), signature: 's' + i }, { type: 'text', text: 'ok '.repeat(40) }, { type: 'tool_use', id: 'tu' + i, name: 'Read', input: { file_path: file } }] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu' + i, content: `// ${file}\n` + 'y'.repeat(Math.round(chars)) }] });
    yield { model: MODEL, messages: messages.map((m) => m) };
  }
}

/** Serialise a request the way the cache sees it: system + each message as a chunk. */
const chunks = (body) => [{ k: 'sys', tok: SYSTEM_TOKENS }, ...body.messages.map((m) => ({ k: JSON.stringify(m), tok: JSON.stringify(m).length / CPT }))];

/**
 * Run a session through a policy with real caching: the cached prefix is the longest common
 * prefix of chunks with the previous request (if within ttl); the rest is written.
 * Returns cost in USD and token categories. Models compaction: when total context passes
 * COMPACT_AT, a summary request is billed and the conversation restarts cold at COMPACT_KEEP.
 */
function run(policy, steps, seed, { ttl = '1h', idleEvery = 0, idleMin = 70 } = {}) {
  const rnd = mulberry(seed);
  const opts = { keepRecentTurns: 6, pageStep: 8, minPageChars: 1200, pagingMode: 'smart', cacheTtl: ttl, ...policy.opts };
  const sess = { stubbed: new Map(), boundary: 0, lastAt: null };
  let prev = null, t = 0, compactions = 0, offset = 0;
  const tot = { read: 0, write: 0, input: 0, out: 0, cost: 0, requests: 0, promptTokens: 0, moves: 0 };
  const writeRate = ttl === '1h' ? P.write1h : P.write5m;
  const ttlMs = (ttl === '1h' ? 60 : 5) * 60_000;
  let i = 0;
  for (const body of session(steps, rnd)) {
    i++;
    if (idleEvery && i % idleEvery === 0) t += idleMin * 60_000; else t += 20_000;
    let req = body;
    if (policy.page) {
      // after a compaction the earlier messages are gone: emulate by dropping them
      const r = pageRequest({ ...body, messages: body.messages.slice(offset) }, opts, policy.stateless ? null : sess, t);
      req = r.body; if (r.stats.moved) tot.moves++;
    } else if (offset) req = { ...body, messages: body.messages.slice(offset) };
    const cur = chunks(req);
    let common = 0;
    if (prev && t - prev.t <= ttlMs) while (common < cur.length && common < prev.c.length && cur[common].k === prev.c[common].k) common++;
    const readTok = cur.slice(0, common).reduce((n, c) => n + c.tok, 0);
    const writeTok = cur.slice(common).reduce((n, c) => n + c.tok, 0);
    const outTok = 500;
    tot.read += readTok; tot.write += writeTok; tot.out += outTok; tot.requests++; tot.promptTokens += readTok + writeTok;
    tot.cost += (readTok * P.read + writeTok * writeRate + outTok * P.output) / 1e6;
    prev = { c: cur, t };
    if (readTok + writeTok > COMPACT_AT) { // auto-compaction: summary call, then a cold small context
      compactions++;
      tot.cost += ((readTok + writeTok) * P.read + 3000 * P.output) / 1e6;
      offset = body.messages.length - 1; // keep only the tail; next request starts a fresh session
      sess.stubbed = new Map(); sess.boundary = 0; sess.lastAt = null; prev = null;
      tot.write += COMPACT_KEEP; tot.cost += COMPACT_KEEP * writeRate / 1e6;
    }
  }
  return { ...tot, compactions };
}

const POLICIES = {
  off:        { page: false },
  smart:      { page: true, opts: {} },                               // current code, current defaults on this machine
  always:     { page: true, opts: { pagingMode: 'always' } },
  ...(process.env.EXTRA ? JSON.parse(process.env.EXTRA) : {}),
};

const scenarios = [
  { name: 'long session, warm cache (1h ttl)', steps: 200, ttl: '1h' },
  { name: 'long session, warm cache (5m ttl)', steps: 200, ttl: '5m' },
  { name: 'long session, 70-min break every 40 steps (1h ttl)', steps: 200, ttl: '1h', idleEvery: 40 },
  { name: 'medium session (60 steps), 1h ttl', steps: 60, ttl: '1h' },
];
const fmt = (n) => n.toFixed(2).padStart(8);
for (const sc of scenarios) {
  console.log(`\n== ${sc.name}`);
  console.log(`  ${'policy'.padEnd(12)} ${'cost$'.padStart(8)} ${'vs off'.padStart(8)} ${'promptM'.padStart(8)} ${'writeM'.padStart(8)} ${'compact'.padStart(8)} ${'moves'.padStart(6)}`);
  let base;
  for (const [name, pol] of Object.entries(POLICIES)) {
    let agg = { cost: 0, promptTokens: 0, write: 0, compactions: 0, moves: 0 };
    const seeds = [1, 2, 3, 4, 5];
    for (const s of seeds) { const r = run(pol, sc.steps, s, sc); for (const k in agg) agg[k] += r[k] / seeds.length; }
    base ??= agg.cost;
    console.log(`  ${name.padEnd(12)} ${fmt(agg.cost)} ${((agg.cost / base - 1) * 100).toFixed(0).padStart(7)}% ${fmt(agg.promptTokens / 1e6)} ${fmt(agg.write / 1e6)} ${fmt(agg.compactions)} ${String(agg.moves.toFixed(1)).padStart(6)}`);
  }
}
