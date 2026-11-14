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
//  * matches: a grep/rg hit list becomes the first few matches per file plus "+N more in file",
//    which is the same information a reader takes from it.
//  * budget: a single result larger than `budget` characters keeps its head and tail and elides
//    the middle with an explicit marker, so the model knows what is missing and how to get it.
//
// The last two are lossy, which is why they run only on the newest result (where they cost one
// comparison) and why every marker says what was removed. They attack the *incremental* part of a
// request — new tool output, written to the cache at 25–40x a cache read — which is where the tokens
// actually are. Error results and results that are already ccpager stubs are left alone.
const STUB_PREFIX = '[ccpager:';
const MIN_CHARS = 400;            // smaller results aren't worth touching
const MIN_SAVING = 0.10;          // tidy must save at least this share...
const MIN_SAVED_CHARS = 200;      // ...and this many chars, or the result is left as is
const DIFF_MAX_SHARE = 0.6;       // a diff bigger than this share of the file isn't worth it
const MAX_DIFF_LINES = 6000;      // beyond this the line diff is too slow; send the file

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[=>]/g;

// Budget and match-summary tuning. Both are conservative: they only fire on results that are
// clearly mechanical, and they say exactly what they removed.
export const DEFAULT_BUDGET = 24000;   // chars; 0 = off
const BUDGET_HEAD = 120, BUDGET_TAIL = 200;
const BUDGET_MIN_LINES = 300;          // short results are never elided
const MATCH_LINE = /^([^\s:][^:]*):(\d+)(?::\d+)?:/;   // path:line: or path:line:col:
const MATCH_MIN_LINES = 40, MATCH_MIN_FILES = 8, MATCH_PER_FILE = 3;

// Lines that look like program output rather than source: timestamps, log levels, test tallies,
// stack frames, grep hits, commit hashes. A source file is mostly none of these, which is what
// keeps the budget away from it.
const OUTPUT_LINE = new RegExp([
  '^\\s*\\[?\\d{4}-\\d{2}-\\d{2}', '^\\s*[A-Z][a-z]{2} \\d+ \\d{2}:\\d{2}:\\d{2}',
  '\\d{2}:\\d{2}:\\d{2}',
  '^\\s*(?:INFO|DEBUG|WARN(?:ING)?|ERROR|TRACE|FATAL)\\b',
  '^\\s*(?:ok|PASS(?:ED)?|FAIL(?:ED)?|SKIP|Tests?:|Ran \\d+)',
  '^\\s*[\u2713\u2714\u2717\u2716\u00d7]',
  '^\\s*at\\s+\\S+.*:\\d+',
  '^\\S+:\\d+(?::\\d+)?:',
  '^[0-9a-f]{7,40}\\s',
].join('|'));

// A Read result is a file the model asked to see. It is never elided, whatever it contains.
const SOURCE_TOOLS = new Set(['Read', 'NotebookRead']);

/** True when most non-blank lines look like program output (a log, a test run, a hit list). */
export function looksMechanical(text) {
  let total = 0, output = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    total++;
    if (OUTPUT_LINE.test(line)) output++;
  }
  return total > 0 && output / total >= 0.6;
}



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

/**
 * Head and tail of an oversized result, with an explicit marker where the middle was. Returns null
 * when the text is already under budget, is short enough to read as it is, or eliding would not save
 * most of it. Deterministic: the same input always produces the same bytes.
 */
export function budgetText(text, maxChars = DEFAULT_BUDGET, { mechanical = false } = {}) {
  if (!maxChars || text.length <= maxChars) return null;
  const lines = text.split('\n');
  if (lines.length < BUDGET_MIN_LINES) return null;
  // Code is not mechanical output: a 700-line file must not lose its middle to a budget meant for
  // logs and hit lists. Callers that know the result is output can skip the check.
  if (!mechanical && !looksMechanical(text)) return null;
  const head = lines.slice(0, BUDGET_HEAD);
  const tail = lines.slice(-BUDGET_TAIL);
  const elided = lines.length - head.length - tail.length;
  if (elided < lines.length * 0.5) return null;            // most of it would stay: not worth a marker
  const kept = head.join('\n').length + tail.join('\n').length;
  if (kept > text.length * 0.75) return null;
  return [...head,
    `… [ccpager: ${elided} of ${lines.length} lines elided; re-run with a narrower range (offset/limit, head, sed -n) if you need the middle]`,
    ...tail].join('\n');
}

/**
 * A grep/rg hit list as the first few matches per file plus a count of the rest. Files keep the order
 * they first appear in, so the output is deterministic. Returns null unless the list is long enough
 * and spread over enough files to be worth rewriting.
 */
export function summarizeMatches(text) {
  const counts = new Map(), kept = new Map();
  let matched = 0;
  for (const line of text.split('\n')) {
    const m = MATCH_LINE.exec(line);
    if (!m) continue;
    matched++;
    const file = m[1];
    counts.set(file, (counts.get(file) || 0) + 1);
    const list = kept.get(file) || [];
    if (list.length < MATCH_PER_FILE) { list.push(line.trim().slice(0, 200)); kept.set(file, list); }
  }
  if (matched < MATCH_MIN_LINES || counts.size < MATCH_MIN_FILES) return null;
  const out = [`[ccpager: ${matched} matches in ${counts.size} files; first ${MATCH_PER_FILE} per file]`];
  for (const [file, list] of kept) {
    out.push(...list);
    const rest = counts.get(file) - list.length;
    if (rest > 0) out.push(`  +${rest} more in ${file}`);
  }
  return out.join('\n');
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
export function compressFresh(messages, session, { enabled = true, rereadDiff = true, budget = DEFAULT_BUDGET, matches = true } = {}) {
  const stats = { out: messages, freshBlocks: 0, charsSaved: 0, decided: [], budgeted: 0, matched: 0 };
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
        let cand = tidy(text);
        let kind = 'tidy';
        if (matches) {
          const summary = summarizeMatches(cand);
          if (summary && summary.length < cand.length) { cand = summary; kind = 'matches'; }
        }
        if (budget) {
          // A Read result is never elided, and neither is a shell command that prints source code:
          // mechanical means the text looks like output, not just that the tool was not Read.
          const trimmed = budgetText(cand, budget, { mechanical: !SOURCE_TOOLS.has(u?.name) && looksMechanical(cand) });
          if (trimmed && trimmed.length < cand.length) { cand = trimmed; kind = 'budget'; }
        }
        const saved = text.length - cand.length;
        if (saved >= MIN_SAVED_CHARS && saved >= text.length * MIN_SAVING) {
          decided = { text: cand, base: null, kind };
          if (kind === 'matches') stats.matched++;
          else if (kind === 'budget') stats.budgeted++;
        }
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

// How many diff bases may be pinned at once. Without a cap, a long session accumulates pins and
// eventually nothing can be paged; with it, the most recent diffs keep their base and older ones are
// allowed to be paged (the diff then refers to a stubbed message, which is the same trade paging
// makes everywhere: the model can re-read).
const MAX_PINS = 8;

/** tool_use ids that must not be paged because a later diff refers to them. */
export function pinnedBases(messages, session) {
  const pinned = new Set();
  if (!session?.fresh?.size) return pinned;
  const stubbed = session.stubbed || new Map();
  const live = [];
  for (const [id, f] of session.fresh) if (f.base && !stubbed.has(id)) live.push(f.base);
  for (const id of live.slice(-MAX_PINS)) pinned.add(id);   // Map keeps insertion order: newest last
  return pinned;
}
