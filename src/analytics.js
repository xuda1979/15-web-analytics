// Read-side analytics: time series, top lists, entry/exit, realtime, and CSV.

import { config } from './config.js';
import { dayKey, weekStart } from './store.js';

export function dayKeysBetween(startMs, endMs) {
  const keys = [];
  const cur = new Date(startMs);
  cur.setUTCHours(0, 0, 0, 0);
  while (cur.getTime() <= endMs) {
    keys.push(dayKey(cur.getTime()));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return keys;
}

// Ranges are upper-bound INCLUSIVE. The common dashboard query sets end to
// Date.now() at read time; a pageview inserted in the same millisecond would
// otherwise be invisible until the next request (ts < end excludes it).
function whereClause(startMs, endMs) {
  return { sql: 'ts >= ? AND ts <= ?', args: [startMs, endMs] };
}

// Pageviews + unique visitors per day for the requested range.
export function dailySeries(db, startMs, endMs) {
  const days = dayKeysBetween(startMs, endMs);
  const rows = db
    .prepare(
      `SELECT day AS d, SUM(visits) AS visits, SUM(uniques) AS uniques
       FROM agg_daily_realtime WHERE day >= ? AND day <= ?
       GROUP BY day`,
    )
    .all(dayKey(startMs), dayKey(endMs));
  const byDay = new Map(rows.map((r) => [r.d, r]));
  return days.map((d) => {
    const r = byDay.get(d);
    return { date: d, visits: r ? Number(r.visits) : 0, uniques: r ? Number(r.uniques) : 0 };
  });
}

export function weeklySeries(db, startMs, endMs) {
  const sm = weekStart(startMs).getTime();
  const em = endMs;
  const rows = db
    .prepare(
      `SELECT start, SUM(visits) AS visits, SUM(uniques) AS uniques
       FROM agg_monthly_buckets WHERE bucket='week' AND start >= ? AND start <= ?
       GROUP BY start ORDER BY start`,
    )
    .all(sm, em);
  const weeks = [];
  for (let t = sm; t <= em; t += 7 * 24 * 3600 * 1000) weeks.push(t);
  const byStart = new Map(rows.map((r) => [r.start, r]));
  return weeks.map((t) => {
    const r = byStart.get(t);
    return {
      week: new Date(t).toISOString().slice(0, 10),
      start: t,
      visits: r ? Number(r.visits) : 0,
      uniques: r ? Number(r.uniques) : 0,
    };
  });
}

export function monthlySeries(db, startMs, endMs) {
  const sm = new Date(startMs);
  sm.setUTCDate(1);
  sm.setUTCHours(0, 0, 0, 0);
  const em = endMs;
  const rows = db
    .prepare(
      `SELECT start, SUM(visits) AS visits, SUM(uniques) AS uniques
       FROM agg_monthly_buckets WHERE bucket='month' AND start >= ? AND start <= ?
       GROUP BY start ORDER BY start`,
    )
    .all(sm.getTime(), em);
  const months = [];
  for (let t = sm.getTime(); t <= em;) {
    months.push(t);
    const d = new Date(t);
    d.setUTCMonth(d.getUTCMonth() + 1, 1);
    d.setUTCHours(0, 0, 0, 0);
    t = d.getTime();
  }
  const byStart = new Map(rows.map((r) => [r.start, r]));
  return months.map((t) => {
    const r = byStart.get(t);
    return {
      month: new Date(t).toISOString().slice(0, 7),
      start: t,
      visits: r ? Number(r.visits) : 0,
      uniques: r ? Number(r.uniques) : 0,
    };
  });
}

function topQuery(db, groupCol, labelCol, startMs, endMs, limit) {
  const w = whereClause(startMs, endMs);
  return db
    .prepare(
      `SELECT ${groupCol} AS label, COUNT(*) AS visits,
              COUNT(DISTINCT CASE WHEN is_bot = 0 THEN guest_key END) AS uniques
       FROM events
       WHERE ${w.sql} AND is_bot = 0
       GROUP BY ${groupCol} ORDER BY visits DESC LIMIT ?`,
    )
    .all(...w.args, limit)
    .map((r) => ({
      [labelCol]: r.label,
      visits: Number(r.visits),
      uniques: Number(r.uniques),
    }));
}

export function topPages(db, startMs, endMs, limit = 10) {
  return topQuery(db, 'path', 'path', startMs, endMs, limit);
}

export function topSources(db, startMs, endMs, limit = 10) {
  return db
    .prepare(
      `SELECT COALESCE(ref_domain, '(direct)') AS label, COUNT(*) AS visits,
              COUNT(DISTINCT CASE WHEN is_bot = 0 THEN guest_key END) AS uniques
       FROM events WHERE ts >= ? AND ts <= ? AND is_bot = 0
       GROUP BY label ORDER BY visits DESC LIMIT ?`,
    )
    .all(startMs, endMs, limit)
    .map((r) => ({
      source: r.label,
      visits: Number(r.visits),
      uniques: Number(r.uniques),
    }));
}

export function topDevices(db, startMs, endMs, limit = 10) {
  return topQuery(db, 'device', 'device', startMs, endMs, limit);
}

// The stored browser_version column has no other read path; attach the
// dominant (most frequent, ties broken lexicographically) version to each
// browser so the breakdown is actually useful ("Chrome 120" vs "Chrome 121").
function attachBrowserVersions(db, rows, startMs, endMs, extraSql, extraArgs) {
  if (!rows.length) return rows;
  const names = rows.map((r) => r.browser);
  const where = ['ts >= ?', 'ts <= ?', 'is_bot = 0', `browser IN (${names.map(() => '?').join(',')})`];
  if (extraSql) where.push(extraSql);
  const versionRows = db
    .prepare(
      `SELECT browser, browser_version AS bv, COUNT(*) AS c
       FROM events WHERE ${where.join(' AND ')}
         AND browser_version IS NOT NULL AND browser_version != ''
       GROUP BY browser, bv ORDER BY c DESC, bv`,
    )
    .all(startMs, endMs, ...names, ...(extraArgs || []));
  const best = new Map();
  for (const v of versionRows) if (!best.has(v.browser)) best.set(v.browser, v.bv);
  return rows.map((r) => ({ ...r, version: best.get(r.browser) || null }));
}

export function topBrowsers(db, startMs, endMs, limit = 10) {
  const rows = topQuery(db, 'browser', 'browser', startMs, endMs, limit);
  return attachBrowserVersions(db, rows, startMs, endMs, '', []);
}

// The country column is populated from the x-country header and is NULL when a
// visit carries no resolved region. Exclude unknown/empty rows so the breakdown
// never shows a literal "null" label — same policy as languages, screens,
// titles, and referrers. Regionless traffic still counts toward totals.
export function topCountries(db, startMs, endMs, limit = 10) {
  const w = whereClause(startMs, endMs);
  return db
    .prepare(
      `SELECT country AS label, COUNT(*) AS visits,
              COUNT(DISTINCT CASE WHEN is_bot = 0 THEN guest_key END) AS uniques
       FROM events
       WHERE ${w.sql} AND is_bot = 0 AND country IS NOT NULL AND country != ''
       GROUP BY country ORDER BY visits DESC LIMIT ?`,
    )
    .all(...w.args, limit)
    .map((r) => ({ country: r.label, visits: Number(r.visits), uniques: Number(r.uniques) }));
}

export function topOses(db, startMs, endMs, limit = 10) {
  return topQuery(db, 'os', 'os', startMs, endMs, limit);
}

// The lang column is stored at collect time and carried in raw exports, but
// has no other read path; surface it as a breakdown so the dashboard answers
// "which languages are the visitors using?". Empty lang rows (payloads that
// omitted it) are excluded via the IS NOT NULL guard — same as topSources.
export function topLanguages(db, startMs, endMs, limit = 10) {
  const w = whereClause(startMs, endMs);
  return db
    .prepare(
      `SELECT lang AS label, COUNT(*) AS visits,
              COUNT(DISTINCT CASE WHEN is_bot = 0 THEN guest_key END) AS uniques
       FROM events
       WHERE ${w.sql} AND is_bot = 0 AND lang IS NOT NULL AND lang != ''
       GROUP BY lang ORDER BY visits DESC LIMIT ?`,
    )
    .all(...w.args, limit)
    .map((r) => ({ lang: r.label, visits: Number(r.visits), uniques: Number(r.uniques) }));
}

// The screen_w/screen_h columns are captured at collect time and carried in
// raw exports, but never aggregated. Surface them as a screen-size breakdown
// ("1920x1080"). Rows missing either dimension are excluded.
export function topScreens(db, startMs, endMs, limit = 10) {
  const w = whereClause(startMs, endMs);
  return db
    .prepare(
      `SELECT screen_w || 'x' || screen_h AS label, COUNT(*) AS visits,
              COUNT(DISTINCT CASE WHEN is_bot = 0 THEN guest_key END) AS uniques
       FROM events
       WHERE ${w.sql} AND is_bot = 0 AND screen_w IS NOT NULL AND screen_h IS NOT NULL
       GROUP BY label ORDER BY visits DESC LIMIT ?`,
    )
    .all(...w.args, limit)
    .map((r) => ({ screen: r.label, visits: Number(r.visits), uniques: Number(r.uniques) }));
}

// Activity by hour of day (UTC), zero-filled across a full 24-hour axis so a
// sparse day still renders a complete distribution. The aggregate caches carry
// no hour-of-day dimension, so this reads raw events (same ts-indexed scan the
// filtered paths use).
export function hourlySeries(db, startMs, endMs) {
  const w = whereClause(startMs, endMs);
  const rows = db
    .prepare(
      `SELECT CAST(strftime('%H', ts / 1000, 'unixepoch') AS INTEGER) AS hour,
              COUNT(*) AS visits,
              COUNT(DISTINCT CASE WHEN is_bot = 0 THEN guest_key END) AS uniques
       FROM events
       WHERE ${w.sql} AND is_bot = 0
       GROUP BY hour`,
    )
    .all(...w.args);
  const byHour = new Map(rows.map((r) => [r.hour, r]));
  return Array.from({ length: 24 }, (_, hour) => {
    const r = byHour.get(hour);
    return { hour, visits: r ? Number(r.visits) : 0, uniques: r ? Number(r.uniques) : 0 };
  });
}

export function hourlySeriesFiltered(db, startMs, endMs, fq) {
  const rows = db
    .prepare(
      `SELECT CAST(strftime('%H', ts / 1000, 'unixepoch') AS INTEGER) AS hour,
              COUNT(*) AS visits,
              COUNT(DISTINCT CASE WHEN is_bot = 0 THEN guest_key END) AS uniques
       FROM events
       WHERE ts >= ? AND ts <= ? AND is_bot = 0 AND ${fq.sql}
       GROUP BY hour`,
    )
    .all(startMs, endMs, ...fq.args);
  const byHour = new Map(rows.map((r) => [r.hour, r]));
  return Array.from({ length: 24 }, (_, hour) => {
    const r = byHour.get(hour);
    return { hour, visits: r ? Number(r.visits) : 0, uniques: r ? Number(r.uniques) : 0 };
  });
}

// Entry and exit pages, counted per visit.
//
// The incremental `agg_daily_pages.entries/exits` counters are not maintained
// here because they would need to track which event within a visit is the true
// "last" one, and the provisional exit edge is only finalized by
// refreshEntryExit. Instead we derive exact per-visit counts from `events`
// using `visit_key` (the first event's ts, shared by every event of a visit):
//   entries = the FIRST event of each visit   -> path of MIN(id) per visit_key
//   exits   = the LAST  event of each visit   -> path of MAX(id) per visit_key
// A 3-page visit contributes exactly one entry + one exit. Bots are excluded.
export function entryExitPages(db, startMs, endMs, limit = 10) {
  const w = whereClause(startMs, endMs);
  const entries = db
    .prepare(
      `WITH first_of_visit AS (
          SELECT path FROM events
          WHERE ${w.sql} AND is_bot = 0 AND visit_key IS NOT NULL
            AND id = (SELECT MIN(id) FROM events e2
                      WHERE e2.visit_key = events.visit_key AND e2.is_bot = 0
                        AND ${w.sql})
       )
       SELECT path, COUNT(*) AS visits
       FROM first_of_visit GROUP BY path ORDER BY visits DESC LIMIT ?`,
    )
    .all(...w.args, ...w.args, limit)
    .map((r) => ({ path: r.path, visits: Number(r.visits) }));
  const exits = db
    .prepare(
      `WITH last_of_visit AS (
          SELECT path FROM events
          WHERE ${w.sql} AND is_bot = 0 AND visit_key IS NOT NULL
            AND id = (SELECT MAX(id) FROM events e2
                      WHERE e2.visit_key = events.visit_key AND e2.is_bot = 0
                        AND ${w.sql})
       )
       SELECT path, COUNT(*) AS visits
       FROM last_of_visit GROUP BY path ORDER BY visits DESC LIMIT ?`,
    )
    .all(...w.args, ...w.args, limit)
    .map((r) => ({ path: r.path, visits: Number(r.visits) }));
  return { entries, exits };
}

// Realtime: events in the last `windowMs`, grouped into 1m buckets.
// The window is clamped at both ends ([start, now]) so a delayed/out-of-order
// event with a future minute-stamp cannot inflate a bucket past `now`.
export function realtime(db, now = Date.now()) {
  const start = now - config.realtimeWindowMs;
  const rows = db
    .prepare(
      `SELECT bucket1m, SUM(visits) AS visits, SUM(uniques) AS uniques
       FROM agg_daily_realtime WHERE bucket1m >= ? AND bucket1m <= ?
       GROUP BY bucket1m ORDER BY bucket1m`,
    )
    .all(start, now);
  if (!rows.length) {
    return { buckets: [], current: { visits: 0, uniques: 0 } };
  }
  const current = rows[rows.length - 1];
  return {
    buckets: rows.map((r) => ({
      ts: Number(r.bucket1m),
      visits: Number(r.visits),
      uniques: Number(r.uniques),
    })),
    current: { visits: Number(current.visits), uniques: Number(current.uniques) },
  };
}

export function totals(db, startMs, endMs) {
  const w = whereClause(startMs, endMs);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS visits, COUNT(DISTINCT guest_key) AS uniques
       FROM events WHERE ${w.sql} AND is_bot = 0`,
    )
    .get(...w.args);
  return { visits: Number(row?.visits || 0), uniques: Number(row?.uniques || 0) };
}

// Visit-level engagement: sessions, bounces, and average duration. A visit is
// all events sharing a `visit_key` (the first event's ts); sessions are the
// distinct visit_keys with activity in the period. A visit counts as a bounce
// when it contributes exactly one pageview. Duration is last - first event in
// the period (single-event visits contribute 0), so the average stays honest
// and cannot grow without multi-page sessions.
export function visitStats(db, startMs, endMs) {
  const row = db
    .prepare(
      `WITH visit_stats AS (
          SELECT visit_key,
                 COUNT(*) AS events,
                 MIN(ts)   AS first_ts,
                 MAX(ts)   AS last_ts
          FROM events
          WHERE ts >= ? AND ts <= ? AND is_bot = 0 AND visit_key IS NOT NULL
          GROUP BY visit_key
       )
       SELECT COUNT(*) AS sessions,
              SUM(CASE WHEN events = 1 THEN 1 ELSE 0 END) AS bounces,
              COALESCE(AVG(last_ts - first_ts), 0) AS avg_duration_ms
       FROM visit_stats`,
    )
    .get(startMs, endMs);
  return normalizeVisitStats(row);
}

export function visitStatsFiltered(db, startMs, endMs, fq) {
  const row = db
    .prepare(
      `WITH visit_stats AS (
          SELECT visit_key,
                 COUNT(*) AS events,
                 MIN(ts)   AS first_ts,
                 MAX(ts)   AS last_ts
          FROM events
          WHERE ts >= ? AND ts <= ? AND is_bot = 0 AND visit_key IS NOT NULL
            AND ${fq.sql}
          GROUP BY visit_key
       )
       SELECT COUNT(*) AS sessions,
              SUM(CASE WHEN events = 1 THEN 1 ELSE 0 END) AS bounces,
              COALESCE(AVG(last_ts - first_ts), 0) AS avg_duration_ms
       FROM visit_stats`,
    )
    .get(startMs, endMs, ...fq.args);
  return normalizeVisitStats(row);
}

function normalizeVisitStats(row) {
  const sessions = Number(row?.sessions || 0);
  const bounces = Number(row?.bounces || 0);
  return {
    sessions,
    bounces,
    bounce_rate: sessions ? Math.round((bounces / sessions) * 1000) / 10 : 0,
    avg_duration_ms: Math.round(Number(row?.avg_duration_ms || 0)),
  };
}

// ---- Filtered read paths ---------------------------------------------------
// When page/source/device filters are active the aggregate caches (which only
// carry the date dimension) cannot answer the query, so we fall back to a
// direct read of `events`. The ts index bounds the scan and the dashboard
// ranges are small; unfiltered views keep using the incremental caches.
export function totalsFiltered(db, startMs, endMs, fq) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS visits, COUNT(DISTINCT guest_key) AS uniques
       FROM events WHERE ts >= ? AND ts <= ? AND is_bot = 0 AND ${fq.sql}`,
    )
    .get(startMs, endMs, ...fq.args);
  return { visits: Number(row?.visits || 0), uniques: Number(row?.uniques || 0) };
}

