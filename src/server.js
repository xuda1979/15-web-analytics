// 15-web-analytics HTTP server.
//
// Single Node process, no external services:
//   - /wa.js                       -> lightweight collect snippet (~1KB)
//   - /api/collect                 -> POST pageview (204)
//   - /api/overview                -> GET aggregate numbers + filters
//   - /api/realtime                -> GET realtime buckets
//   - /api/export?format=csv|json  -> GET filtered export
//   - /api/audit                   -> GET privacy report (JSON) or text
//   - /api/health                  -> GET liveness
//   - /                            -> dashboard (static HTML)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config, ensureDataDir } from './config.js';
import { openDb } from './store.js';
import { loadOrCreateSecret } from './privacy.js';
import { RateLimiter } from './ratelimit.js';
import { insertEvent, normalizeEvent, refreshEntryExit } from './collector.js';
import { pruneEvents } from './retention.js';
import {
  csvRow,
  dailySeries,
  monthlySeries,
  topPages,
  topSources,
  topDevices,
  topModels,
  topBrowsers,
  topCountries,
  topOses,
  topLanguages,
  topScreens,
  topTitles,
  topReferrers,
  entryExitPages,
  realtime,
  realtimeFiltered,
  totals,
  visitStats,
  weeklySeries,
  totalsFiltered,
  visitStatsFiltered,
  dailySeriesFiltered,
  weeklySeriesFiltered,
  monthlySeriesFiltered,
  topPagesFiltered,
  topSourcesFiltered,
  topDevicesFiltered,
  topModelsFiltered,
  topBrowsersFiltered,
  topCountriesFiltered,
  topOsesFiltered,
  topLanguagesFiltered,
  topScreensFiltered,
  topTitlesFiltered,
  topReferrersFiltered,
  entryExitFiltered,
  hourlySeries,
  hourlySeriesFiltered,
  returningStats,
  returningStatsFiltered,
} from './analytics.js';
import { exportEvents, exportSummary, exportEventsIter, CSV_COLUMNS } from './exporter.js';
import { generateAudit } from './audit.js';

ensureDataDir();
const db = openDb();
const secret = loadOrCreateSecret(config.dataDir);

// ---- static dashboard ----
let dashboardHtml = '';
const dashboardPath = path.join(config.publicDir, 'index.html');
if (fs.existsSync(dashboardPath)) {
  dashboardHtml = fs.readFileSync(dashboardPath, 'utf8');
}

const mime = {
  '.js': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
};

// Parse a bound as either epoch milliseconds (a bare integer string) or any
// Date.parse()-able format. Unparseable values return NaN so callers can
// silently ignore them.
function parseBound(value) {
  if (typeof value === 'string' && /^\d{1,15}$/.test(value.trim())) {
    const ms = Number(value.trim());
    // Bounds beyond the year 33658 overflow Date; treat as NaN like Date.parse.
    return Number.isSafeInteger(ms) && Math.abs(ms) <= Date.now() + 8.64e12 ? ms : NaN;
  }
  return Date.parse(value);
}

function parseRange(query, defaultDays = 30) {
  // `query` is a URLSearchParams (only .get() works, not property access).
  const now = Date.now();
  let days = Number.parseInt(query.get('days'), 10);
  if (!Number.isFinite(days) || days < 1) days = defaultDays;
  if (days > 3650) days = 3650;
  let end = now;
  const toParam = query.get('to');
  if (toParam) {
    const t = parseBound(toParam);
    if (Number.isFinite(t)) end = t;
  }
  let start = end - days * 24 * 3600 * 1000;
  const fromParam = query.get('from');
  if (fromParam) {
    const f = parseBound(fromParam);
    if (Number.isFinite(f)) start = f;
  }
  return { start, end };
}

// Filter predicate honoring page/source/device filters. Callers further
// constrain the scope with a time range and is_bot = 0.
function filteredQuery(filters) {
  const parts = [];
  const args = [];
  if (filters.page) {
    parts.push('path = ?');
    args.push(filters.page);
  }
  if (filters.source) {
    parts.push('COALESCE(ref_domain, \'(direct)\') = ?');
    args.push(filters.source);
  }
  if (filters.device) {
    parts.push('device = ?');
    args.push(filters.device);
  }
  return { sql: parts.join(' AND '), args };
}

