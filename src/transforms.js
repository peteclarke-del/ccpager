// Cache-TTL extension and turn-level model routing.

/** Upgrade every ephemeral cache breakpoint without a ttl to the given ttl (e.g. "1h"). */
export function extendCacheTtl(body, ttl) {
  let upgraded = 0;
  if (!ttl || ttl === 'off') return { body, upgraded };
  const fix = (block) => {
    const cc = block?.cache_control;
    if (cc && cc.type === 'ephemeral' && !cc.ttl) {
      upgraded++;
      return { ...block, cache_control: { ...cc, ttl } };
    }
    return block;
  };
  const fixList = (list) => (Array.isArray(list) ? list.map(fix) : list);
  const next = { ...body };
  if (Array.isArray(body.system)) next.system = fixList(body.system);
  if (Array.isArray(body.tools)) next.tools = fixList(body.tools);
  if (Array.isArray(body.messages)) {
    next.messages = body.messages.map((m) =>
      Array.isArray(m.content) && m.content.some((b) => b?.cache_control && !b.cache_control.ttl)
        ? { ...m, content: fixList(m.content) }
        : m);
  }
  return { body: next, upgraded };
}

const HEAVY = /\b(design|architect|plan|migrat|refactor|debug|why|investigat|race|deadlock|security|optimi[sz]e|review)\w*/i;
const LIGHT = /\b(rename|typo|add (a )?(log|comment)|format|lint|bump|commit message|what is|list)\b/i;

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    const t = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (t) return t;
    return null; // last user message is pure tool results: mid-task, don't reroute
  }
  return null;
}

/**
 * Conservative routing: only a fresh, short, clearly light user instruction goes to
 * the small model. Mid-task tool loops stay on the original model so the agent
 * doesn't change brains halfway through a plan.
 */
export function routeModel(body, smallModel) {
  const model = body.model || '';
  if (!Array.isArray(body.messages) || /haiku/i.test(model)) return { body, routed: null };
  if (body.thinking && body.thinking.type !== 'disabled') return { body, routed: null };
  const text = lastUserText(body.messages);
  if (!text || text.length > 280 || HEAVY.test(text) || !LIGHT.test(text)) return { body, routed: null };
  return { body: { ...body, model: smallModel }, routed: { from: model, to: smallModel } };
}