export function dailySeriesFiltered(db, startMs, endMs, fq) {
  const days = dayKeysBetween(startMs, endMs);
  const rows = db
    .prepare(
      `SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch') AS d,
              COUNT(*) AS visits,
              COUNT(DISTINCT guest_key) AS uniques
       FROM events
       WHERE ts >= ? AND ts <= ? AND is_bot = 0 AND ${fq.sql}
       GROUP BY d`,
    )
    .all(startMs, endMs, ...fq.args);
  const byDay = new Map(rows.map((r) => [r.d, r]));
  return days.map((d) => {
    const r = byDay.get(d);
    return { date: d, visits: r ? Number(r.visits) : 0, uniques: r ? Number(r.uniques) : 0 };
  });
}

export function weeklySeriesFiltered(db, startMs, endMs, fq) {
  const rows = db
    .prepare(
      `SELECT strftime('%Y-%m-%d',
                      (ts / 1000 - ((strftime('%w', ts / 1000, 'unixepoch') + 6) % 7) * 86400),
                      'unixepoch') AS wk,
              COUNT(*) AS visits,
              COUNT(DISTINCT guest_key) AS uniques
       FROM events
       WHERE ts >= ? AND ts <= ? AND is_bot = 0 AND ${fq.sql}
       GROUP BY wk ORDER BY wk`,
    )
    .all(startMs, endMs, ...fq.args);
  const sm = weekStart(startMs).getTime();
  const weeks = [];
  for (let t = sm; t <= endMs; t += 7 * 24 * 3600 * 1000) weeks.push(t);
  const byKey = new Map(rows.map((r) => [r.wk, r]));
  return weeks.map((t) => {
    const key = new Date(t).toISOString().slice(0, 10);
    const r = byKey.get(key);
    return { week: key, start: t, visits: r ? Number(r.visits) : 0, uniques: r ? Number(r.uniques) : 0 };
  });
}

