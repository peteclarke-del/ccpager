// USD per million tokens, from https://platform.claude.com/docs/en/about-claude/pricing (Oct 2026).
// Used only to estimate value; on a Pro/Max plan you don't pay these, but they show
// what the same work would cost in API credits.
const TABLE = [
  // prefix,             input, write5m, write1h, read,  output
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
 * Paged-out tokens would mostly have been *cache reads* (old history is the stable,
 * cached part of the prompt), so the honest estimate prices them at the cache-read
 * rate. `savedHigh` prices them as fresh input: the ceiling, reached when the cache
 * would have expired (long pauses, model switches).
 */
export function costOf(model, usage, savedTokens, { assume1h = false, rewriteTokens = 0 } = {}) {
  const cc = usage.cache_creation || {};
  const has = cc.ephemeral_5m_input_tokens !== undefined || cc.ephemeral_1h_input_tokens !== undefined;
  const write = usage.cache_creation_input_tokens || 0;
  const w1h = has ? cc.ephemeral_1h_input_tokens || 0 : assume1h ? write : 0;
  const w5m = has ? cc.ephemeral_5m_input_tokens || 0 : write - w1h;
  const input = usage.input_tokens || 0, read = usage.cache_read_input_tokens || 0, out = usage.output_tokens || 0;
  const p = priceFor(model, input + read + write);
  const M = 1e6;
  return {
    cost: (input * p.input + w5m * p.write5m + w1h * p.write1h + read * p.read + out * p.output) / M,
    savedLow: (savedTokens * p.read) / M,
    savedHigh: (savedTokens * p.input) / M,
    // Extra cache write caused by moving the cutoff on a warm cache (would have been a cheap read).
    rewriteCost: (rewriteTokens * ((assume1h ? p.write1h : p.write5m) - p.read)) / M,
    w5m, w1h,
  };
}
