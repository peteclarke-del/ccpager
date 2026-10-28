// Context paging: replace bulky, stale tool output in older steps with short stubs.
//
// Design rules:
//  * Age is measured in *steps* (assistant messages, i.e. tool rounds), not typed
//    prompts: one prompt in Claude Code can run dozens of tool rounds.
//  * Only tool_result blocks inside user messages are touched. Assistant messages
//    (incl. thinking blocks and their signatures) and tool_use ids are never modified.
//  * Cache-aware. Moving the cutoff changes old content, so Anthropic must rewrite the
//    prompt cache from that point on, and a cache write costs ~25-40x a cache read.
//    In "smart" mode the cutoff only moves when that's free or clearly pays off:
//      - the cache has gone cold anyway (idle longer than the cache window),
//      - the removed tokens, re-read over the coming requests, outweigh the rewrite, or
//      - (opt-in) the context is larger than `largeContextTokens`, to delay auto-compaction.
//    Otherwise the previous cutoff is held and the request is byte-identical to the
//    last one up to the new turns, so the cache keeps hitting.
//  * When the cutoff does move it moves as far as it can (everything older than the kept
//    steps), because the rewrite costs the same however far it moves, and a bigger move
//    delays the next one. Moves are then at least `pageStep` steps apart.
//  * The cache TTL that matters is the one Anthropic actually applied (the response's
//    usage.cache_creation says). The gateway records it on the session; until it's seen,
//    the configured TTL is assumed.
//  * Decisions are frozen per session: once a block is stubbed it stays stubbed, and
//    a block that wasn't stubbed is never changed until the next cutoff move. (A later
//    re-read of the same file used to flip an old block mid-session and break the cache.)

import { priceFor } from './pricing.js';

const STUB_PREFIX = '[ccpager: paged out';
// How many more times removed tokens would likely be re-read. Sessions that have already run
// long tend to run longer (median here ~55 messages, 90th percentile ~180), so the estimate
// grows with the session: at least 30, at most 150, otherwise the number of steps so far.
const expectedFutureRequests = (stepsSoFar) => Math.max(30, Math.min(150, stepsSoFar));
const CHARS_PER_TOKEN = 4;

function resultText(block) {
  const c = block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (p.type === 'text' ? p.text : p.type === 'image' ? '[image]' : '')).join('\n');
  return '';
}

function resultSize(block) {
  const c = block.content;
  if (typeof c === 'string') return c.length;
  if (!Array.isArray(c)) return 0;
  // Images are expensive (~1.5k tokens each); count them as 6000 chars.
  return c.reduce((n, p) => n + (p.type === 'text' ? p.text.length : p.type === 'image' ? 6000 : 0), 0);
}

/** Key identifying what a tool call looked at, so later duplicates mark earlier ones superseded. */
function toolKey(use) {
  if (!use) return null;
  const i = use.input || {};
  const target = i.file_path || i.path || i.command || i.pattern || i.url;
  return target ? `${use.name}:${target}` : null;
}

function makeStub(block, use, size, reason) {
  const text = resultText(block);
  const firstLine = text.split('\n').find((l) => l.trim())?.slice(0, 160) || '';
  const what = use ? `${use.name}${toolKey(use) ? ' ' + toolKey(use).split(':').slice(1).join(':') : ''}` : 'tool output';
  return `${STUB_PREFIX} — ${what}, ${size} chars, ${reason}. Re-run the tool if you need it again.]` +
    (firstLine ? `\nfirst line: ${firstLine}` : '');
}

/** Which tool_result blocks before `cutoff` qualify for paging, with their reason. */
function candidates(messages, cutoff, opts) {
  const uses = new Map();
  const lastSeen = new Map();
  messages.forEach((m, i) => {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return;
    for (const b of m.content) {
      if (b.type !== 'tool_use') continue;
      uses.set(b.id, b);
      const k = toolKey(b);
      if (k) lastSeen.set(k, i);
    }
  });
  const found = new Map(); // tool_use_id -> { reason, index, size }
  for (let i = 0; i < cutoff; i++) {
    const m = messages[i];
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type !== 'tool_result' || b.is_error || resultText(b).startsWith(STUB_PREFIX)) continue;
      const use = uses.get(b.tool_use_id);
      const size = resultSize(b);
      const k = toolKey(use);
      if (k && lastSeen.get(k) > i && size > 200) found.set(b.tool_use_id, { reason: 'superseded by a later call', index: i, size });
      else if (size >= opts.minPageChars) found.set(b.tool_use_id, { reason: 'stale', index: i, size });
    }
  }
  return { found, uses };
}

function applyStubs(messages, stubbed, uses) {
  let pagedBlocks = 0, charsSaved = 0;
  const out = messages.map((m) => {
    if (m.role !== 'user' || !Array.isArray(m.content)) return m;
    let changed = false;
    const content = m.content.map((b) => {
      if (b.type !== 'tool_result' || !stubbed.has(b.tool_use_id)) return b;
      const size = resultSize(b);
      const stub = makeStub(b, uses.get(b.tool_use_id), size, stubbed.get(b.tool_use_id));
      pagedBlocks++; charsSaved += Math.max(0, size - stub.length);
      changed = true;
      return { ...b, content: stub };
    });
    return changed ? { ...m, content } : m;
  });
  return { out, pagedBlocks, charsSaved };
}