export function monthlySeriesFiltered(db, startMs, endMs, fq) {
  const rows = db
    .prepare(
      `SELECT strftime('%Y-%m', ts / 1000, 'unixepoch') AS mo,
              COUNT(*) AS visits,
              COUNT(DISTINCT guest_key) AS uniques
       FROM events
       WHERE ts >= ? AND ts <= ? AND is_bot = 0 AND ${fq.sql}
       GROUP BY mo ORDER BY mo`,
    )
    .all(startMs, endMs, ...fq.args);
  const sm = new Date(startMs);
  sm.setUTCDate(1);
  sm.setUTCHours(0, 0, 0, 0);
  const months = [];
  for (let t = sm.getTime(); t <= endMs;) {
    months.push(t);
    const d = new Date(t);
    d.setUTCMonth(d.getUTCMonth() + 1, 1);
    d.setUTCHours(0, 0, 0, 0);
    t = d.getTime();
  }
  const byKey = new Map(rows.map((r) => [r.mo, r]));
  return months.map((t) => {
    const key = new Date(t).toISOString().slice(0, 7);
    const r = byKey.get(key);
    return { month: key, start: t, visits: r ? Number(r.visits) : 0, uniques: r ? Number(r.uniques) : 0 };
  });
}

function topQueryFiltered(db, groupCol, labelCol, startMs, endMs, limit, fq) {
  return db
    .prepare(
      `SELECT ${groupCol} AS label, COUNT(*) AS visits,
              COUNT(DISTINCT CASE WHEN is_bot = 0 THEN guest_key END) AS uniques
       FROM events
       WHERE ts >= ? AND ts <= ? AND is_bot = 0 AND ${fq.sql}
       GROUP BY ${groupCol} ORDER BY visits DESC LIMIT ?`,
    )
    .all(startMs, endMs, ...fq.args, limit)
    .map((r) => ({
      [labelCol]: r.label,
      visits: Number(r.visits),
      uniques: Number(r.uniques),
    }));
}

