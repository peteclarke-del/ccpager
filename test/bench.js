// Simulate this machine's workload through ccpager's pager with real Anthropic caching rules, to
// compare policies by API-equivalent cost — which is also the best available proxy for subscription
// limit consumption, since cache reads count ~nothing and cache writes count like fresh input.
//
// Cost is only half the question. A policy that removes tokens but forces the model to re-run tools
// has not saved anything: a re-run is an extra tool round (an output turn plus a full-size cache
// write). So this bench prices output tokens, and charges a re-run for every cutoff move at a given
// rate. The rate is an ASSUMPTION, not a measurement, so it is swept: a conclusion that only holds at
// one guessed rate is not a conclusion.
//
// Usage: node test/bench.js [src-dir]   (EXTRA='{"name":{"page":true,"opts":{...}}}' adds policies)
import path from 'node:path';
const SRC = process.argv[2] || new URL('../src/', import.meta.url).pathname;
const { pageRequest } = await import(path.join(SRC, 'pager.js'));
const { priceFor } = await import(path.join(SRC, 'pricing.js'));
const { compressFresh } = await import(path.join(SRC, 'fresh.js'));

const MODEL = 'claude-opus-5-5';
const HELPER_MODEL = 'claude-sonnet-5-5';
const CPT = 4;                          // chars per token, the same estimate the gateway uses
const SYSTEM_TOKENS = 25_000;           // system prompt + tools, cached, never changes
const COMPACT_AT = 180_000;             // Claude Code auto-compacts around here on a 200k window
const COMPACT_KEEP = 20_000;            // context after compaction (summary + recent)
const OUT_TOK = 500;                    // assistant text + thinking per request
// Chance that a cutoff move costs one re-run. One-line stubs keep only the first line; digests keep
// the head, error-ish lines and the tail, so they are assumed to need re-runs far less often.
const RERUN = { digest: 0.10, budget: 0.15, matches: 0.10 };
// ASSUMPTION, not a measurement: how much of a helper session's output the terse directive removes.
// It is the one saving in the gateway that depends entirely on model behaviour, so it is swept below
// rather than trusted: at 0% the directive is pure overhead, and the cost curve says what each point
// of reduction is worth.
const TERSE_CUT = 0.25;

