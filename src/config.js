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
  keepRecentTurns: num(process.env.CCPAGER_KEEP_TURNS, 6),   // recent steps (tool rounds) kept verbatim
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

  // Look for a newer release on GitHub at most once a day and say so in `ccpager status` and
  // the window. One small GET; nothing else is sent. `ccpager off updates` disables it.
  updateCheck: bool(process.env.CCPAGER_UPDATE_CHECK, true),

  dataDir,
  verbose: bool(process.env.CCPAGER_VERBOSE, false),
};