export function topPagesFiltered(db, startMs, endMs, limit, fq) {
  return topQueryFiltered(db, 'path', 'path', startMs, endMs, limit, fq);
}

export function topSourcesFiltered(db, startMs, endMs, limit, fq) {
  return topQueryFiltered(db, `COALESCE(ref_domain, '(direct)')`, 'source', startMs, endMs, limit, fq);
}

export function topDevicesFiltered(db, startMs, endMs, limit, fq) {
  return topQueryFiltered(db, 'device', 'device', startMs, endMs, limit, fq);
}

export function topBrowsersFiltered(db, startMs, endMs, limit, fq) {
  const rows = topQueryFiltered(db, 'browser', 'browser', startMs, endMs, limit, fq);
  return attachBrowserVersions(db, rows, startMs, endMs, fq.sql, fq.args);
}

// See topCountries: unknown/empty country rows are excluded from the
// breakdown so the filtered view never shows a "null" country label.
export function topCountriesFiltered(db, startMs, endMs, limit, fq) {
  return db
    .prepare(
      `SELECT country AS label, COUNT(*) AS visits,
              COUNT(DISTINCT CASE WHEN is_bot = 0 THEN guest_key END) AS uniques
       FROM events
       WHERE ts >= ? AND ts <= ? AND is_bot = 0 AND ${fq.sql}
         AND country IS NOT NULL AND country != ''
       GROUP BY country ORDER BY visits DESC LIMIT ?`,
    )
    .all(startMs, endMs, ...fq.args, limit)
    .map((r) => ({ country: r.label, visits: Number(r.visits), uniques: Number(r.uniques) }));
}