/**
 * Pages a request. `session` is per-conversation state kept by the gateway
 * ({ stubbed: Map, boundary, lastAt, ttl }); pass null for stateless behaviour (always move).
 * Returns { body, stats } with stats:
 *   pagedBlocks, charsSaved       what was removed from this request
 *   moved, reason                 whether the cutoff moved on this request, and why
 *   held                          why paging was held back (when it could have moved)
 *   pendingChars                  removable now if the cutoff moved
 *   rewriteChars                  prompt after the first change (cache rewrite cost) when moved on a warm cache
 *   stepsUntil                    steps until the next cutoff becomes possible
 *   ttl                           cache TTL assumed for the decision ('1h' or '5m')
 */
export function pageRequest(body, opts, session = null, now = Date.now()) {
  const stats = { pagedBlocks: 0, charsSaved: 0, moved: false, reason: null, held: null, pendingChars: 0, rewriteChars: 0, stepsUntil: 0, ttl: null };
  const messages = body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return { body, stats };
  const s = session || { stubbed: new Map(), boundary: 0, lastAt: null, ttl: null };
  const ttl = s.ttl || (opts.cacheTtl === '1h' ? '1h' : '5m');
  stats.ttl = ttl;

  const steps = [];
  messages.forEach((m, i) => m.role === 'assistant' && steps.push(i));
  const n = steps.length, keep = opts.keepRecentTurns, step = opts.pageStep;
  const eligible = Math.max(0, n - keep);            // steps old enough to be paged
  const canMove = eligible >= s.boundary + step;     // enough new old steps since the last move
  stats.stepsUntil = Math.max(0, s.boundary + step + keep - n);
  const target = canMove ? eligible : s.boundary;

  const { found, uses } = candidates(messages, target > 0 ? steps[target] : 0, opts);
  for (const id of opts.pinned || []) found.delete(id);   // bases of fresh-result diffs stay in full
  const fresh = [...found].filter(([id]) => !s.stubbed.has(id));

  if (canMove && fresh.length) {
    const freshChars = fresh.reduce((n, [, f]) => n + f.size, 0);
    const firstIdx = Math.min(...fresh.map(([, f]) => f.index));
    const tail = JSON.stringify(messages.slice(firstIdx)).length - freshChars;
    const ttlMs = (ttl === '1h' ? 55 : 4.5) * 60_000;
    const cold = s.lastAt == null || now - s.lastAt > ttlMs;
    const totalTokens = JSON.stringify(messages).length / CHARS_PER_TOKEN;
    const p = priceFor(body.model);
    const ratio = ((ttl === '1h' ? p.write1h : p.write5m) - p.read) / p.read; // rewrite cost vs one re-read
    const pays = freshChars * expectedFutureRequests(n) > tail * ratio;
    const large = opts.largeContextTokens > 0 && totalTokens > opts.largeContextTokens;

    let reason = null;
    if (opts.pagingMode === 'always' || !session) reason = 'always';
    else if (cold) reason = 'cache cold';
    else if (pays) reason = 'pays off';
    else if (large) reason = 'large context';

    if (reason) {
      for (const [id, f] of found) if (!s.stubbed.has(id)) s.stubbed.set(id, f.reason);
      s.boundary = target;
      stats.moved = true; stats.reason = reason;
      if (!cold) stats.rewriteChars = tail;
    } else {
      stats.held = 'cache warm';
      stats.pendingChars = freshChars;
    }
  }

  s.lastAt = now;
  const { out, pagedBlocks, charsSaved } = applyStubs(messages, s.stubbed, uses);
  stats.pagedBlocks = pagedBlocks; stats.charsSaved = charsSaved;
  if (!pagedBlocks) return { body, stats };
  return { body: { ...body, messages: out }, stats };
}

/**
 * Record the cache TTL Anthropic actually applied, from a response's usage block, so the
 * next decision for this session uses the real cache window and write price.
 */
export function noteUsage(session, usage) {
  const cc = usage?.cache_creation;
  if (!session || !cc) return;
  if ((cc.ephemeral_1h_input_tokens || 0) > 0) session.ttl = '1h';
  else if ((cc.ephemeral_5m_input_tokens || 0) > 0) session.ttl = '5m';
}

/** Per-conversation paging state, so each Claude Code session (and each subagent) has its own. */
export class Sessions {
  constructor(max = 300, idleMs = 3 * 3600_000) { this.map = new Map(); this.max = max; this.idleMs = idleMs; }
  key(body) {
    const m = body?.messages?.[0];
    const first = m ? (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).slice(0, 2000) : '';
    const uid = body?.metadata?.user_id || '';
    return `${uid}|${hash(first)}`;
  }
  get(body, now = Date.now()) {
    const k = this.key(body);
    let s = this.map.get(k);
    if (!s || (s.lastAt != null && now - s.lastAt > this.idleMs)) s = { stubbed: new Map(), fresh: new Map(), boundary: 0, lastAt: null, ttl: s?.ttl || null };
    s.fresh ||= new Map();
    this.map.delete(k); this.map.set(k, s); // LRU order
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    return s;
  }
}

function hash(str) { // FNV-1a, enough to tell conversations apart
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

export const _internal = { toolKey, STUB_PREFIX };
