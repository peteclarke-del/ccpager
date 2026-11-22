// Context paging: replace bulky, stale tool output in older steps with short stubs.
//
// Design rules:
//  * Age is measured in *steps* (assistant messages, i.e. tool rounds), not typed
//    prompts: one prompt in Claude Code can run dozens of tool rounds.
//  * Tool_result blocks inside user messages are paged, and so are the big string inputs of old
//    Write/Edit tool_use blocks. Thinking blocks and their signatures, text, and tool_use ids
//    and names are never modified.
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
// A stub for a large result carries a compact digest rather than a single line: the head, the lines
// that look like errors or stack frames, and the tail. Paging exists to remove tokens, not to remove
// the information the model needs to carry on, because a re-run is far more expensive than the stub:
// it costs a whole extra tool round (an output turn plus a full-size cache write).
const DIGEST_MIN_CHARS = 4000;   // smaller results keep the one-line stub
const DIGEST_MAX_CHARS = 700;    // hard cap: a huge log can never produce a huge stub
const DIGEST_HEAD = 6, DIGEST_TAIL = 4, DIGEST_SIGNALS = 6;
const SIGNAL = /(error|fail|fatal|exception|traceback|panic|assert|warning|\u2717|FAIL|ERROR|Error:|at .*:\d+)/;
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

function stubHeader(use, size, reason) {
  const what = use ? `${use.name}${toolKey(use) ? ' ' + toolKey(use).split(':').slice(1).join(':') : ''}` : 'tool output';
  return `${STUB_PREFIX} — ${what}, ${size} chars, ${reason}. Re-run the tool if you need it again.]`;
}

/** Head, error-ish lines and tail of a large result, capped. Deterministic, so replay is byte-identical. */
export function digestOf(block, use, size, reason) {
  const text = resultText(block);
  const head = stubHeader(use, size, reason);
  if (text.length < DIGEST_MIN_CHARS) {
    const firstLine = text.split('\n').find((l) => l.trim())?.slice(0, 160) || '';
    return head + (firstLine ? `\nfirst line: ${firstLine}` : '');
  }
  const lines = text.split('\n').filter((l) => l.trim());
  const shownHead = lines.slice(0, DIGEST_HEAD).map((l) => '  ' + l.slice(0, 200));
  const seen = new Set(shownHead);
  const pick = (list) => {
    const out = [];
    for (const l of list) {
      const k = '  ' + l.slice(0, 200);
      if (seen.has(k)) continue;
      seen.add(k); out.push(k);
    }
    return out;
  };
  const signals = pick(lines.filter((l) => SIGNAL.test(l)).slice(0, DIGEST_SIGNALS));
  const tail = pick(lines.slice(-DIGEST_TAIL));
  const elided = Math.max(0, lines.length - shownHead.length - signals.length - tail.length);
  const out = [head, 'head:', ...shownHead];
  if (signals.length) out.push('key lines:', ...signals);
  if (tail.length) out.push('tail:', ...tail);
  if (elided) out.push(`… ${elided} more line(s) elided (${text.length} chars total)`);
  const s = out.join('\n');
  return s.length <= DIGEST_MAX_CHARS ? s
    : s.slice(0, DIGEST_MAX_CHARS - 20).replace(/\n[^\n]*$/, '') + '\n… (truncated)';
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
      if (k && lastSeen.get(k) > i && size > 200) found.set(b.tool_use_id, { reason: 'superseded by a later call', index: i, size, block: b });
      else if (size >= opts.minPageChars) found.set(b.tool_use_id, { reason: 'stale', index: i, size, block: b });
    }
  }
  return { found, uses };
}

// Large inputs of old file-writing calls (Write content, Edit old/new strings). Once the call has
// run, the file on disk holds the content, so the copy in history is dead weight resent every turn.
// Decided at the same cutoff move as the results and frozen, so the cache prefix stays stable.
const INPUT_FIELDS = { Write: ['content'], Edit: ['old_string', 'new_string'], MultiEdit: ['edits'], NotebookEdit: ['new_source'] };
const fieldSize = (v) => (typeof v === 'string' ? v.length : v == null ? 0 : JSON.stringify(v).length);