export function topOsesFiltered(db, startMs, endMs, limit, fq) {
  return topQueryFiltered(db, 'os', 'os', startMs, endMs, limit, fq);
}

export function topLanguagesFiltered(db, startMs, endMs, limit, fq) {
  return db
    .prepare(
      `SELECT lang AS label, COUNT(*) AS visits,
              COUNT(DISTINCT CASE WHEN is_bot = 0 THEN guest_key END) AS uniques
       FROM events
       WHERE ts >= ? AND ts <= ? AND is_bot = 0 AND ${fq.sql}
         AND lang IS NOT NULL AND lang != ''
       GROUP BY lang ORDER BY visits DESC LIMIT ?`,
    )
    .all(startMs, endMs, ...fq.args, limit)
    .map((r) => ({ lang: r.label, visits: Number(r.visits), uniques: Number(r.uniques) }));
}

export function topScreensFiltered(db, startMs, endMs, limit, fq) {
  return db
    .prepare(
      `SELECT screen_w || 'x' || screen_h AS label, COUNT(*) AS visits,
              COUNT(DISTINCT CASE WHEN is_bot = 0 THEN guest_key END) AS uniques
       FROM events
       WHERE ts >= ? AND ts <= ? AND is_bot = 0 AND ${fq.sql}
         AND screen_w IS NOT NULL AND screen_h IS NOT NULL
       GROUP BY label ORDER BY visits DESC LIMIT ?`,
    )
    .all(startMs, endMs, ...fq.args, limit)
    .map((r) => ({ screen: r.label, visits: Number(r.visits), uniques: Number(r.uniques) }));
}