function readJsonBody(req, limitBytes = 4096) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > limitBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        const parsed = raw ? JSON.parse(raw) : {};
        // The collect contract is a single JSON object. Any other JSON shape
        // (null, primitives, arrays) is a malformed payload: reject so the
        // caller answers 400 instead of letting normalizeEvent() property-
        // access a null and leak a TypeError as a misleading "internal" 500.
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new Error('invalid json'));
          return;
        }
        resolve(parsed);
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  return req.headers['x-real-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '';
}

async function handleCollect(req, res) {
  if (collectLimiter) {
    const retryMs = collectLimiter.check(clientIp(req));
    if (retryMs > 0) {
      res.writeHead(429, {
        'content-type': 'application/json',
        'retry-after': String(Math.max(1, Math.ceil(retryMs / 1000))),
      });
      res.end(JSON.stringify({ ok: false, error: 'rate limited' }));
      return;
    }
  }
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'bad payload' }));
    return;
  }
  // Reuse clientIp(req): identical alias precedence as the rate-limiter key,
  // so the identity governing throttling can never disagree with the one stored.
  const meta = {
    ip: clientIp(req),
    ua: req.headers['user-agent'] || '',
    country: req.headers['x-country'] || '',
  };
  const event = normalizeEvent(payload, meta, secret);
  insertEvent(db, event);
  res.writeHead(204);
  res.end();
}

const collectLimiter =
  config.collectRateLimit > 0
    ? new RateLimiter({ windowMs: config.collectRateWindowMs, limit: config.collectRateLimit })
    : null;

