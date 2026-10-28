// Fresh tool results: shrink a tool result the first time it is sent, before it is ever written
// to the prompt cache, and then send exactly the same shrunken bytes on every later request so
// the cache prefix stays intact. Only the newest user message is ever decided on; older messages
// just replay what was decided when they were newest. Two kinds of rewrite:
//
//  * tidy: lossless-ish clean-up of noisy output (ANSI colour codes, progress bars rewritten
//    with carriage returns, trailing whitespace, runs of blank lines, runs of identical lines,
//    whole-result JSON minified). Applied only when it saves at least 10% and 200 chars, so
//    ordinary file reads are untouched.
//  * re-read: a tool result that reads the same target as an earlier result still present in
//    full becomes "identical to the read at message N" when nothing changed, or a unified diff
//    against that read when the diff is much smaller than the file. The earlier read is then
//    pinned so paging cannot remove the base out from under the diff.
//
// Error results and results that are already ccpager stubs are left alone.
const STUB_PREFIX = '[ccpager:';
const MIN_CHARS = 400;            // smaller results aren't worth touching
const MIN_SAVING = 0.10;          // tidy must save at least this share...
const MIN_SAVED_CHARS = 200;      // ...and this many chars, or the result is left as is
const DIFF_MAX_SHARE = 0.6;       // a diff bigger than this share of the file isn't worth it
const MAX_DIFF_LINES = 6000;      // beyond this the line diff is too slow; send the file

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[=>]/g;

/** Text of a tool_result block, or null when it is not plain text (images etc.). */
function textOf(block) {
  const c = block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.length && c.every((p) => p.type === 'text')) return c.map((p) => p.text).join('\n');
  return null;
}

function target(use) {
  const i = use?.input || {};
  return i.file_path || i.path || i.notebook_path || null;
}

/** Noise removal that keeps every piece of information a reader could use. */
export function tidy(text) {
  let t = text.replace(ANSI, '');
  // Progress bars redraw the line with \r: keep the final state of each line.
  if (t.includes('\r')) t = t.split('\n').map((l) => l.includes('\r') ? l.slice(l.lastIndexOf('\r') + 1) : l).join('\n');
  const lines = t.split('\n').map((l) => l.replace(/[ \t]+$/, ''));
  const out = [];
  let blank = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l === '') { if (++blank <= 1) out.push(l); continue; }
    blank = 0;
    let run = 1;
    while (i + run < lines.length && lines[i + run] === l) run++;
    if (run >= 3) { out.push(`${l}   [× ${run}]`); i += run - 1; } else out.push(l);
  }
  t = out.join('\n').replace(/\n+$/, '');
  // A result that is one JSON document can lose its pretty-printing without losing anything.
  const trimmed = t.trim();
  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length > 2000) {
    try { const mini = JSON.stringify(JSON.parse(trimmed)); if (mini.length < trimmed.length * 0.8) t = mini; } catch {}
  }
  return t;
}

/** Minimal unified diff (no headers) between two texts, by line. Returns null when too large. */
export function lineDiff(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  if (A.length > MAX_DIFF_LINES || B.length > MAX_DIFF_LINES) return null;
  // Trim common prefix/suffix, then LCS on the middle.
  const CTX = 2;
  let p = 0; while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let s = 0; while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;
  p = Math.max(0, p - CTX); s = Math.max(0, s - CTX);   // keep context lines on both sides
  const X = A.slice(p, A.length - s), Y = B.slice(p, B.length - s);
  if (X.length * Y.length > 4_000_000) return null;
  const n = X.length, m = Y.length;
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i * (m + 1) + j] = X[i] === Y[j] ? dp[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
  }
  const ops = []; // [type, line]
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (X[i] === Y[j]) { ops.push([' ', X[i]]); i++; j++; }
    else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) ops.push(['-', X[i++]]);
    else ops.push(['+', Y[j++]]);
  }
  while (i < n) ops.push(['-', X[i++]]);
  while (j < m) ops.push(['+', Y[j++]]);
  // Emit hunks with CTX lines of context, numbered against the new text.
  const out = [];
  let k = 0, oldLine = p + 1, newLine = p + 1;
  while (k < ops.length) {
    if (ops[k][0] === ' ') { k++; oldLine++; newLine++; continue; }
    let start = k, end = k;
    while (end < ops.length) { // extend the hunk while changes are within 2*CTX of each other
      let next = end; while (next < ops.length && ops[next][0] !== ' ') next++;
      let gap = next; while (gap < ops.length && ops[gap][0] === ' ' && gap - next < 2 * CTX) gap++;
      end = next;
      if (gap < ops.length && ops[gap][0] !== ' ') { end = gap; continue; }
      break;
    }
    const ctxBefore = Math.min(CTX, start), ctxAfter = Math.min(CTX, ops.length - end);
    const hunk = ops.slice(start - ctxBefore, end + ctxAfter);
    const oldStart = oldLine - ctxBefore, newStart = newLine - ctxBefore;
    const oldCount = hunk.filter((o) => o[0] !== '+').length, newCount = hunk.filter((o) => o[0] !== '-').length;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const [t, l] of hunk) out.push(t + l);
    for (let q = start; q < end; q++) { if (ops[q][0] === '-') oldLine++; else if (ops[q][0] === '+') newLine++; }
    k = end;
  }
  return out.join('\n');
}

