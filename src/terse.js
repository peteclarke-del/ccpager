// Terse output and capped budgets for helper/subagent sessions.
//
// Output is priced high per token — at Opus 5.5 list prices an output token is 5x a fresh input token
// and ~100x a cache read (see pricing.js) — but an agent loop writes little prose next to the prompt it
// re-reads, so this is a small saving in practice: `test/bench.js` prices it at about 1% of total cost
// at 500 output tokens per request. It is here because it is cheap, stable and safe, not because it
// changes work-per-token by a factor; the model tier does that.
//
// Cache safety: the directive is added as a NEW trailing system block and the last cache breakpoint
// is moved onto it. Every byte Claude Code sent is left exactly as it was, so the cached prefix is
// untouched; the addition costs one cache write at the start of a subagent session, which is cold
// anyway, and nothing after that. The text is a constant — no timestamps, no per-request content —
// because any byte that changed between requests would cost a full cache rewrite.

const TERSE = 'Output style: terse. No preamble, no restating the task, no recap of files you did not change, and no summary unless asked. Use the fewest tokens that fully answer; one short sentence per step.';
const MARK = 'Output style: terse.';

function hasMark(system) {
  if (typeof system === 'string') return system.includes(MARK);
  return Array.isArray(system) && system.some((b) => typeof b?.text === 'string' && b.text.includes(MARK));
}

function withTerse(body) {
  const sys = body.system;
  if (hasMark(sys)) return { body, added: false };
  if (sys == null) return { body: { ...body, system: [{ type: 'text', text: TERSE }] }, added: true };
  if (typeof sys === 'string') return { body: { ...body, system: `${sys}\n\n${TERSE}` }, added: true };
  if (!Array.isArray(sys)) return { body, added: false };
  let at = -1;
  for (let i = sys.length - 1; i >= 0; i--) if (sys[i]?.cache_control) { at = i; break; }
  if (at < 0) return { body: { ...body, system: [...sys, { type: 'text', text: TERSE }] }, added: true };
  const out = sys.slice();
  out[at] = { ...out[at], cache_control: undefined };        // JSON.stringify drops the key
  out.splice(at + 1, 0, { type: 'text', text: TERSE, cache_control: sys[at].cache_control });
  return { body: { ...body, system: out }, added: true };
}

/**
 * Apply the terse directive and the helper budgets to one request, returning the body.
 * Only helper sessions are touched; a main conversation comes back unchanged.
 */
export function applyTerse(body, cfg, session) {
  if (!cfg?.terseHelper || !session || session.kind !== 'helper') return body;
  let next = body;
  if (typeof next.max_tokens === 'number' && cfg.helperMaxTokens > 0 && next.max_tokens > cfg.helperMaxTokens) {
    next = { ...next, max_tokens: cfg.helperMaxTokens };
  }
  const th = next.thinking;
  if (th && typeof th.budget_tokens === 'number' && cfg.helperThinkTokens > 0 && th.budget_tokens > cfg.helperThinkTokens) {
    next = { ...next, thinking: { ...th, budget_tokens: cfg.helperThinkTokens } };
  }
  return withTerse(next).body;
}