function handleOverview(req, res) {
  const q = new URL(req.url, 'http://localhost').searchParams;
  const { start, end } = parseRange(q);
  const filters = { page: q.get('page'), source: q.get('source'), device: q.get('device') };
  const fq = filteredQuery(filters);

  // Filtered reads: totals + series + top lists all share the same scope, so
  // a filtered dashboard's chart, KPIs, and lists never contradict each other.
  const hasFilter = Boolean(filters.page || filters.source || filters.device);
  let body;
  if (hasFilter) {
    const f = { sql: fq.sql, args: fq.args };
    body = {
      totals: totalsFiltered(db, start, end, f),
      visit_stats: visitStatsFiltered(db, start, end, f),
      daily: dailySeriesFiltered(db, start, end, f),
      weekly: weeklySeriesFiltered(db, start, end, f),
      monthly: monthlySeriesFiltered(db, start, end, f),
      pages: topPagesFiltered(db, start, end, 50, f),
      sources: topSourcesFiltered(db, start, end, 50, f),
      devices: topDevicesFiltered(db, start, end, 50, f),
      models: topModelsFiltered(db, start, end, 50, f),
      browsers: topBrowsersFiltered(db, start, end, 50, f),
      countries: topCountriesFiltered(db, start, end, 50, f),
      oses: topOsesFiltered(db, start, end, 50, f),
      languages: topLanguagesFiltered(db, start, end, 50, f),
      screens: topScreensFiltered(db, start, end, 50, f),
      titles: topTitlesFiltered(db, start, end, 50, f),
      referrers: topReferrersFiltered(db, start, end, 50, f),
      hourly: hourlySeriesFiltered(db, start, end, f),
      paths: entryExitFiltered(db, start, end, 50, f),
      returning: returningStatsFiltered(db, start, end, f),
      range: { start, end, days: Math.round((end - start) / 864e5) },
      filters,
    };
  } else {
    body = {
      totals: totals(db, start, end),
      visit_stats: visitStats(db, start, end),
      daily: dailySeries(db, start, end),
      weekly: weeklySeries(db, start, end),
      monthly: monthlySeries(db, start, end),
      pages: topPages(db, start, end, 50),
      sources: topSources(db, start, end, 50),
      devices: topDevices(db, start, end, 50),
      models: topModels(db, start, end, 50),
      browsers: topBrowsers(db, start, end, 50),
      countries: topCountries(db, start, end, 50),
      oses: topOses(db, start, end, 50),
      languages: topLanguages(db, start, end, 50),
      screens: topScreens(db, start, end, 50),
      titles: topTitles(db, start, end, 50),
      referrers: topReferrers(db, start, end, 50),
      hourly: hourlySeries(db, start, end),
      paths: entryExitPages(db, start, end, 50),
      returning: returningStats(db, start, end),
      range: { start, end, days: Math.round((end - start) / 864e5) },
      filters,
    };
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function handleRealtime(req, res) {
  const q = new URL(req.url, 'http://localhost').searchParams;
  const filters = { page: q.get('page'), source: q.get('source'), device: q.get('device') };
  // A filtered poll must share the dashboard's scope: the badge and sparkline
  // describe the same filtered traffic as the overview cards, not all traffic.
  const hasFilter = Boolean(filters.page || filters.source || filters.device);
  const body = hasFilter ? realtimeFiltered(db, filteredQuery(filters)) : realtime(db);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function handleExport(req, res) {
  const q = new URL(req.url, 'http://localhost').searchParams;
  const { start, end } = parseRange(q, 30);
  const format = q.get('format') === 'csv' ? 'csv' : 'json';
  const summary = q.get('summary') === '1';
  const filters = { page: q.get('page'), source: q.get('source'), device: q.get('device') };
  const ct = format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json';
  const cd = format === 'csv' ? `attachment; filename="events-${dayKey(start)}-${dayKey(end)}.csv"` : undefined;
  res.writeHead(200, { 'content-type': ct, ...(cd ? { 'content-disposition': cd } : {}) });

  // A HEAD probe asks for the same representation as GET (RFC 9110 §9.3.2)
  // with no body; Node suppresses the body for us, but running the streaming
  // loop below would still iterate and serialize every row in range just to
  // throw the output away. Headers are already sent above, so stop here.
  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  if (!summary) {
    // Raw event export: stream rows out of SQLite so a multi-year export never
    // materializes the full result (or a single giant body string) in memory.
    // JSON and CSV writes below are byte-identical to the previous one-shot
    // bodies; res.write() buffers in Node, so row-by-row writes stay cheap.
    //
    // The iterator is stepped manually so the loop can yield to the event
    // loop every YIELD_EVERY rows: a synchronous for...of over a multi-year
    // range keeps the single thread busy for seconds and starves every other
    // request (pageview collect, health, dashboard) — an availability DoS.
    // A periodic setImmediate let interleaved requests run, and a destroyed
    // response (client aborted) stops the scan instead of iterating the rest
    // of the range just to write into a dead socket.
    const fq = filters.page || filters.source || filters.device ? filteredQuery(filters) : null;
    const YIELD_EVERY = 256;
    const streamAll = async (writeRow) => {
      const iter = exportEventsIter(db, start, end, fq)[Symbol.iterator]();
      let n = 0;
      try {
        for (;;) {
          if (res.destroyed) {
            iter.return();
            return;
          }
          const step = iter.next();
          if (step.done) return;
          // Backpressure: when the response buffer is full (res.write() returned
          // false, meaning the client reads slower than we produce), park until
          // the socket drains instead of letting Node buffer the entire export in
          // memory. The 'close' escape keeps the loop from hanging when the
          // client goes away mid-drain; the next iteration's destroyed-check then
          // stops the scan and releases the statement.
          if (writeRow(step.value) === false) {
            await new Promise((resolve) => {
              const finish = () => {
                res.off('drain', finish);
                res.off('close', finish);
                resolve();
              };
              res.once('drain', finish);
              res.once('close', finish);
            });
          }
          if (++n % YIELD_EVERY === 0) await new Promise((resolve) => setImmediate(resolve));
        }
      } catch (err) {
        // A read can throw mid-export (interrupted/corrupt/locked page). Release
        // the statement from the shared connection so later requests don't trip
        // a lingering lock, then let the top-level catch handle the response.
        iter.return();
        throw err;
      }
    };
    if (format === 'csv') {
      // Prefix a UTF-8 BOM so Windows Excel decodes the export as UTF-8 and
      // renders multibyte text (Chinese titles/referrers) correctly instead of
      // re-decoding the byte stream as ANSI/GBK and showing mojibake.
      res.write('\ufeff');
      res.write(CSV_COLUMNS.join(',') + '\n');
      await streamAll((row) => res.write(csvRow({ ...row, visitsSerial: undefined }, CSV_COLUMNS) + '\n'));
    } else {
      res.write('[');
      let first = true;
      await streamAll((row) => {
        const out = (first ? '' : ',') + JSON.stringify(row);
        first = false;
        return res.write(out);
      });
      res.write(']');
    }
    res.end();
    return;
  }

  // Summary export aggregates the whole range first (aggregate-sized, so it
  // stays materialized like the dashboard itself).
  let data;
  if (filters.page || filters.source || filters.device) {
    // Summary export honors active filters like the dashboard does.
    const f = filteredQuery(filters);
    data = exportSummary(db, start, end, format, f);
  } else {
    data = exportSummary(db, start, end, format);
  }
  let body = typeof data === 'string' ? data : JSON.stringify(data);
  if (format === 'csv') {
    // Prefix a UTF-8 BOM so Windows Excel decodes the export as UTF-8.
    body = '\ufeff' + body;
  }
  res.end(body);
}

function handleAudit(req, res) {
  const q = new URL(req.url, 'http://localhost').searchParams;
  const asText = q.get('format') === 'text' || q.get('text') === '1';
  const audit = generateAudit(db);
  if (asText) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    const lines = [
      `Privacy Audit Report — 15-web-analytics`,
      `Generated: ${audit.generated_at}`,
      ``,
      `Data flow:`,
      ...audit.data_flow.map((s) => `  ${s.step}. ${s.actor}: ${s.action}`),
      ``,
      `Checks:`,
      ...audit.checks.map((c) => `  [${c.status.toUpperCase()}] ${c.label} — ${c.detail}`),
      ``,
      `Stats: events=${audit.stats.events} real=${audit.stats.real_events} guests=${audit.stats.guests} ip_rows=${audit.stats.ip_rows}`,
      `DB: ${audit.stats.db_path} (${audit.stats.bytes_readable})`,
    ];
    res.end(lines.join('\n') + '\n');
  } else {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(audit, null, 2));
  }
}

function notFound(res) {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
}

// HEAD must behave exactly like GET (RFC 9110 §9.3.2) except that the server
// sends no response body; Node suppresses the body for HEAD automatically, so
// the GET handlers can serve both. Without this, curl -I and HEAD-based uptime
// probes hit the catch-all and get a 404 for every read route.
const isRead = (req) => req.method === 'GET' || req.method === 'HEAD';

export function createServer() {
  const snippetPath = config.snippetPath;
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${config.host}:${config.port}`);

    // Never set cookies.
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

    // Baseline hardening headers. The dashboard is self-contained (no external
    // dependencies), and the snippet/API endpoints are plain data, so a strict
    // CSP with frame-ancestors 'none' cannot break self-hosting.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
    // The dashboard page ships one inline <script> + one inline <style> block
    // with no external resources, so 'unsafe-inline' applies only to the page
    // itself; the API and snippet are JSON/text and unaffected by CSP.
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
    }

    try {
      // Snippet route.
      if (isRead(req) && url.pathname === snippetPath) {
        handleSnippet(res);
        return;
      }
      // API.
      if (req.method === 'POST' && url.pathname === config.collectPath) {
        await handleCollect(req, res);
        return;
      }
      if (isRead(req) && (url.pathname === config.overviewPath || url.pathname === '/api/overview')) {
        handleOverview(req, res);
        return;
      }
      if (isRead(req) && url.pathname === config.realtimePath) {
        handleRealtime(req, res);
        return;
      }
      if (isRead(req) && (url.pathname === config.exportPath || url.pathname === '/api/export')) {
        await handleExport(req, res);
        return;
      }
      if (isRead(req) && (url.pathname === config.auditPath || url.pathname === '/api/audit')) {
        handleAudit(req, res);
        return;
      }
      if (isRead(req) && url.pathname === '/api/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ts: Date.now() }));
        return;
      }
      if (isRead(req) && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(dashboardHtml || '<h1>dashboard not built</h1>');
        return;
      }
      // Static.
      if (isRead(req) && url.pathname.startsWith('/static/')) {
        const rel = url.pathname.slice('/static/'.length);
        const file = path.join(config.publicDir, rel);
        const resolved = path.resolve(file);
        // Containment guard: resolved must be publicDir itself or a descendant.
        // A bare prefix compare would also admit a sibling directory that merely
        // shares the prefix (e.g. <publicDir>-other), so require the separator.
        const inside = resolved === config.publicDir || resolved.startsWith(config.publicDir + path.sep);
        let isFile = false;
        if (inside) {
          try {
            isFile = fs.statSync(resolved).isFile();
          } catch {
            isFile = false;
          }
        }
        if (!inside || !isFile) {
          notFound(res);
          return;
        }
        res.writeHead(200, { 'content-type': mime[path.extname(resolved)] || 'application/octet-stream' });
        // A read stream can error after the stat guard: the file may be deleted
        // or lose read permission between statSync and open, or hit EMFILE. An
        // unattached 'error' event would be unhandled and crash the process, so
        // destroy the (already-headered) response instead of crashing.
        fs.createReadStream(resolved)
          .on('error', () => res.destroy())
          .pipe(res);
        return;
      }
      notFound(res);
    } catch (err) {
      console.error('[server] error', err.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'internal' }));
      } else {
        // Headers already on the wire (e.g. a streaming export whose SQLite
        // read threw mid-body), so no 500 is possible: the status line is out.
        // Destroying the socket tells the client the response is truncated
        // instead of leaving it waiting forever on a connection that will
        // never end — a hung-request availability defect.
        res.destroy();
      }
    }
  });
}

// Minified ~1KB snippet (also served from public/wa.js for tests).
function handleSnippet(res) {
  const files = [path.join(config.publicDir, 'wa.js'), path.join(import.meta.dirname, '..', 'public', 'wa.js')];
  for (const f of files) {
    if (fs.existsSync(f)) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      // Same recovery as /static/: an open failure races the existsSync probe
      // and must not surface as an unhandled 'error' event crash.
      fs.createReadStream(f)
        .on('error', () => res.destroy())
        .pipe(res);
      return;
    }
  }
  notFound(res);
}

function serverStart() {
  const server = createServer();
  // A listen failure must never surface as an unhandled 'error' event or a raw
  // stack trace: an out-of-range WA_PORT (e.g. 70000) makes listen() throw
  // synchronously (ERR_SOCKET_BAD_PORT), a take-over of an already-bound port
  // arrives as an async 'error' event (EADDRINUSE, e.g. a stale instance from
  // a previous run), and a privileged port / bad host follow the same async
  // path (EACCES / EADDRNOTAVAIL). Both paths are caught here and turned into
  // one deterministic, self-describing failure: log the reason to stderr and
  // exit 1 — the same exit code the unhandled crash produced — so the operator
  // (or a health probe) sees why the service cannot start.
  const listenFailed = (err) => {
    console.error(
      `[server] cannot listen on http://${config.host}:${config.port}: ${err.code || err.name} — ${err.message}`,
    );
    process.exit(1);
  };
  server.on('error', listenFailed);
  try {
    server.listen(config.port, config.host, () => {
      console.log(`15-web-analytics listening on http://${config.host}:${config.port}`);
      console.log(`  dashboard  http://localhost:${config.port}/`);
      console.log(`  snippet    http://localhost:${config.port}${config.snippetPath}`);
      console.log(`  data       ${config.dbPath}`);
    });
  } catch (err) {
    listenFailed(err);
  }

  // Graceful shutdown: stop accepting connections, drain in-flight requests,
  // then close the DB so no WAL frame is lost mid-flight (e.g. docker stop).
  const shutdown = (signal) => {
    console.log(`received ${signal}, shutting down`);
    server.close(() => {
      try {
        db.close();
      } catch {}
      process.exit(0);
    });
    // Force-exit if in-flight requests hang (e.g. an open keep-alive).
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  return server;
}