/**
 * Decide and apply fresh-result rewrites. `messages` is the (already paged) message list;
 * `session.fresh` maps tool_use_id -> { text, base } decided earlier. Returns
 * { out, freshBlocks, charsSaved, decided } where `decided` lists ids decided on this request.
 */
export function compressFresh(messages, session, { enabled = true, rereadDiff = true } = {}) {
  const stats = { out: messages, freshBlocks: 0, charsSaved: 0, decided: [] };
  if (!enabled || !Array.isArray(messages) || !messages.length) return stats;
  const fresh = session?.fresh || new Map();
  const uses = new Map();
  const seen = new Map(); // "name:target" -> [{ id, index, text }] in order
  messages.forEach((m, i) => {
    if (!Array.isArray(m.content)) return;
    for (const b of m.content) {
      if (m.role === 'assistant' && b.type === 'tool_use') uses.set(b.id, b);
      if (m.role === 'user' && b.type === 'tool_result' && !b.is_error) {
        const u = uses.get(b.tool_use_id), t = target(u);
        if (!t) continue;
        const text = textOf(b);
        if (text == null || text.startsWith(STUB_PREFIX) || fresh.get(b.tool_use_id)?.base) continue; // a diff can't be a base
        const k = `${u.name}:${t}`;
        if (!seen.has(k)) seen.set(k, []);
        seen.get(k).push({ id: b.tool_use_id, index: i, text });
      }
    }
  });
  const last = messages.length - 1;
  const newest = messages[last];
  if (newest.role === 'user' && Array.isArray(newest.content)) {
    for (const b of newest.content) {
      if (b.type !== 'tool_result' || b.is_error || fresh.has(b.tool_use_id)) continue;
      const text = textOf(b);
      if (text == null || text.length < MIN_CHARS || text.startsWith(STUB_PREFIX)) continue;
      const u = uses.get(b.tool_use_id), t = target(u);
      let decided = null;
      if (rereadDiff && t) {
        const prior = (seen.get(`${u.name}:${t}`) || []).filter((r) => r.index < last && r.id !== b.tool_use_id);
        const base = prior[prior.length - 1];
        if (base) {
          if (base.text === text) decided = { text: `${STUB_PREFIX} ${u.name} ${t} is identical to the result at message ${base.index + 1}; unchanged, ${text.length} chars]`, base: base.id };
          else {
            const d = lineDiff(base.text, text);
            if (d != null && d.length < text.length * DIFF_MAX_SHARE) decided = { text: `${STUB_PREFIX} ${u.name} ${t} changed since message ${base.index + 1}; unified diff against that result, new file ${text.length} chars]\n${d}`, base: base.id };
          }
        }
      }
      if (!decided) {
        const tidied = tidy(text);
        const saved = text.length - tidied.length;
        if (saved >= MIN_SAVED_CHARS && saved >= text.length * MIN_SAVING) decided = { text: tidied, base: null };
      }
      if (decided) { fresh.set(b.tool_use_id, decided); stats.decided.push(b.tool_use_id); }
    }
  }
  if (!fresh.size) return stats;
  stats.out = messages.map((m) => {
    if (m.role !== 'user' || !Array.isArray(m.content)) return m;
    let changed = false;
    const content = m.content.map((b) => {
      if (b.type !== 'tool_result' || !fresh.has(b.tool_use_id)) return b;
      const text = textOf(b);
      if (text == null || text.startsWith(STUB_PREFIX)) return b; // paged already; the stub wins
      const f = fresh.get(b.tool_use_id);
      stats.freshBlocks++; stats.charsSaved += Math.max(0, text.length - f.text.length);
      changed = true;
      return { ...b, content: f.text };
    });
    return changed ? { ...m, content } : m;
  });
  return stats;
}

/** tool_use ids that must not be paged because a later diff refers to them. */
export function pinnedBases(messages, session) {
  const pinned = new Set();
  if (!session?.fresh?.size) return pinned;
  const stubbed = session.stubbed || new Map();
  for (const [id, f] of session.fresh) if (f.base && !stubbed.has(id)) pinned.add(f.base);
  return pinned;
}
