// Adaptive protection: when the plan's usage window is on track to run out before it resets,
// shift work that doesn't need the big model onto a cheaper one until the pace is safe again.
//
// What it does while active:
//  * turn-level routing switches on (short, light instructions go to the small model), and
//  * every NEW session (a subagent, a helper, a fresh conversation) is routed to `protectModel`
//    and stays there for its whole life, so its cache is never invalidated by a model switch.
// Sessions already under way are never switched: changing the model mid-conversation starts
// that conversation's cache cold, which costs more than it saves.
//
// Inputs are the limit headers Anthropic sends on every response (see limits.js); nothing is
// requested. Decisions are per request, so protection drops out as soon as the pace is safe.

const FRESH_MESSAGES = 3;   // a session this short with no paging state yet is new

/**
 * Decide whether to protect, from the current usage summary.
 * Returns { active, reason, window } where reason is a short human sentence.
 */
export function protectDecision(summary, cfg) {
  if (!cfg.protect || !summary?.plan) return { active: false, reason: null, window: null };
  const at = Math.min(1, Math.max(0, (cfg.protectAt ?? 80) / 100));
  for (const w of summary.windows) {
    if (w.name.startsWith('api:') || w.used == null || w.expired) continue;
    if (w.used >= 1) return { active: true, window: w.name, reason: `${w.label} is used up` };
    if (w.runsOutBeforeReset) return { active: true, window: w.name, reason: `${w.label} runs out before it resets at this pace` };
    if (w.used >= at) return { active: true, window: w.name, reason: `${w.label} is ${Math.round(100 * w.used)}% used` };
  }
  return { active: false, reason: null, window: null };
}

const isBig = (model) => /opus|fable|mythos/i.test(model || '');

/**
 * Apply protection to one request. `session` is the per-conversation state (may be null for
 * count_tokens). Returns { body, routed, sticky } — `sticky` is true when the session was
 * already routed earlier and is simply kept on its model.
 */
export function applyProtect(body, decision, cfg, session) {
  const target = cfg.protectModel;
  if (session?.protectModel) { // keep a routed session on its model, protected or not
    if (body.model === session.protectModel) return { body, routed: null, sticky: true };
    return { body: { ...body, model: session.protectModel }, routed: { from: body.model, to: session.protectModel, why: 'session' }, sticky: true };
  }
  if (!decision.active || !target || !isBig(body.model) || !Array.isArray(body.messages)) return { body, routed: null, sticky: false };
  const fresh = body.messages.length <= FRESH_MESSAGES && (!session || session.boundary === 0 && session.lastAt == null);
  if (!fresh) return { body, routed: null, sticky: false };
  if (session) session.protectModel = target;
  return { body: { ...body, model: target }, routed: { from: body.model, to: target, why: 'protect' }, sticky: false };
}