// Start the server when run directly (`npm start`). Imported as a library
// during tests, this block is skipped (the test boots via startServer()).
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  setInterval(() => {
    try {
      refreshEntryExit(db, Date.now() - 2 * 24 * 3600 * 1000);
    } catch (e) {
      console.error('refresh failed', e);
    }
  }, 5 * 60 * 1000).unref();
  // Run refresh at startup so visit edges are correct after a restart
  // (provisional + legacy visit_key backfill).
  try {
    refreshEntryExit(db, Date.now() - 2 * 24 * 3600 * 1000);
  } catch (e) {
    console.error('startup refresh failed', e);
  }
  // Automatic data retention: prune events older than WA_RETENTION_DAYS at
  // startup and every 6h. Disabled when WA_RETENTION_DAYS is 0/absent.
  if (config.retentionDays > 0) {
    const schedulePrune = () => {
      try {
        const cutoff = Date.now() - config.retentionDays * 24 * 3600 * 1000;
        const { deleted } = pruneEvents(db, cutoff);
        if (deleted > 0) {
          console.log(`[retention] pruned ${deleted} events older than ${config.retentionDays}d`);
        }
      } catch (e) {
        console.error('[retention] prune failed', e);
      }
    };
    schedulePrune();
    setInterval(schedulePrune, 6 * 3600 * 1000).unref();
  }
  serverStart();
}

import { pathToFileURL } from 'node:url';
import { dayKey } from './store.js';

// Exports for tests / embedding.
export { db as __db };