function mulberry(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

/** One Claude Code session: a typed prompt then `steps` tool rounds; tool outputs of varied size. */
function* session(steps, rnd, { thinkTok = 300, rereadRate = 0.15, grepRate = 0.25, logRate = 0.10 } = {}) {
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'please fix the thing ' + 'x'.repeat(400) }] }];
  const files = [];
  for (let i = 0; i < steps; i++) {
    const r = rnd();
    const chars = r < 0.6 ? 800 + rnd() * 5000 : r < 0.92 ? 6000 + rnd() * 12000 : 30_000 + rnd() * 50_000;
    const reread = files.length && rnd() < rereadRate;
    const file = reread ? files[Math.floor(rnd() * files.length)] : `src/f${i}.ts`;
    if (!reread) files.push(file);
    const roll = rnd();
    let name, input, content;
    if (roll < logRate) {                       // a test/build log: thousands of mechanical lines
      name = 'Bash'; input = { command: `npm test --step ${i}` };
      const n = 1500 + Math.round(rnd() * 3500);
      content = Array.from({ length: n }, (_, k) => `ok ${k} - case ${k % 41} (${file})`).join('\n')
        + (i % 3 === 0 ? '\nFAIL src/x.test.ts > case 7\nAssertionError: expected 1 to be 2' : '')
        + `\nTests: ${i % 3 === 0 ? '1 failed,' : ''} ${n} passed`;
    } else if (roll < logRate + grepRate) {     // a grep hit list: many matches across many files
      name = 'Grep'; input = { pattern: `token${i}` };
      const hits = 60 + Math.round(rnd() * 400);
      content = Array.from({ length: hits }, (_, k) => `src/m${k % 25}.ts:${k + 1}:  token${i} = ${k};`).join('\n');
    } else {
      name = 'Read'; input = { file_path: file };
      content = `// ${file}\n` + 'y'.repeat(Math.round(chars));
    }
    messages.push({ role: 'assistant', content: [{ type: 'thinking', thinking: 't'.repeat(thinkTok * CPT), signature: 's' + i }, { type: 'text', text: 'ok '.repeat(40) }, { type: 'tool_use', id: 'tu' + i, name, input }] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu' + i, content }] });
    yield { model: MODEL, messages: messages.map((m) => m) };
  }
}

/** Serialise a request the way the cache sees it: system + each message as a chunk. */
const chunks = (body) => [{ k: 'sys', tok: SYSTEM_TOKENS }, ...body.messages.map((m) => ({ k: JSON.stringify(m), tok: JSON.stringify(m).length / CPT }))];

/**
 * Run a session through a policy with real caching and compaction.
 * sc: { ttl, idleEvery, idleMin, model, rerun }
 */
function run(policy, steps, seed, sc = {}) {
  const { ttl = '1h', idleEvery = 0, idleMin = 70, model = MODEL, outTok = OUT_TOK } = sc;
  const P = priceFor(model);
  const rerunRate = sc.rerun ?? RERUN.digest;
  const budgetRate = sc.rerunBudget ?? RERUN.budget;
  const matchRate = sc.rerunMatches ?? RERUN.matches;
  const rnd = mulberry(seed);
  // Re-run decisions draw from their own stream: sharing `rnd` would make the re-run rate change
  // which tool outputs the session generates, so policies could no longer be compared at all.
  const rndRerun = mulberry(seed * 7919 + 13);
  const opts = { keepRecentTurns: 4, pageStep: 8, minPageChars: 1200, pagingMode: 'smart', cacheTtl: ttl, ...policy.opts };
  const sess = { stubbed: new Map(), fresh: new Map(), boundary: 0, lastAt: null };
  const rndFresh = mulberry(seed * 104729 + 7);
  let prev = null, t = 0, offset = 0, prevPaged = 0;
  const tot = { read: 0, write: 0, out: 0, cost: 0, requests: 0, promptTokens: 0, moves: 0, reruns: 0, compactions: 0, trims: 0 };
  const writeRate = ttl === '1h' ? P.write1h : P.write5m;
  const ttlMs = (ttl === '1h' ? 60 : 5) * 60_000;
  const chargeRerun = (rndFn) => {
    const extraTok = (6000 + rndFn() * 12000) / CPT;
    tot.reruns++; tot.requests++; tot.write += extraTok; tot.out += outTok; tot.promptTokens += extraTok + outTok;
    tot.cost += (extraTok * writeRate + outTok * P.output) / 1e6;
  };
  let i = 0;
  for (const body of session(steps, rnd)) {
    i++;
    if (idleEvery && i % idleEvery === 0) t += idleMin * 60_000; else t += 20_000;
    const base = offset ? { ...body, messages: body.messages.slice(offset) } : body;
    let req = base, stats = { moved: false, pagedBlocks: 0 };
    if (policy.page) {
      const r = pageRequest(base, opts, policy.stateless ? null : sess, t);
      req = r.body; stats = r.stats; if (r.stats.moved) tot.moves++;
    }
    // The fresh stage shrinks the newest result before it is ever written to the cache. That is the
    // expensive part of a turn, so this is where a trim pays off — if it does not cost a re-run.
    if (policy.fresh) {
      const f = compressFresh(req.messages, sess, { rereadDiff: false, budget: policy.freshBudget ?? 24000, matches: policy.freshMatches !== false });
      if (f.freshBlocks) req = { ...req, messages: f.out };
      if (f.budgeted && rndFresh() < budgetRate) chargeRerun(rndFresh);
      if (f.matched && rndFresh() < matchRate) chargeRerun(rndFresh);
      tot.trims += (f.budgeted || 0) + (f.matched || 0);
    }
    const newly = Math.max(0, (stats.pagedBlocks || 0) - prevPaged);
    prevPaged = stats.pagedBlocks || 0;
    const cur = chunks(req);
    let common = 0;
    if (prev && t - prev.t <= ttlMs) while (common < cur.length && common < prev.c.length && cur[common].k === prev.c[common].k) common++;
    const readTok = cur.slice(0, common).reduce((n, c) => n + c.tok, 0);
    const writeTok = cur.slice(common).reduce((n, c) => n + c.tok, 0);
    tot.read += readTok; tot.write += writeTok; tot.out += outTok; tot.requests++; tot.promptTokens += readTok + writeTok;
    tot.cost += (readTok * P.read + writeTok * writeRate + outTok * P.output) / 1e6;
    prev = { c: cur, t };
    // A move that removed content the model needed costs one extra tool round.
    if (newly > 0 && rndRerun() < rerunRate) chargeRerun(rndRerun);
    if (readTok + writeTok > COMPACT_AT) { // auto-compaction: summary call, then a cold small context
      tot.compactions++;
      tot.cost += ((readTok + writeTok) * P.read + 3000 * P.output) / 1e6;
      offset = body.messages.length - 1;
      sess.stubbed = new Map(); sess.fresh = new Map(); sess.boundary = 0; sess.lastAt = null;
      prev = null; prevPaged = 0;
      tot.write += COMPACT_KEEP; tot.cost += COMPACT_KEEP * writeRate / 1e6;
    }
  }
  return tot;
}

// `helper: true` is what the gateway actually does now (helper routing is on by default), so a
// scenario with helper subagents mixes Opus main sessions with Sonnet helper sessions for these
// policies and not for `off`. That mix is where the model tier, not paging, does the work.
const POLICIES = {
  off:       { page: false },
  page:      { page: true, helper: true, terse: true },                            // no fresh trims
  fresh24:   { page: true, helper: true, terse: true, fresh: true },               // shipping default
  fresh12:   { page: true, helper: true, terse: true, fresh: true, freshBudget: 12000 },  // is the threshold immaterial?
  noMatches: { page: true, helper: true, terse: true, fresh: true, freshMatches: false },
  ...(process.env.EXTRA ? JSON.parse(process.env.EXTRA) : {}),
};

const scenarios = [
  { name: 'long session, warm cache (1h ttl)', steps: 200, ttl: '1h' },
  { name: 'long session, warm cache (5m ttl)', steps: 200, ttl: '5m' },
  { name: 'long session, 70-min break every 40 steps (1h ttl)', steps: 200, ttl: '1h', idleEvery: 40 },
  { name: 'medium session (60 steps), 1h ttl', steps: 60, ttl: '1h' },
  { name: 'mixed: 60% main on Opus + 40% helper subagents on Sonnet', steps: 200, ttl: '1h', helperShare: 0.4 },
  { name: 'helper-heavy: 30% main + 70% helper subagents', steps: 200, ttl: '1h', helperShare: 0.7 },
];

/** Average a policy over seeds, weighting main and helper sessions when the scenario says so. */
function aggregate(policy, sc) {
  const seeds = sc.seeds || [1, 2, 3];
  const cut = policy.terse ? (sc.terseCut ?? TERSE_CUT) : 0;
  const one = (model, outTok) => {
    const agg = { cost: 0, promptTokens: 0, write: 0, read: 0, out: 0, requests: 0, moves: 0, reruns: 0, compactions: 0, trims: 0 };
    for (const s of seeds) { const r = run(policy, sc.steps, s, { ...sc, model, outTok }); for (const k in agg) agg[k] += r[k] / seeds.length; }
    return agg;
  };
  const main = one(MODEL, OUT_TOK);
  const share = sc.helperShare || 0;
  if (!share || !policy.helper) return main;   // without helper routing every session stays on Opus
  // Only helper sessions carry the terse directive, so only their output shrinks.
  const helper = one(HELPER_MODEL, OUT_TOK * (1 - cut));
  const mix = {};
  for (const k in main) mix[k] = main[k] * (1 - share) + helper[k] * share;
  return mix;
}

const fmt = (n) => n.toFixed(2).padStart(9);
console.log(`assumptions: output ${OUT_TOK} tok/request · terse cut ${Math.round(100 * TERSE_CUT)}% of helper output · re-run chance per move ${RERUN.digest} · per fresh trim ${RERUN.budget} (budget) / ${RERUN.matches} (matches) · ${SYSTEM_TOKENS / 1000}k cached system prompt`);
for (const sc of scenarios) {
  console.log(`\n== ${sc.name}`);
  console.log(`  ${'policy'.padEnd(10)} ${'cost$'.padStart(9)} ${'vs off'.padStart(8)} ${'promptM'.padStart(9)} ${'writeM'.padStart(9)} ${'outM'.padStart(9)} ${'rerun'.padStart(7)} ${'trim'.padStart(6)} ${'compact'.padStart(8)} ${'moves'.padStart(6)} ${'work/$'.padStart(8)}`);
  let base;
  for (const [name, pol] of Object.entries(POLICIES)) {
    const agg = aggregate(pol, sc);
    base ??= agg.cost;
    const work = agg.cost > 0 ? base / agg.cost : 1;
    console.log(`  ${name.padEnd(10)} ${fmt(agg.cost)} ${((agg.cost / base - 1) * 100).toFixed(0).padStart(7)}% ${fmt(agg.promptTokens / 1e6)} ${fmt(agg.write / 1e6)} ${fmt(agg.out / 1e6)} ${fmt(agg.reruns)} ${fmt(agg.trims)} ${fmt(agg.compactions)} ${String(agg.moves.toFixed(1)).padStart(6)} ${work.toFixed(2).padStart(7)}×`);
  }
}

// Does the digest conclusion survive other re-run rates? It must, or it is not a conclusion.
console.log('\n== sensitivity: at different paging re-run rates (long session, 1h)');
const sweep = [0, 0.15, 0.4];
console.log(`  ${'policy'.padEnd(10)} ${sweep.map((r) => `${(100 * r).toFixed(0)}%`.padStart(10)).join('')}`);
for (const name of ['page', 'fresh24', 'fresh12']) {
  const row = sweep.map((rerun) => {
    const agg = aggregate(POLICIES[name], { name: 'sweep', steps: 200, ttl: '1h', rerun });
    return fmt(agg.cost) + '  ';
  });
  console.log(`  ${name.padEnd(10)} ${row.join('')}`);
}
console.log('\n  The fresh trims above are charged at their own assumed rates, held constant. Does the');
console.log('  conclusion survive other rates? Sweep them too, then find the break-even:');
console.log('\n== sensitivity: fresh trims at different re-run rates (long session, 1h)');
const sweepBase = { name: 'sweep', steps: 200, ttl: '1h' };
const memo = new Map();
const at = (policy, rate) => {
  const k = `${policy}@${rate}`;
  if (!memo.has(k)) memo.set(k, aggregate(POLICIES[policy], { ...sweepBase, rerunBudget: rate, rerunMatches: rate }).cost);
  return memo.get(k);
};
const freshRates = [0, 0.1, 0.2, 1];
console.log(`  ${'policy'.padEnd(10)} ${freshRates.map((r) => `${(100 * r).toFixed(0)}%`.padStart(10)).join('')}`);
for (const name of ['fresh24', 'noMatches']) {
  console.log(`  ${name.padEnd(10)} ${freshRates.map((r) => fmt(at(name, r)) + '  ').join('')}`);
}
const pageOnly = aggregate(POLICIES.page, sweepBase).cost;
const a = at('fresh24', 0), b = at('fresh24', 1);
let even = null;
if (pageOnly && a >= pageOnly) even = 0;
else if (pageOnly && b > pageOnly) even = (pageOnly - a) / (b - a);
console.log(!pageOnly ? ''
  : even === 0 ? '  fresh trims do not beat paging-only on this workload'
  : even == null ? '  fresh trims still win even if every trim cost a re-run (100%)'
  : `  fresh trims break even with paging-only at about a ${Math.round(100 * even)}% re-run rate per trim (linear between 0% and 100%)`);

console.log('\n== sensitivity: the terse output cut on helper sessions (40% helper mix, long session)');
const mixSc = { name: 'terse', steps: 200, ttl: '1h', helperShare: 0.4 };
const cuts = [0, 0.1, 0.25, 0.5];
const offMix = aggregate(POLICIES.off, mixSc).cost;   // no helper routing, no terse: every session on Opus
const atCut = new Map(cuts.map((c) => [c, aggregate(POLICIES.fresh24, { ...mixSc, terseCut: c }).cost]));
console.log(`  ${'cut'.padEnd(6)} ${'cost$'.padStart(9)} ${'vs off'.padStart(8)} ${'work/$'.padStart(9)}`);
for (const c of cuts) {
  const cost = atCut.get(c);
  console.log(`  ${`${Math.round(100 * c)}%`.padEnd(6)} ${fmt(cost)} ${((cost / offMix - 1) * 100).toFixed(0).padStart(7)}% ${(offMix / cost).toFixed(2).padStart(8)}×`);
}
const worth = (atCut.get(0) - atCut.get(TERSE_CUT)) / atCut.get(0);
console.log(`  at the assumed ${Math.round(100 * TERSE_CUT)}% cut the directive is worth ${(100 * worth).toFixed(1)}% of total cost here,`);
console.log(`  about ${(100 * worth / (100 * TERSE_CUT)).toFixed(2)}% per point of helper output removed.`);
console.log('  At 0% it saves nothing and costs only the ~40-token system block it adds. Read the row');
console.log('  that matches how much shorter your own subagents actually get — and note that this stays');
console.log('  small while output is a small share of the bill, which at an agent loop it usually is.');
