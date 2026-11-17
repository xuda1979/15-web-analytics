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

function parseRange(query, defaultDays = 30) {
  // `query` is a URLSearchParams (only .get() works, not property access).
  const now = Date.now();
  let days = Number.parseInt(query.get('days'), 10);
  if (!Number.isFinite(days) || days < 1) days = defaultDays;
  if (days > 3650) days = 3650;
  let end = now;
  const toParam = query.get('to');
  if (toParam) {
    const t = Date.parse(toParam);
    if (Number.isFinite(t)) end = t;
  }
  let start = end - days * 24 * 3600 * 1000;
  const fromParam = query.get('from');
  if (fromParam) {
    const f = Date.parse(fromParam);
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
        resolve(raw ? JSON.parse(raw) : {});
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
  const meta = {
    ip: req.headers['x-real-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '',
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
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(realtime(db)));
}

function handleExport(req, res) {
  const q = new URL(req.url, 'http://localhost').searchParams;
  const { start, end } = parseRange(q, 30);
  const format = q.get('format') === 'csv' ? 'csv' : 'json';
  const summary = q.get('summary') === '1';
  const filters = { page: q.get('page'), source: q.get('source'), device: q.get('device') };
  const ct = format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json';
  const cd = format === 'csv' ? `attachment; filename="events-${dayKey(start)}-${dayKey(end)}.csv"` : undefined;
  res.writeHead(200, { 'content-type': ct, ...(cd ? { 'content-disposition': cd } : {}) });

  if (!summary) {
    // Raw event export: stream rows out of SQLite so a multi-year export never
    // materializes the full result (or a single giant body string) in memory.
    // JSON and CSV writes below are byte-identical to the previous one-shot
    // bodies; res.write() buffers in Node, so row-by-row writes stay cheap.
    const fq = filters.page || filters.source || filters.device ? filteredQuery(filters) : null;
    if (format === 'csv') {
      // Prefix a UTF-8 BOM so Windows Excel decodes the export as UTF-8 and
      // renders multibyte text (Chinese titles/referrers) correctly instead of
      // re-decoding the byte stream as ANSI/GBK and showing mojibake.
      res.write('\ufeff');
      res.write(CSV_COLUMNS.join(',') + '\n');
      for (const row of exportEventsIter(db, start, end, fq)) {
        res.write(csvRow({ ...row, visitsSerial: undefined }, CSV_COLUMNS) + '\n');
      }
    } else {
      res.write('[');
      let first = true;
      for (const row of exportEventsIter(db, start, end, fq)) {
        if (!first) res.write(',');
        res.write(JSON.stringify(row));
        first = false;
      }
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
      if (url.pathname === snippetPath) {
        handleSnippet(res);
        return;
      }
      // API.
      if (req.method === 'POST' && url.pathname === config.collectPath) {
        await handleCollect(req, res);
        return;
      }
      if (req.method === 'GET' && (url.pathname === config.overviewPath || url.pathname === '/api/overview')) {
        handleOverview(req, res);
        return;
      }
      if (req.method === 'GET' && url.pathname === config.realtimePath) {
        handleRealtime(req, res);
        return;
      }
      if (req.method === 'GET' && (url.pathname === config.exportPath || url.pathname === '/api/export')) {
        handleExport(req, res);
        return;
      }
      if (req.method === 'GET' && (url.pathname === config.auditPath || url.pathname === '/api/audit')) {
        handleAudit(req, res);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ts: Date.now() }));
        return;
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(dashboardHtml || '<h1>dashboard not built</h1>');
        return;
      }
      // Static.
      if (req.method === 'GET' && url.pathname.startsWith('/static/')) {
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
        fs.createReadStream(resolved).pipe(res);
        return;
      }
      notFound(res);
    } catch (err) {
      console.error('[server] error', err.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'internal' }));
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
      fs.createReadStream(f).pipe(res);
      return;
    }
  }
  notFound(res);
}

function serverStart() {
  const server = createServer();
  server.listen(config.port, config.host, () => {
    console.log(`15-web-analytics listening on http://${config.host}:${config.port}`);
    console.log(`  dashboard  http://localhost:${config.port}/`);
    console.log(`  snippet    http://localhost:${config.port}${config.snippetPath}`);
    console.log(`  data       ${config.dbPath}`);
  });

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