// The title column is captured at collect time and carried in raw exports, but
// never aggregated. Surface it as a page-title breakdown so the dashboard
// answers "what content are people actually reading?". Empty titles (payloads
// that omitted title) are excluded, same as the empty-source rows.
export function topTitles(db, startMs, endMs, limit = 10) {
  const w = whereClause(startMs, endMs);
  return db
    .prepare(
      `SELECT title AS label, COUNT(*) AS visits,
              COUNT(DISTINCT CASE WHEN is_bot = 0 THEN guest_key END) AS uniques
       FROM events
       WHERE ${w.sql} AND is_bot = 0 AND title IS NOT NULL AND title != ''
       GROUP BY title ORDER BY visits DESC LIMIT ?`,
    )
    .all(...w.args, limit)
    .map((r) => ({ title: r.label, visits: Number(r.visits), uniques: Number(r.uniques) }));
}

export function topTitlesFiltered(db, startMs, endMs, limit, fq) {
  return db
    .prepare(
      `SELECT title AS label, COUNT(*) AS visits,
              COUNT(DISTINCT CASE WHEN is_bot = 0 THEN guest_key END) AS uniques
       FROM events
       WHERE ts >= ? AND ts <= ? AND is_bot = 0 AND ${fq.sql}
         AND title IS NOT NULL AND title != ''
       GROUP BY title ORDER BY visits DESC LIMIT ?`,
    )
    .all(startMs, endMs, ...fq.args, limit)
    .map((r) => ({ title: r.label, visits: Number(r.visits), uniques: Number(r.uniques) }));
}

