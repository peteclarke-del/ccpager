import http from 'node:http';
import { Readable } from 'node:stream';
import { pageRequest, Sessions, noteUsage } from './pager.js';
import { compressFresh, pinnedBases } from './fresh.js';
import { extendCacheTtl, routeModel } from './transforms.js';
import { parseLimitHeaders, summarizeLimits } from './limits.js';
import { protectDecision, applyProtect } from './protect.js';
import { Stats } from './stats.js';
import { liveConfig } from './state.js';
import { VERSION } from './version.js';

const HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'accept-encoding']);

export function transform(body, config, session = null, protect = { active: false }) {
  const report = { pagedBlocks: 0, charsSaved: 0, freshBlocks: 0, freshChars: 0, upgraded: 0, routed: null, protect: protect.active ? protect.reason : null };
  if (config.paging) {
    const r = pageRequest(body, { ...config, pinned: pinnedBases(body.messages, session) }, session);
    body = r.body; Object.assign(report, r.stats);
  }
  if (config.fresh && session) {   // cache-safe: decides only on the newest message, replays older decisions
    const f = compressFresh(body.messages, session, { rereadDiff: config.rereadDiff });
    if (f.freshBlocks) body = { ...body, messages: f.out };
    report.freshBlocks = f.freshBlocks; report.freshChars = f.charsSaved; report.charsSaved += f.charsSaved;
  }
  const t = extendCacheTtl(body, config.cacheTtl);
  body = t.body; report.upgraded = t.upgraded;
  const p = applyProtect(body, protect, config, session);
  body = p.body; if (p.routed) report.routed = p.routed;
  if (!p.sticky && !p.routed && (config.routing || protect.active)) {
    const r = routeModel(body, config.routeSmallModel);
    body = r.body; if (r.routed) report.routed = { ...r.routed, why: 'light turn' };
  }
  return { body, report };
}

/** Pull usage out of a streaming (SSE) or JSON response without buffering the stream. */
function usageTap(stats, isStream, meta) {
  let buf = '';
  const usage = {};
  return {
    chunk(c) {
      buf += c.toString('utf8');
      if (!isStream) return;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        try {
          const ev = JSON.parse(line.slice(5));
          if (ev.type === 'message_start') Object.assign(usage, ev.message?.usage);
          if (ev.type === 'message_delta' && ev.usage) Object.assign(usage, ev.usage);
        } catch {}
      }
    },
    end() {
      if (!isStream) { try { Object.assign(usage, JSON.parse(buf).usage); } catch {} }
      if (Object.keys(usage).length) {
        noteUsage(meta.session, usage); // learn the cache TTL Anthropic really applied
        stats.usage(usage, meta);
      }
      buf = '';
    },
  };
}

/** A connection-level failure before any response (undici reports these as TypeError "fetch failed"). */
const isConnectionError = (e) => e instanceof TypeError && /fetch failed/i.test(e.message);
const causeOf = (e) => e?.cause?.code || e?.cause?.message || e?.message || String(e);

