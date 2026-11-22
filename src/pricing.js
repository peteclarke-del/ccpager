// USD per million tokens, from https://platform.claude.com/docs/en/about-claude/pricing (Oct 2026).
// Used only to estimate value; on a Pro/Max plan you don't pay these, but they show
// what the same work would cost in API credits.
const TABLE = [
  // prefix,             input, write5m, write1h, read,  output
  ['claude-fable-5-2',   8,     10,      16,      0.20,  40],
  ['claude-mythos-5-2',  8,     10,      16,      0.20,  40],
  ['claude-fable-5-1',   10,    12.5,    20,      0.25,  50],
  ['claude-mythos-5-1',  10,    12.5,    20,      0.25,  50],
  ['claude-fable-5',     10,    12.5,    20,      1,     50],
  ['claude-mythos-5',    10,    12.5,    20,      1,     50],
  ['claude-opus-5-5',    4,     5,       8,       0.20,  20],
  ['claude-opus-5',      5,     6.25,    10,      0.50,  25],
  ['claude-sonnet-5-5',  2,     2.5,     4,       0.10,  10],
  ['claude-sonnet-5',    2,     2.5,     4,       0.20,  10],
  ['claude-haiku-5-5',   0.10,  0.125,   0.20,    0.01,  0.50], // prompts ≤100K tokens
];
const HAIKU_LONG = [0.5, 0.625, 1, 0.05, 2.5]; // Haiku 5.5 prompts >100K tokens
const FALLBACK = 'claude-sonnet-5-5';

export function priceFor(model = '', promptTokens = 0) {
  const m = model.toLowerCase();
  const row = TABLE.find(([p]) => m.startsWith(p)) || TABLE.find(([p]) => p === FALLBACK);
  let [, input, write5m, write1h, read, output] = row;
  if (row[0] === 'claude-haiku-5-5' && promptTokens > 100_000) [input, write5m, write1h, read, output] = HAIKU_LONG;
  return { input, write5m, write1h, read, output, known: m.startsWith(row[0]) };
}

/**
 * Cost of one response from its `usage` block, plus the value of the tokens ccpager
 * kept out of the prompt.
 *
 * What a removed token would have cost depends on why it is gone, so `writeTokens` names the
 * only ones worth more than a read: the results elided on *this* request, taken out of the
 * suffix being written this turn, which avoid a cache *write* — 5x a read at Opus 5.5 on the
 * 5-minute TTL, 40x on the 1-hour one. Everything else (paged history, and fresh stubs replayed
 * from an earlier decision) would have been a cheap *cache read*.
 *
 * `savedHigh` is a real ceiling: read-rate tokens as fresh input if the cache had expired, and
 * write tokens at the write they would have needed anyway. It is never below `savedLow`.
 */
export function costOf(model, usage, savedTokens, { assume1h = false, rewriteTokens = 0, writeTokens = 0 } = {}) {
  const cc = usage.cache_creation || {};
  const has = cc.ephemeral_5m_input_tokens !== undefined || cc.ephemeral_1h_input_tokens !== undefined;
  const write = usage.cache_creation_input_tokens || 0;
  const w1h = has ? cc.ephemeral_1h_input_tokens || 0 : assume1h ? write : 0;
  const w5m = has ? cc.ephemeral_5m_input_tokens || 0 : write - w1h;
  const input = usage.input_tokens || 0, read = usage.cache_read_input_tokens || 0, out = usage.output_tokens || 0;
  const p = priceFor(model, input + read + write);
  const M = 1e6;
  const wrote = Math.max(0, Math.min(savedTokens, writeTokens));
  const readOnly = savedTokens - wrote;
  // Which write was avoided: the session's TTL, or what this request actually wrote. If it wrote
  // no cache at all the token would have been plain input, so that is the rate. A rewritten
  // suffix, though, is always a cache write, so `rewriteCost` uses the TTL rate either way.
  const ttlRate = assume1h || (has && w1h > 0 && w5m === 0) ? p.write1h : p.write5m;
  const writeRate = write === 0 ? p.input : ttlRate;
  return {
    cost: (input * p.input + w5m * p.write5m + w1h * p.write1h + read * p.read + out * p.output) / M,
    savedLow: (readOnly * p.read + wrote * writeRate) / M,
    savedHigh: (readOnly * p.input + wrote * Math.max(writeRate, p.input)) / M,
    // Extra cache write caused by moving the cutoff on a warm cache (would have been a cheap read).
    rewriteCost: (rewriteTokens * (ttlRate - p.read)) / M,
    w5m, w1h,
  };
}