// The referrer column holds the full referring URL, while ref_domain reduces
// it to a hostname label for the sources breakdown. Surface the full URL as a
// referring-pages breakdown so the dashboard answers "which specific pages are
// sending traffic?" (e.g. github.com/owner/repo vs news.ycombinator.com/item).
// Empty referrers (direct traffic) are excluded, same as the title/source rows.
export function topReferrers(db, startMs, endMs, limit = 10) {
  const w = whereClause(startMs, endMs);
  return db
    .prepare(
      `SELECT referrer AS label, COUNT(*) AS visits,
              COUNT(DISTINCT CASE WHEN is_bot = 0 THEN guest_key END) AS uniques
       FROM events
       WHERE ${w.sql} AND is_bot = 0 AND referrer IS NOT NULL AND referrer != ''
       GROUP BY referrer ORDER BY visits DESC LIMIT ?`,
    )
    .all(...w.args, limit)
    .map((r) => ({ referrer: r.label, visits: Number(r.visits), uniques: Number(r.uniques) }));
}

export function topReferrersFiltered(db, startMs, endMs, limit, fq) {
  return db
    .prepare(
      `SELECT referrer AS label, COUNT(*) AS visits,
              COUNT(DISTINCT CASE WHEN is_bot = 0 THEN guest_key END) AS uniques
       FROM events
       WHERE ts >= ? AND ts <= ? AND is_bot = 0 AND ${fq.sql}
         AND referrer IS NOT NULL AND referrer != ''
       GROUP BY referrer ORDER BY visits DESC LIMIT ?`,
    )
    .all(startMs, endMs, ...fq.args, limit)
    .map((r) => ({ referrer: r.label, visits: Number(r.visits), uniques: Number(r.uniques) }));
}