export function createServer(config, log = console) {
  const stats = new Stats(config.dataDir);
  const startedAt = new Date().toISOString();
  const live = liveConfig(config); // picks up `ccpager on/off` without a restart
  const sessions = new Sessions();
  let lastProtect = { active: false, reason: null, at: 0 };
  const protectNow = (cfg) => { // re-evaluated at most every 5 s: summarizing the sample history isn't free
    const now = Date.now();
    if (now - lastProtect.at > 5000) {
      const d = protectDecision(summarizeLimits(stats.data.limits, now), cfg);
      if (d.active !== lastProtect.active) log.log(d.active ? `protect ON: ${d.reason}; new sessions start on ${cfg.protectModel}, light turns on ${cfg.routeSmallModel}` : 'protect off: usage pace is safe again');
      lastProtect = { ...d, at: now };
    }
    return lastProtect;
  };
  const server = http.createServer(async (req, res) => {
    const cfg = live();
    server.inflight++;
    res.once('close', () => { server.inflight--; });
    try {
      if (req.url === '/ccpager/health') {
        res.setHeader('content-type', 'application/json');
        const p = protectNow(cfg);
        res.end(JSON.stringify({ ok: true, version: VERSION, pid: process.pid, startedAt, requests: stats.data.requests, inflight: server.inflight,
          logFile: log.file || null, protect: { active: p.active, reason: p.reason },
          config: { port: cfg.port, enabled: cfg.enabled, paging: cfg.paging, cacheTtl: cfg.cacheTtl, routing: cfg.routing, protect: cfg.protect } }));
        return;
      }
      if (req.url === '/ccpager/stats') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(stats.data)); return; }

      const chunks = [];
      for await (const c of req) chunks.push(c);
      let raw = Buffer.concat(chunks);

      let report = null, session = null;
      // Only rewrite Messages API calls (incl. count_tokens). Everything else passes through untouched.
      const isMessages = req.method === 'POST' && /^\/v1\/messages(\/count_tokens)?(\?|$)/.test(req.url) && raw.length;
      const isCount = isMessages && req.url.includes('count_tokens');
      if (isMessages && !cfg.enabled) {
        // Switched off: forward the original bytes untouched, but still log and count usage.
        let model = ''; try { model = JSON.parse(raw.toString('utf8')).model; } catch {}
        report = { pagedBlocks: 0, charsSaved: 0, upgraded: 0, routed: null, off: true, model };
        if (!isCount) stats.record(report);
        log.log(`${req.url.split('?')[0]} OFF (pass-through, unchanged)`);
      } else if (isMessages) {
        try {
          const parsed = JSON.parse(raw.toString('utf8'));
          session = isCount ? null : sessions.get(parsed); // count_tokens must not advance a session's paging state
          const out = transform(parsed, cfg, session, protectNow(cfg));
          raw = Buffer.from(JSON.stringify(out.body));
          report = out.report;
          report.model = out.body.model;
          // Price cache rewrites at the TTL in force: the one seen on this session, else what we asked for.
          report.assume1h = report.ttl ? report.ttl === '1h' : cfg.cacheTtl === '1h' && report.upgraded > 0;
          if (!isCount) stats.record(report);
          // One line per request, always: this is how you confirm an editor is going through ccpager.
          const turns = Array.isArray(out.body.messages) ? out.body.messages.length : 0;
          const why = report.moved ? ` cutoff moved (${report.reason}${report.rewriteChars ? `, cache rewrite ~${Math.round(report.rewriteChars / 4)}tok` : ''})`
            : report.held ? ` held: ${report.held}, ~${Math.round(report.pendingChars / 4)}tok waiting`
            : cfg.paging && !report.pagedBlocks ? ` next cutoff in ${report.stepsUntil} steps` : '';
          log.log(`${req.url.split('?')[0]} model=${out.body.model} msgs=${turns} paged=${report.pagedBlocks}${report.freshBlocks ? ` fresh=${report.freshBlocks}` : ''} saved=~${Math.round(report.charsSaved / 4)}tok ttl+=${report.upgraded}${report.routed ? ` routed→${report.routed.to} (${report.routed.why})` : ''}${why}`);
        } catch (e) {
          log.warn('transform skipped, forwarded unchanged:', e.message); // fail open
        }
      }

      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
      const send = () => fetch(new URL(req.url, cfg.upstream), {
        method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw,
      });
      let upstream;
      try { upstream = await send(); } catch (e) {
        // The request never got a response (reset keep-alive socket, DNS blip). The body is
        // buffered, so send it once more instead of handing Claude Code a 502.
        if (!isConnectionError(e)) throw e;
        log.warn(`upstream connection failed (${causeOf(e)}); retrying once`);
        await new Promise((r) => setTimeout(r, 250));
        upstream = await send();
      }

      if (isMessages) { const lim = parseLimitHeaders(upstream.headers); if (lim) stats.limits(lim); }

      const resHeaders = {};
      upstream.headers.forEach((v, k) => { if (!HOP.has(k) && k !== 'content-encoding') resHeaders[k] = v; });
      if (report) resHeaders['x-ccpager'] = report.off ? 'off' : `paged=${report.pagedBlocks};saved=${report.charsSaved}`;
      res.writeHead(upstream.status, resHeaders);
      if (!upstream.body) { res.end(); return; }

      const tap = report && !isCount && upstream.ok
        ? usageTap(stats, (upstream.headers.get('content-type') || '').includes('event-stream'),
          { model: report.model, charsSaved: report.charsSaved, assume1h: report.assume1h, rewriteChars: report.rewriteChars || 0, session })
        : null;
      const stream = Readable.fromWeb(upstream.body);
      stream.on('data', (c) => { tap?.chunk(c); res.write(c); });
      stream.on('end', () => { tap?.end(); res.end(); });
      stream.on('error', () => res.destroy());
      req.on('close', () => { if (!res.writableEnded) stream.destroy(); });
    } catch (e) {
      log.error('upstream error:', causeOf(e));
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `ccpager: ${e.message}` } }));
    }
  });
  server.inflight = 0;
  server.on('close', () => stats.flush());
  server.stats = stats;
  /**
   * Stop accepting connections, let responses in flight finish (a long Claude turn can stream
   * for minutes), then resolve. Used on SIGTERM so a restart never cuts off a reply mid-stream.
   */
  server.drain = (maxMs = 30_000) => new Promise((resolve) => {
    server.close();
    server.closeIdleConnections?.();
    const end = Date.now() + maxMs;
    const tick = () => { if (server.inflight <= 0 || Date.now() > end) { stats.flush(); resolve(); } else setTimeout(tick, 200); };
    tick();
  });
  return server;
}
