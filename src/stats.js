import fs from 'node:fs';
import path from 'node:path';
import { costOf } from './pricing.js';
import { recordLimits } from './limits.js';

// Only counts are stored. Prompts and responses are never written to disk.
const CHARS_PER_TOKEN = 4; // rough estimate for code and logs
const KEEP_DAYS = 31;
const emptyBucket = () => ({ requests: 0, tokensSaved: 0, promptTokens: 0, cost: 0, savedLow: 0, savedHigh: 0, rewriteCost: 0 });
const today = () => new Date().toISOString().slice(0, 10);

export class Stats {
  constructor(dir) {
    this.file = path.join(dir, 'stats.json');
    fs.mkdirSync(dir, { recursive: true });
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.data = null; }
    this.data ||= { requests: 0, pagedBlocks: 0, charsSaved: 0, ttlUpgrades: 0, routed: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, byHour: Array(24).fill(0), since: new Date().toISOString() };
    // Fields added in 0.2; older stats files are upgraded in place.
    this.data.totals ||= emptyBucket();
    this.data.byDay ||= {};
    this.data.byModel ||= {};
    // Fields added in 0.5: which cache TTL the writes actually used, and plan usage limits.
    this.data.usage.cacheWrite1h ??= 0;
    this.data.usage.cacheWrite5m ??= 0;
    this.data.limits ||= null;
    this.dirty = false;
    this.timer = setInterval(() => this.flush(), 5000).unref();
  }
  record(r) {
    const d = this.data;
    d.requests++;
    d.pagedBlocks += r.pagedBlocks || 0;
    d.charsSaved += r.charsSaved || 0;
    d.ttlUpgrades += r.upgraded || 0;
    if (r.routed) { d.routed++; if (r.routed.why === 'protect') d.protected = (d.protected || 0) + 1; }
    d.byHour[new Date().getHours()]++;
    this.dirty = true;
  }
  /** Called once a response finishes, with its usage block and what ccpager removed from that request. */
  usage(u, { model = '', charsSaved = 0, assume1h = false, rewriteChars = 0 } = {}) {
    if (!u) return;
    const d = this.data.usage;
    d.input += u.input_tokens || 0;
    d.output += u.output_tokens || 0;
    d.cacheRead += u.cache_read_input_tokens || 0;
    d.cacheWrite += u.cache_creation_input_tokens || 0;

    const tokensSaved = Math.round(charsSaved / CHARS_PER_TOKEN);
    const promptTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    const c = costOf(model, u, tokensSaved, { assume1h, rewriteTokens: Math.round(rewriteChars / CHARS_PER_TOKEN) });
    d.cacheWrite1h += c.w1h; d.cacheWrite5m += c.w5m;
    const add = (b) => {
      b.requests++; b.tokensSaved += tokensSaved; b.promptTokens += promptTokens;
      b.cost += c.cost; b.savedLow += c.savedLow; b.savedHigh += c.savedHigh; b.rewriteCost = (b.rewriteCost || 0) + c.rewriteCost;
    };
    add(this.data.totals);
    add((this.data.byDay[today()] ||= emptyBucket()));
    add((this.data.byModel[model || 'unknown'] ||= emptyBucket()));
    const days = Object.keys(this.data.byDay).sort();
    for (const k of days.slice(0, Math.max(0, days.length - KEEP_DAYS))) delete this.data.byDay[k];
    this.dirty = true;
  }
  /** Plan usage limits from a response's headers (see limits.js). */
  limits(parsed, now = Date.now()) {
    this.data.limits = recordLimits(this.data.limits, parsed, now);
    this.dirty = true;
  }
  flush() {
    if (!this.dirty) return;
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
    this.dirty = false;
  }
  static read(dir) {
    try { return JSON.parse(fs.readFileSync(path.join(dir, 'stats.json'), 'utf8')); } catch { return null; }
  }
}