// New vs returning visitors. A guest is "returning" (for the queried range)
// when any of their non-bot events predates the range start — i.e. we saw them
// earlier in the global history. This is a pure read over `events`: no visitor
// bookmark is persisted, the 30-minute visit window is irrelevant here, and the
// label is a property of the guest's entire history, not of a single visit.
// The `active` set constrains to guests with activity inside the range so the
// split always sums to the range's unique count.
export function returningStats(db, startMs, endMs) {
  const w = whereClause(startMs, endMs);
  const row = db
    .prepare(
      `WITH guest_first AS (
          SELECT guest_key, MIN(ts) AS first_ts FROM events
          WHERE is_bot = 0 AND guest_key IS NOT NULL
          GROUP BY guest_key
       ),
       active AS (
          SELECT DISTINCT guest_key FROM events
          WHERE ${w.sql} AND is_bot = 0 AND guest_key IS NOT NULL
       )
       SELECT COUNT(*) AS guests,
              SUM(CASE WHEN gf.first_ts < ? THEN 1 ELSE 0 END) AS returning_guests,
              SUM(CASE WHEN gf.first_ts >= ? THEN 1 ELSE 0 END) AS new_guests
       FROM active a JOIN guest_first gf USING (guest_key)`,
    )
    .get(...w.args, startMs, startMs);
  return normalizeReturningStats(row);
}

export function returningStatsFiltered(db, startMs, endMs, fq) {
  const row = db
    .prepare(
      `WITH guest_first AS (
          SELECT guest_key, MIN(ts) AS first_ts FROM events
          WHERE is_bot = 0 AND guest_key IS NOT NULL
          GROUP BY guest_key
       ),
       active AS (
          SELECT DISTINCT guest_key FROM events
          WHERE ts >= ? AND ts <= ? AND is_bot = 0 AND guest_key IS NOT NULL
            AND ${fq.sql}
       )
       SELECT COUNT(*) AS guests,
              SUM(CASE WHEN gf.first_ts < ? THEN 1 ELSE 0 END) AS returning_guests,
              SUM(CASE WHEN gf.first_ts >= ? THEN 1 ELSE 0 END) AS new_guests
       FROM active a JOIN guest_first gf USING (guest_key)`,
    )
    .get(startMs, endMs, ...fq.args, startMs, startMs);
  return normalizeReturningStats(row);
}

function normalizeReturningStats(row) {
  const guests = Number(row?.guests || 0);
  const returning = Number(row?.returning_guests || 0);
  return {
    guests,
    new_guests: Number(row?.new_guests || 0),
    returning_guests: returning,
    returning_pct: guests ? Math.round((returning / guests) * 1000) / 10 : 0,
  };
}

export function entryExitFiltered(db, startMs, endMs, limit, fq) {
  // Semantics: the filters apply to the VISIT, not to the edge row. A visit
  // that touches the filtered page/source/device is included and reports its
  // real first and last pages. So: 1) find the visit_keys that have at least
  // one matching event inside the period, 2) return that visit's first/last.
  const args = [startMs, endMs, ...fq.args];
  const cond = ` AND ${fq.sql}`;
  const scope = `WHERE ts >= ? AND ts <= ? AND is_bot = 0 AND visit_key IS NOT NULL${cond}`;
  const firstLast = (minmax) =>
    db
      .prepare(
        `WITH matching_visits AS (
            SELECT DISTINCT visit_key FROM events ${scope}
         ),
         edge AS (
            SELECT e.visit_key, e.path,
                   ${minmax === 'MIN' ? 'MIN(e.id)' : 'MAX(e.id)'} AS eid
            FROM events e
            JOIN matching_visits m USING (visit_key)
            WHERE e.is_bot = 0 AND e.visit_key IS NOT NULL
              AND e.ts >= ? AND e.ts <= ?
            GROUP BY e.visit_key
         )
         SELECT e.path, COUNT(*) AS visits
         FROM edge JOIN events e ON e.id = eid
         GROUP BY e.path ORDER BY visits DESC LIMIT ?`,
      )
      .all(...args, startMs, endMs, limit)
      .map((r) => ({ path: r.path, visits: Number(r.visits) }));

  return { entries: firstLast('MIN'), exits: firstLast('MAX') };
}

export function toCsv(rows, columns) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = rows.map((r) => columns.map((c) => esc(r[c])).join(','));
  return [columns.join(','), ...body].join('\n') + '\n';
}
