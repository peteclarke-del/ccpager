import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const num = (v, d) => (v !== undefined && v !== '' && !isNaN(+v) ? +v : d);
const bool = (v, d) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(v));

const dataDir = process.env.CCPAGER_HOME || path.join(os.homedir(), '.ccpager');
let saved = {};
try { saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')); } catch {}

export const config = {
  // A port saved from the GUI / `ccpager set port` wins over the environment.
  port: Number.isInteger(saved.port) ? saved.port : num(process.env.CCPAGER_PORT, 8787),
  upstream: process.env.CCPAGER_UPSTREAM || 'https://api.anthropic.com',

  // Context paging
  paging: bool(process.env.CCPAGER_PAGING, true),
  // Fresh tool results: tidy noisy output (ANSI, progress bars, repeated lines, pretty JSON) and
  // send a re-read of an unchanged or slightly changed file as a reference or diff. Decided on
  // the newest message only, so the cache prefix is never disturbed.
  fresh: bool(process.env.CCPAGER_FRESH, true),
  rereadDiff: bool(process.env.CCPAGER_REREAD_DIFF, true),
  // A single tool result larger than this keeps its head and tail and elides the middle (0 = off),
  // and a long grep/rg hit list becomes the first few matches per file plus a count of the rest.
  // Both are decided once, when the result is newest, then replayed byte-for-byte.
  freshBudget: num(process.env.CCPAGER_FRESH_BUDGET, 24000),
  freshMatches: bool(process.env.CCPAGER_FRESH_MATCHES, true),
  // Recent steps (tool rounds) kept verbatim. 4, not 6: with digest stubs the paged results keep
  // their head, error lines and tail, so test/bench.js (which now prices the re-runs paging can
  // cause) shows 4 ahead of 6 at every re-run rate it sweeps. `ccpager set keepTurns 6` if your
  // sessions are mostly long, linear investigations.
  keepRecentTurns: num(process.env.CCPAGER_KEEP_TURNS, 4),
  // Also stub the big string inputs of old Write/Edit calls (the file on disk already has them).
  pageInputs: bool(process.env.CCPAGER_PAGE_INPUTS, true),
  pageStep: num(process.env.CCPAGER_PAGE_STEP, 8),            // cutoff can move at most every N steps
  minPageChars: num(process.env.CCPAGER_MIN_CHARS, 1200),     // don't bother stubbing small outputs
  // Above this many prompt tokens, move the cutoff even on a warm cache to delay auto-compaction.
  // 0 = off (default): on a warm cache the rewrite usually costs more than the paging saves.
  largeContextTokens: num(process.env.CCPAGER_LARGE_CONTEXT, 0),

  // "smart": only move the cutoff when the cache is cold or it pays off; "always": every step boundary
  pagingMode: process.env.CCPAGER_PAGING_MODE === 'always' ? 'always' : 'smart',

  // Prompt cache TTL upgrade: "1h" or "off". Off by default: Claude Code already asks for the
  // 1-hour cache where it pays (the main conversation on a subscription) and deliberately uses
  // 5 minutes for subagents and when billing usage credits; forcing 1h there doubles write cost.
  cacheTtl: process.env.CCPAGER_CACHE_TTL || 'off',

  // Turn-level model routing (off by default)
  routing: bool(process.env.CCPAGER_ROUTING, false),
  routeSmallModel: process.env.CCPAGER_SMALL_MODEL || 'claude-haiku-5-5',

  // Adaptive protection (on by default): when a plan usage window is on track to run out before
  // it resets, or is past `protectAt` percent, turn routing on and start NEW sessions (subagents,
  // helpers) on `protectModel`. Conversations already under way are never switched.
  protect: bool(process.env.CCPAGER_PROTECT, true),
  protectModel: process.env.CCPAGER_PROTECT_MODEL || 'claude-sonnet-5-5',
  protectAt: num(process.env.CCPAGER_PROTECT_AT, 80),

  // Helper/subagent sessions: a session whose system prompt marks it as a Claude Code subagent
  // starts on `helperModel` and stays there (decided once, at session start, when nothing is
  // cached yet), and its output is asked to be terse with capped output and thinking budgets.
  // The model tier is the large saving; the terse part is cheap and safe but small — see the
  // sweep at the end of `test/bench.js` rather than trusting the idea.
  helperRouting: bool(process.env.CCPAGER_HELPER_ROUTING, true),
  helperModel: process.env.CCPAGER_HELPER_MODEL || 'claude-sonnet-5-5',
  terseHelper: bool(process.env.CCPAGER_TERSE, true),
  helperMaxTokens: num(process.env.CCPAGER_HELPER_MAX_TOKENS, 8000),
  helperThinkTokens: num(process.env.CCPAGER_HELPER_THINK, 4000),

  // Look for a newer release on GitHub at most once a day and say so in `ccpager status` and
  // the window. One small GET; nothing else is sent. `ccpager off updates` disables it.
  updateCheck: bool(process.env.CCPAGER_UPDATE_CHECK, true),

  dataDir,
  verbose: bool(process.env.CCPAGER_VERBOSE, false),
};