function inputCandidates(messages, cutoff, opts, known) {
  const found = new Map(); // tool_use id -> { index, size, text: { field: stub } }
  for (let i = 0; i < cutoff; i++) {
    const m = messages[i];
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      const fields = b.type === 'tool_use' && INPUT_FIELDS[b.name];
      if (!fields || known.has(b.id) || !b.input) continue;
      const text = {}; let size = 0;
      for (const f of fields) {
        const n = fieldSize(b.input[f]);
        if (n < opts.minPageChars || (typeof b.input[f] === 'string' && b.input[f].startsWith(STUB_PREFIX))) continue;
        text[f] = `${STUB_PREFIX} ${f} of ${b.name}${b.input.file_path ? ' ' + b.input.file_path : ''}, ${n} chars; the call ran, re-read the file if you need it]`;
        size += n - text[f].length;
      }
      if (size > 0) found.set(b.id, { index: i, size, text });
    }
  }
  return found;
}

function applyInputStubs(messages, inputs) {
  let blocks = 0, chars = 0;
  const out = messages.map((m) => {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return m;
    let changed = false;
    const content = m.content.map((b) => {
      const v = b.type === 'tool_use' && inputs.get(b.id);
      if (!v) return b;
      const input = { ...b.input };
      for (const [f, t] of Object.entries(v.text)) { chars += Math.max(0, fieldSize(input[f]) - t.length); input[f] = t; }
      blocks++; changed = true;
      return { ...b, input };
    });
    return changed ? { ...m, content } : m;
  });
  return { out, blocks, chars };
}

function applyStubs(messages, stubbed, uses) {
  let pagedBlocks = 0, charsSaved = 0;
  const out = messages.map((m) => {
    if (m.role !== 'user' || !Array.isArray(m.content)) return m;
    let changed = false;
    const content = m.content.map((b) => {
      if (b.type !== 'tool_result' || !stubbed.has(b.tool_use_id)) return b;
      const size = resultSize(b);
      const v = stubbed.get(b.tool_use_id);
      const reason = typeof v === 'string' ? v : v.reason;
      let text = v && typeof v === 'object' ? v.text : null;
      if (!text) {
        text = digestOf(b, uses.get(b.tool_use_id), size, reason);
        if (v && typeof v === 'object') v.text = text;   // freeze the bytes first sent
      }
      pagedBlocks++; charsSaved += Math.max(0, size - text.length);
      changed = true;
      return { ...b, content: text };
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
  s.inputs ||= new Map();
  const freshIn = opts.pageInputs === false ? [] : [...inputCandidates(messages, target > 0 ? steps[target] : 0, opts, s.inputs)];

  if (canMove && (fresh.length || freshIn.length)) {
    const freshChars = fresh.reduce((n, [, f]) => n + f.size, 0) + freshIn.reduce((n, [, f]) => n + f.size, 0);
    const firstIdx = Math.min(...fresh.map(([, f]) => f.index), ...freshIn.map(([, f]) => f.index));
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
      // Freeze the stub text now: later requests replay these exact bytes, so the cache prefix is stable.
      for (const [id, f] of found) {
        if (!s.stubbed.has(id)) s.stubbed.set(id, { reason: f.reason, text: digestOf(f.block, uses.get(id), f.size, f.reason) });
      }
      for (const [id, f] of freshIn) s.inputs.set(id, f);
      s.boundary = target;
      stats.moved = true; stats.reason = reason;
      if (!cold) stats.rewriteChars = tail;
    } else {
      stats.held = 'cache warm';
      stats.pendingChars = freshChars;
    }
  }

  s.lastAt = now;
  const r = applyStubs(messages, s.stubbed, uses);
  const inp = applyInputStubs(r.out, s.inputs);
  stats.pagedBlocks = r.pagedBlocks + inp.blocks; stats.charsSaved = r.charsSaved + inp.chars;
  if (!stats.pagedBlocks) return { body, stats };
  return { body: { ...body, messages: inp.out }, stats };
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
    const first = m ? (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)) : '';
    // Claude Code's first message carries an <env> block whose contents change with the cwd, the
    // platform or the session's environment. Hashing it verbatim used to invent a new session whenever
    // that happened, which threw away the paging state and made the next warm-cache move a full rewrite.
    const stable = first
      .replace(/<env>[\s\S]*?<\/env>/g, '')
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      .slice(0, 2000);
    const uid = body?.metadata?.user_id || '';
    const sys = String(typeof body?.system === 'string' ? body.system : JSON.stringify(body?.system ?? '')).slice(0, 200);
    const tools = (Array.isArray(body?.tools) ? body.tools : []).map((t) => t?.name || '').join(',');
    return `${uid}|${hash(sys)}|${hash(tools)}|${hash(stable)}`;
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

export const _internal = { toolKey, STUB_PREFIX, DIGEST_MAX_CHARS };
