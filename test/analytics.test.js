// analytics.js read-path contracts: the dashboard's series, top lists,
// realtime, visitor stats and CSV serializer. The series reads over the
// aggregate caches were already pinned by aggregation/monthly; here the raw
// `events`-backed surface is exercised directly — every top-* breakdown (label
// keys, '(direct)' / screen-size labels, NULL/'' exclusion guards, dominant
// browser-version attachment, LIMIT), the filtered variants that fall back to
// raw-event scans, the zero-filled hourly/daily/weekly/monthly axes, realtime
// window clamping, visit bounce/duration math, new-vs-returning split, and the
// CSV escaping rules. Bots are excluded from every read path and that shows up
// in the numbers, not just in the WHERE clauses. The empty-range fallbacks are
// pinned too: no events (or only bots) in range yields an empty browser
// breakdown and a zeroed new/returning split rather than a fabricated value.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/store.js';
import { loadOrCreateSecret } from '../src/privacy.js';
import { insertEvent, normalizeEvent } from '../src/collector.js';
import { config } from '../src/config.js';
import {
  dayKeysBetween,
  dailySeriesFiltered,
  weeklySeriesFiltered,
  monthlySeriesFiltered,
  topPages,
  topSources,
  topDevices,
  topDevicesFiltered,
  topModels,
  topModelsFiltered,
  topBrowsers,
  topBrowsersFiltered,
  topCountries,
  topCountriesFiltered,
  topOses,
  topOsesFiltered,
  topLanguages,
  topLanguagesFiltered,
  topScreens,
  topScreensFiltered,
  topTitles,
  topTitlesFiltered,
  topReferrers,
  topReferrersFiltered,
  topPagesFiltered,
  topSourcesFiltered,
  hourlySeries,
  hourlySeriesFiltered,
  realtime,
  totals,
  totalsFiltered,
  visitStats,
  visitStatsFiltered,
  returningStats,
  returningStatsFiltered,
  toCsv,
} from '../src/analytics.js';

// 2026-11-10 09:00 UTC is a Tuesday.
const T = Date.UTC(2026, 10, 10, 9, 0);
const MIN = 60_000;
const HOUR = 3600_000;
const SPAN = HOUR;

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-an-'));
  const db = openDb(path.join(dir, 'test.sqlite'));
  const secret = loadOrCreateSecret(dir);
  const stmt = db.prepare(
    `INSERT INTO events
      (ts, visited_at, guest_key, ip, ua, path, referrer, ref_domain,
       title, screen_w, screen_h, lang, country, browser, browser_version,
       device, device_model, os, is_bot, visit_key, entry_path, exit_path)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  // Direct row insert for full column control (browser/device/os/labels are
  // UA-derived at collect time, so bypassing normalizeEvent lets each test fix
  // the breakdown dimensions exactly).
  const insert = (row) => {
    const vk = row.visit_key === undefined ? row.ts : row.visit_key;
    stmt.run(
      row.ts, new Date(row.ts).toISOString(), row.guest_key, null, row.ua ?? 'Raw/1.0',
      row.path ?? '/', row.referrer ?? null, row.ref_domain ?? null,
      row.title ?? null, row.screen_w ?? null, row.screen_h ?? null,
      row.lang ?? null, row.country ?? null, row.browser ?? 'Raw',
      row.browser_version ?? null, row.device ?? 'desktop', row.device_model ?? null,
      row.os ?? null, row.is_bot ?? 0, vk,
      row.entry_path ?? row.path ?? '/', row.exit_path ?? row.path ?? '/',
    );
  };
  // insertEvent path: keeps the realtime/series caches in sync with the raw
  // rows (the caches only ever see non-bot events).
  const post = (pathname, meta = {}) => {
    const ev = normalizeEvent({ path: pathname }, { ua: 'Test/1.0', ...meta }, secret);
    ev.visited_at = new Date(ev.ts).toISOString();
    insertEvent(db, ev);
  };
  return { db, secret, insert, post };
}

test('dayKeysBetween walks UTC calendar days, inclusive of the end day', () => {
  assert.deepEqual(
    dayKeysBetween(Date.UTC(2026, 10, 10, 23, 59), Date.UTC(2026, 10, 12, 0, 30)),
    ['2026-11-10', '2026-11-11', '2026-11-12'],
  );
  assert.deepEqual(dayKeysBetween(T, T), ['2026-11-10'], 'a single-day range is one key');
  assert.deepEqual(
    dayKeysBetween(Date.UTC(2026, 11, 31), Date.UTC(2027, 0, 2)),
    ['2026-12-31', '2027-01-01', '2027-01-02'],
    'calendar spans roll years cleanly',
  );
});

test('top lists: label keys, Number types, LIMIT, and bots excluded', () => {
  const { db, insert } = fresh();
  const g = {
    ts: T, path: '/a', ref_domain: 'google.com', device: 'mobile', browser: 'Chrome',
    os: 'iOS', lang: 'en', country: 'us',
  };
  insert({ ...g, guest_key: 'g1' });
  insert({ ...g, guest_key: 'g1', ts: T + MIN });
  insert({ ...g, guest_key: 'g2', ts: T + 2 * MIN, path: '/b', ref_domain: null, device: 'desktop', os: 'Windows', lang: 'zh-CN', country: 'cn' });
  insert({ ...g, guest_key: 'g3', ts: T + 3 * MIN, path: '/nope', is_bot: 1 });

  const pages = topPages(db, T, T + SPAN);
  assert.deepEqual(pages, [
    { path: '/a', visits: 2, uniques: 1 },
    { path: '/b', visits: 1, uniques: 1 },
  ], 'most-visited first, bot path never listed');
  assert.equal(pages.every((p) => typeof p.visits === 'number'), true);

  assert.deepEqual(topPages(db, T, T + SPAN, 1), [{ path: '/a', visits: 2, uniques: 1 }], 'LIMIT binds');
  assert.deepEqual(topDevices(db, T, T + SPAN), [
    { device: 'mobile', visits: 2, uniques: 1 },
    { device: 'desktop', visits: 1, uniques: 1 },
  ]);
  assert.deepEqual(topOses(db, T, T + SPAN), [
    { os: 'iOS', visits: 2, uniques: 1 },
    { os: 'Windows', visits: 1, uniques: 1 },
  ]);
});

test('topSources surfaces (direct) for referrer-less traffic', () => {
  const { db, insert } = fresh();
  insert({ guest_key: 'g1', ts: T, path: '/a', ref_domain: 'google.com' });
  insert({ guest_key: 'g1', ts: T + MIN, path: '/a', ref_domain: 'google.com' });
  insert({ guest_key: 'g2', ts: T + 2 * MIN, path: '/b', ref_domain: null });
  const sources = topSources(db, T, T + SPAN);
  assert.deepEqual(sources, [
    { source: 'google.com', visits: 2, uniques: 1 },
    { source: '(direct)', visits: 1, uniques: 1 },
  ]);
  assert.deepEqual(topSources(db, T, T + SPAN, 1), [{ source: 'google.com', visits: 2, uniques: 1 }]);
});

test('top lists with empty-string/null guards: models, countries, languages, titles, referrers', () => {
  const { db, insert } = fresh();
  const row = { guest_key: 'g1', ts: T, path: '/a', ref_domain: 'g.com', referrer: 'https://g.com/x', title: 'Real', lang: 'en', country: 'us', device_model: 'iPhone' };
  insert(row);
  insert({ ...row, guest_key: 'g1', ts: T + MIN });
  // A full void row: every label-bearing column empty -> excluded from all these breakdowns.
  insert({ ...row, guest_key: 'g2', ts: T + 2 * MIN, ref_domain: null, referrer: null, title: null, lang: null, country: null, device_model: null });

  assert.deepEqual(topModels(db, T, T + SPAN), [{ model: 'iPhone', visits: 2, uniques: 1 }]);
  assert.deepEqual(topCountries(db, T, T + SPAN), [{ country: 'us', visits: 2, uniques: 1 }]);
  assert.deepEqual(topLanguages(db, T, T + SPAN), [{ lang: 'en', visits: 2, uniques: 1 }]);
  assert.deepEqual(topTitles(db, T, T + SPAN), [{ title: 'Real', visits: 2, uniques: 1 }]);
  assert.deepEqual(topReferrers(db, T, T + SPAN), [{ referrer: 'https://g.com/x', visits: 2, uniques: 1 }]);
});

test('topScreens concatenates WxH and skips rows missing either dimension', () => {
  const { db, insert } = fresh();
  insert({ guest_key: 'g1', ts: T, path: '/a', screen_w: 390, screen_h: 844 });
  insert({ guest_key: 'g1', ts: T + MIN, path: '/a', screen_w: 390, screen_h: 844 });
  insert({ guest_key: 'g2', ts: T + 2 * MIN, path: '/b', screen_w: 1920, screen_h: 1080 });
  insert({ guest_key: 'g3', ts: T + 3 * MIN, path: '/none', screen_w: null, screen_h: null });
  assert.deepEqual(topScreens(db, T, T + SPAN), [
    { screen: '390x844', visits: 2, uniques: 1 },
    { screen: '1920x1080', visits: 1, uniques: 1 },
  ]);
});

test('topBrowsers attaches the dominant version, lexicographic tie-break, null when absent', () => {
  const { db, insert } = fresh();
  // Chrome 120 appears twice, Chrome 121 once -> dominant 120.
  insert({ guest_key: 'g1', ts: T, browser: 'Chrome', browser_version: '120' });
  insert({ guest_key: 'g1', ts: T + MIN, browser: 'Chrome', browser_version: '120' });
  insert({ guest_key: 'g2', ts: T + 2 * MIN, browser: 'Chrome', browser_version: '121' });
  // Safari 16 and 15 tie at one visit each -> lexicographically smaller wins.
  insert({ guest_key: 'g3', ts: T, browser: 'Safari', browser_version: '16' });
  insert({ guest_key: 'g3', ts: T + MIN, browser: 'Safari', browser_version: '15' });
  // Edge rows carry no version -> null, not a fabricated value.
  insert({ guest_key: 'g4', ts: T, browser: 'Edge', browser_version: null });

  const browsers = topBrowsers(db, T, T + 10 * MIN);
  const byName = Object.fromEntries(browsers.map((b) => [b.browser, b]));
  assert.equal(byName.Chrome.version, '120', 'most frequent version wins');
  assert.equal(byName.Safari.version, '15', 'equal counts break lexicographically');
  assert.equal(byName.Edge.version, null, 'no stored version means no attached version');
  assert.equal(byName.Safari.visits, 2);
});

test('topBrowsers returns empty on an empty range, and only-bot ranges feed nothing', () => {
  // attachBrowserVersions (analytics.js:160) early-returns the empty row set
  // before even opening its version query: a range with no events — or with
  // only bot rows, which topQuery always filters out — must yield [] (the
  // dashboard renders "no data", version attachment never runs).
  const { db, insert } = fresh();
  assert.deepEqual(topBrowsers(db, T, T + SPAN), [], 'no events in range: empty breakdown');
  assert.deepEqual(topBrowsers(db, T - 24 * HOUR, T - 1, 10), [], 'a range before any rows');
  insert({ guest_key: 'g1', ts: T, path: '/bot', is_bot: 1, browser: 'Googlebot' });
  assert.deepEqual(topBrowsers(db, T, T + SPAN), [], 'bot-only range feeds nothing to the version attach');

  // The filtered variant shares the same early return: a filter matching no
  // non-bot events produces [], not a placeholder row.
  assert.deepEqual(
    topBrowsersFiltered(db, T, T + SPAN, 10, { sql: 'path = ?', args: ['/missing'] }),
    [],
  );
  db.close();
});

test('filtered top lists honor the page filter', () => {
  const { db, insert } = fresh();
  insert({ guest_key: 'g1', ts: T, path: '/paid', ref_domain: null });
  insert({ guest_key: 'g1', ts: T + MIN, path: '/paid', ref_domain: null });
  insert({ guest_key: 'g2', ts: T + 2 * MIN, path: '/free', ref_domain: 'bing.com' });
  const fq = { sql: 'path = ?', args: ['/paid'] };

  assert.deepEqual(topPagesFiltered(db, T, T + SPAN, 10, fq), [
    { path: '/paid', visits: 2, uniques: 1 },
  ]);
  assert.deepEqual(topSourcesFiltered(db, T, T + SPAN, 10, fq), [
    { source: '(direct)', visits: 2, uniques: 1 },
  ]);
  assert.deepEqual(topPagesFiltered(db, T, T + SPAN, 1, fq), [
    { path: '/paid', visits: 2, uniques: 1 },
  ], 'filtered variant still binds LIMIT');
});

test('filtered label breakdowns narrow by filter and keep the NULL/empty guards and bot exclusion', () => {
  // One guest hits the filter's page twice (window of exactly one brand-new
  // visitor), one hits a different page (out of filter), one page is under the
  // filter but carries a void row for every guardable label column, and one bot
  // hits the filtered page. Contract split along the real schema lines:
  //   - model/country/lang/screen/title/referrer carry IS NOT NULL && != ''
  //     guards (their columns are optional at collect time), so the void row
  //     is dropped from those breakdowns;
  //   - device/os are UA-derived and always present at collect time, so the
  //     filtered variants group them without a guard — every in-filter row
  //     shows up, void dimensions included.
  // Every read path excludes bots, and the g3 /free row stays out of all of
  // them via the filter itself.
  const { db, insert } = fresh();
  const fq = { sql: 'path = ?', args: ['/paid'] };
  const row = {
    guest_key: 'g1', ts: T, path: '/paid', device: 'mobile', device_model: 'iPhone',
    country: 'us', os: 'iOS', lang: 'en', screen_w: 390, screen_h: 844,
    title: 'Real', referrer: 'https://g.com/x',
  };
  insert(row);
  insert({ ...row, guest_key: 'g1', ts: T + MIN });
  // Hits the filter's page, but every guardable label column is void; device
  // and os are still set (UA-derived columns carry no guard).
  insert({ ...row, guest_key: 'g2', ts: T + 2 * MIN, device: 'desktop', os: 'Android', device_model: null, country: null, lang: null, screen_w: null, screen_h: null, title: null, referrer: null });
  // Outside the filter.
  insert({ ...row, guest_key: 'g3', ts: T + 3 * MIN, path: '/free' });
  // Bot on the filter's page -> invisible to every read path.
  insert({ ...row, guest_key: 'g4', ts: T + 4 * MIN, is_bot: 1 });

  // The guardable columns: the void row is dropped, leaving only g1's label.
  assert.deepEqual(topModelsFiltered(db, T, T + SPAN, 10, fq), [{ model: 'iPhone', visits: 2, uniques: 1 }]);
  assert.deepEqual(topCountriesFiltered(db, T, T + SPAN, 10, fq), [{ country: 'us', visits: 2, uniques: 1 }]);
  assert.deepEqual(topLanguagesFiltered(db, T, T + SPAN, 10, fq), [{ lang: 'en', visits: 2, uniques: 1 }]);
  assert.deepEqual(topScreensFiltered(db, T, T + SPAN, 10, fq), [{ screen: '390x844', visits: 2, uniques: 1 }]);
  assert.deepEqual(topTitlesFiltered(db, T, T + SPAN, 10, fq), [{ title: 'Real', visits: 2, uniques: 1 }]);
  assert.deepEqual(topReferrersFiltered(db, T, T + SPAN, 10, fq), [{ referrer: 'https://g.com/x', visits: 2, uniques: 1 }]);
  // device/os group without a guard: the void row's values survive the filter.
  assert.deepEqual(topDevicesFiltered(db, T, T + SPAN, 10, fq), [
    { device: 'mobile', visits: 2, uniques: 1 },
    { device: 'desktop', visits: 1, uniques: 1 },
  ]);
  assert.deepEqual(topOsesFiltered(db, T, T + SPAN, 10, fq), [
    { os: 'iOS', visits: 2, uniques: 1 },
    { os: 'Android', visits: 1, uniques: 1 },
  ]);

  // LIMIT binds on the label-bearing branch, not just the delegation.
  assert.deepEqual(topModelsFiltered(db, T, T + SPAN, 1, fq), [{ model: 'iPhone', visits: 2, uniques: 1 }]);
  db.close();
});

test('hourlySeriesFiltered zero-fills 24 hours and honors the filter and bot exclusion', () => {
  const { db, insert } = fresh();
  const fq = { sql: 'path = ?', args: ['/only'] };

  insert({ guest_key: 'g1', ts: T, path: '/only' });                 // 09:00 UTC, in filter
  insert({ guest_key: 'g1', ts: T + MIN, path: '/only' });           // 09:00 UTC, same guest
  insert({ guest_key: 'g2', ts: T + 2 * HOUR, path: '/only' });      // 11:00 UTC, in filter
  insert({ guest_key: 'g3', ts: T + HOUR, path: '/other' });         // 10:00 UTC, out of filter
  insert({ guest_key: 'g4', ts: T + 3 * HOUR, path: '/only', is_bot: 1 }); // bot on the filtered page

  const series = hourlySeriesFiltered(db, T, T + 4 * HOUR, fq);
  assert.equal(series.length, 24);
  assert.deepEqual(series.map((s) => s.hour), Array.from({ length: 24 }, (_, h) => h));
  assert.deepEqual(
    series.filter((s) => s.visits > 0).map((s) => s),
    [
      { hour: 9, visits: 2, uniques: 1 },
      { hour: 11, visits: 1, uniques: 1 },
    ],
    'filtered-out and bot traffic never materialize, same zero-fill contract as hourlySeries',
  );
  db.close();
});

test('hourlySeries zero-fills all 24 UTC hours', () => {
  const { db, post } = fresh();
  post('/m', { ts: T, ip: '10.0.0.1' });                        // 09:00 UTC
  post('/n', { ts: T + MIN, ip: '10.0.0.1' });                  // still 09:00
  post('/o', { ts: T + 2 * HOUR, ip: '10.0.0.2' });             // 11:00 UTC
  post('/b', { ts: T + HOUR, ip: '10.0.0.3', ua: 'Mozilla/5.0 (compatible; Googlebot/2.1)' });

  const series = hourlySeries(db, T, T + 3 * HOUR);
  assert.equal(series.length, 24);
  assert.deepEqual(series.map((s) => s.hour), Array.from({ length: 24 }, (_, h) => h));
  assert.deepEqual(
    series.filter((s) => s.visits > 0).map((s) => s),
    [
      { hour: 9, visits: 2, uniques: 1 },
      { hour: 11, visits: 1, uniques: 1 },
    ],
    'bot hour never materializes',
  );
  assert.equal(series.reduce((a, s) => a + s.visits, 0), 3);
});

test('realtime returns in-window minute buckets and clamps the window at both ends', () => {
  const { db, post } = fresh();
  const now = T + 5 * MIN;
  post('/r1', { ts: T + 3 * MIN, ip: '10.0.0.1' });
  post('/r2', { ts: T + 4 * MIN + 30_000, ip: '10.0.0.1' });  // same guest: continues the visit
  post('/r3', { ts: T + 4 * MIN + 40_000, ip: '10.0.0.2' });  // new guest: starts a visit
  post('/old', { ts: T - 30 * MIN, ip: '10.0.0.3' });   // before window start
  post('/fut', { ts: T + 10 * MIN, ip: '10.0.0.4' });   // after `now` — must not inflate
  post('/bot', { ts: T + 4 * MIN + 10_000, ip: '10.0.0.5', ua: 'Googlebot/2.1' });

  const rt = realtime(db, now);
  assert.deepEqual(rt, {
    buckets: [
      { ts: T + 3 * MIN, visits: 1, uniques: 1 },
      // uniques count visit STARTS per minute bucket: g1's continuation into
      // the 4th minute adds a visit but no new unique (collector write-through).
      { ts: T + 4 * MIN, visits: 2, uniques: 1 },
    ],
    current: { visits: 2, uniques: 1 },
  }, 'out-of-window and bot traffic are invisible');
});

test('realtime on an empty DB returns the zeroed empty form', () => {
  const { db } = fresh();
  assert.deepEqual(realtime(db, T + MIN), { buckets: [], current: { visits: 0, uniques: 0 } });
});

test('realtime read cost does not grow with the archive age of agg_daily_realtime', () => {
  // Real-time polls filter on bucket1m ALONE, but the agg table's only index
  // is the PK (day, bucket1m) — bucket1m is not a leftmost column there. With
  // retention off (the default) the table grows ~1440 rows/active-day forever,
  // so without a bucket1m index every dashboard poll full-scans years of
  // minute buckets. Pin the fix: seed a multi-year history and require the
  // query (a) to still return exactly the in-window buckets and (b) to run
  // via an index seek, not a SCAN — plus a generous absolute budget so a
  // planner regression (SCAN + temp b-tree over ~1.1M rows) cannot hide in an
  // otherwise-correct result.
  const { db, post } = fresh();
  const DAY = 86_400_000;
  const now = T + 5 * MIN;
  const years = 3;
  const rowsPerDay = 8 * 60; // 8 active hours/day
  const base = now - years * 365 * DAY;

  // Backfill the archive directly (bypass write-through) exactly as a long-
  // lived deployment accumulates it: one row per active epoch-minute.
  const upsert = db.prepare(
    `INSERT INTO agg_daily_realtime(day, bucket1m, visits, uniques)
     VALUES (?, ?, 1, 1)
     ON CONFLICT(day, bucket1m) DO UPDATE SET visits = visits + 1`,
  );
  db.exec('BEGIN');
  for (let d = 0; d < years * 365; d++) {
    const dayStart = base + d * DAY;
    const day = new Date(dayStart).toISOString().slice(0, 10);
    for (let m = 0; m < rowsPerDay; m++) upsert.run(day, dayStart + m * MIN);
  }
  db.exec('COMMIT');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM agg_daily_realtime').get().n,
    years * 365 * rowsPerDay,
    'archive seeded',
  );

  // In-window traffic (T+3m and T+4m, same spread as the window-clamp test).
  post('/r1', { ts: T + 3 * MIN, ip: '10.0.0.1' });
  post('/r2', { ts: T + 4 * MIN + 30_000, ip: '10.0.0.2' });

  const t0 = performance.now();
  const rt = realtime(db, now);
  const elapsed = performance.now() - t0;

  assert.deepEqual(
    rt,
    {
      buckets: [
        { ts: T + 3 * MIN, visits: 1, uniques: 1 },
        { ts: T + 4 * MIN, visits: 1, uniques: 1 },
      ],
      current: { visits: 1, uniques: 1 },
    },
    'multi-year archive does not change the in-window result',
  );

  const plan = db
    .prepare(
      `EXPLAIN QUERY PLAN
       SELECT bucket1m, SUM(visits) AS visits, SUM(uniques) AS uniques
       FROM agg_daily_realtime WHERE bucket1m >= ? AND bucket1m <= ?
       GROUP BY bucket1m ORDER BY bucket1m`,
    )
    .all(now - config.realtimeWindowMs, now);
  const detail = plan.map((r) => r.detail).join(' | ');
  assert.match(detail, /USING INDEX idx_agg_realtime_bucket/, `realtime must seek the bucket index, got: ${detail}`);
  assert.ok(
    elapsed < 50,
    `realtime over a ${(years * 365 * rowsPerDay).toLocaleString()}-row archive should be an index seek (<50ms), took ${elapsed.toFixed(1)}ms`,
  );
});

test('totals counts a range inclusive of end and never counts bots', () => {
  const { db, insert } = fresh();
  insert({ guest_key: 'g1', ts: T, path: '/a' });
  insert({ guest_key: 'g1', ts: T + MIN, path: '/b' });
  insert({ guest_key: 'g2', ts: T + 2 * MIN, path: '/end' }); // exactly at endMs
  insert({ guest_key: 'g3', ts: T + 2 * MIN, path: '/bot', is_bot: 1 });

  assert.deepEqual(totals(db, T, T + 2 * MIN), { visits: 3, uniques: 2 });
  assert.deepEqual(totalsFiltered(db, T, T + 2 * MIN, { sql: 'path = ?', args: ['/a'] }), { visits: 1, uniques: 1 });
});

test('visitStats splits sessions by visit_key and computes bounce rate and duration', () => {
  const { db, post } = fresh();
  post('/v/1', { ts: T, ip: '10.0.0.1' });
  post('/v/2', { ts: T + MIN, ip: '10.0.0.1' });   // same visit: 2 pages
  post('/v/3', { ts: T + 2 * MIN, ip: '10.0.0.2' }); // single-page visit: bounce
  post('/v/4', { ts: T + 3 * MIN, ip: '10.0.0.3', ua: 'Googlebot/2.1' });

  assert.deepEqual(visitStats(db, T, T + 3 * MIN), {
    sessions: 2,
    bounces: 1,
    bounce_rate: 50,
    avg_duration_ms: 30_000,
  });

  // Filtering narrows per-event: the surviving visit looks single-page.
  assert.deepEqual(visitStatsFiltered(db, T, T + 3 * MIN, { sql: 'path = ?', args: ['/v/2'] }), {
    sessions: 1,
    bounces: 1,
    bounce_rate: 100,
    avg_duration_ms: 0,
  });

  const { db: empty } = fresh();
  assert.deepEqual(visitStats(empty, T, T + SPAN), { sessions: 0, bounces: 0, bounce_rate: 0, avg_duration_ms: 0 });
});

test('returningStats splits active guests by global first presence before the range', () => {
  const { db, insert } = fresh();
  insert({ guest_key: 'gA', ts: T - 24 * HOUR, path: '/pre' });
  insert({ guest_key: 'gA', ts: T, path: '/ret' });
  insert({ guest_key: 'gB', ts: T, path: '/new' });
  insert({ guest_key: 'gC', ts: T, path: '/bot', is_bot: 1 });

  assert.deepEqual(returningStats(db, T, T + SPAN), {
    guests: 2,
    new_guests: 1,
    returning_guests: 1,
    returning_pct: 50,
  });

  assert.deepEqual(returningStatsFiltered(db, T, T + SPAN, { sql: 'path = ?', args: ['/ret'] }), {
    guests: 1,
    new_guests: 0,
    returning_guests: 1,
    returning_pct: 100,
  });
});

test('returningStats zeroes the split when no guests are active in range', () => {
  // normalizeReturningStats (analytics.js:727) guards the percentage with a
  // falsy-guests branch: a range with no active non-bot guests must yield a
  // zeroed split (returning_pct 0), not a fabricated division. The `active`
  // CTE does the constraining — history before the range or bot rows doesn't
  // materialize a guest.
  const { db, insert } = fresh();
  const zero = { guests: 0, new_guests: 0, returning_guests: 0, returning_pct: 0 };

  assert.deepEqual(returningStats(db, T, T + SPAN), zero, 'no events in range: zeroed split');

  insert({ guest_key: 'gOld', ts: T - 24 * HOUR, path: '/pre' });
  assert.deepEqual(returningStats(db, T, T + SPAN), zero, 'out-of-range history is not an active guest');

  insert({ guest_key: 'gBot', ts: T, path: '/bot', is_bot: 1 });
  assert.deepEqual(returningStats(db, T, T + SPAN), zero, 'bot-only range: zeroed split');

  assert.deepEqual(
    returningStatsFiltered(db, T, T + SPAN, { sql: 'path = ?', args: ['/missing'] }),
    zero,
    'a filter matching nothing yields the same zeroed split',
  );
  db.close();
});

test('returningStats read cost is bounded by the queried window, not all-time history', () => {
  // The guest_first CTE must scope to the window's active guests instead of
  // scanning the whole events table: pre-fix every /api/overview (and summary
  // export) grouped the ENTIRE history by guest (EXPLAIN: `MATERIALIZE
  // guest_first` → `SCAN events USING INDEX idx_events_guest`), so read cost
  // grew linearly with the archive while the queried window stayed fixed —
  // measured 273ms at 1M history rows vs ~20ms for a 10k-row DB (13.9x for
  // history the query never even surfaces). Post-fix the CTE is confined via
  // `guest_key IN (SELECT guest_key FROM active)`, giving a per-active-guest
  // equality lookup (`SEARCH ... idx_events_guest (guest_key=?)`) that is
  // O(window), not O(history). This test seeds a large all-time archive of
  // guests that never appear in the window and asserts the split still comes
  // back in window-bound time — on the reference machine pre-fix was ~220ms
  // here (over the 100ms bound), post-fix is ~2ms.
  const { db, insert } = fresh();
  const stmt = db.prepare(
    `INSERT INTO events
      (ts, visited_at, guest_key, ua, path, referrer, ref_domain,
       title, screen_w, screen_h, lang, country, browser, browser_version,
       device, device_model, os, is_bot, visit_key, entry_path, exit_path)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const base = T - 730 * 24 * HOUR;
  db.exec('BEGIN');
  for (let n = 0; n < 800_000; n++) {
    const ts = base + (n % (720 * 24 * HOUR)); // spread over ~2 years, all OUTSIDE the window
    const gk = `hist-${n % 200_000}`;
    stmt.run(ts, new Date(ts).toISOString(), gk, 'Raw/1.0', '/hist',
      null, null, null, 1920, 1080, null, null, 'Raw', null, 'desktop', null, null,
      0, ts, '/hist', '/hist');
  }
  const inWin = T - 24 * HOUR - 1; // ensure the archive stops before the window
  stmt.run(inWin, new Date(inWin).toISOString(), 'hist-last', 'Raw/1.0', '/hist',
    null, null, null, 1920, 1080, null, null, 'Raw', null, 'desktop', null, null,
    0, inWin, '/hist', '/hist');
  db.exec('COMMIT');

  insert({ guest_key: 'gA', ts: T - 24 * HOUR, path: '/pre' }); // returning: first seen before the window
  insert({ guest_key: 'gA', ts: T, path: '/ret' });
  insert({ guest_key: 'gB', ts: T, path: '/new' });

  const expected = { guests: 2, new_guests: 1, returning_guests: 1, returning_pct: 50 };
  const t0 = performance.now();
  assert.deepEqual(returningStats(db, T, T + SPAN), expected);
  const elapsed = performance.now() - t0;
  assert.ok(
    elapsed < 100,
    `returningStats must stay window-bounded: took ${elapsed.toFixed(1)}ms with 800k out-of-window history rows (pre-fix ~220ms)`,
  );

  const tf = performance.now();
  assert.deepEqual(returningStatsFiltered(db, T, T + SPAN, { sql: 'path = ?', args: ['/ret'] }), {
    guests: 1,
    new_guests: 0,
    returning_guests: 1,
    returning_pct: 100,
  });
  const elapsedF = performance.now() - tf;
  assert.ok(
    elapsedF < 100,
    `returningStatsFiltered must stay window-bounded: took ${elapsedF.toFixed(1)}ms with 800k out-of-window history rows`,
  );
  db.close();
});

test('filtered daily/weekly/monthly series zero-fill their axes and honor the filter', () => {
  const { db, insert } = fresh();
  const fq = { sql: 'path = ?', args: ['/only'] };

  insert({ guest_key: 'g1', ts: T, path: '/only' });
  insert({ guest_key: 'g1', ts: T + MIN, path: '/skip' });
  insert({ guest_key: 'g2', ts: T + 47 * HOUR, path: '/only' }); // 2026-11-12 08:00 UTC, still in the 48h range
  insert({ guest_key: 'g3', ts: T + 26 * HOUR, path: '/bot', is_bot: 1 });

  const daily = dailySeriesFiltered(db, T, T + 2 * 24 * HOUR, fq);
  assert.deepEqual(daily.map((d) => [d.date, d.visits]), [
    ['2026-11-10', 1],
    ['2026-11-11', 0],
    ['2026-11-12', 1],
  ]);

  insert({ guest_key: 'g1', ts: Date.UTC(2026, 10, 16, 10, 0), path: '/skip' }); // next week
  const weekly = weeklySeriesFiltered(db, Date.UTC(2026, 10, 9), Date.UTC(2026, 10, 16, 23, 59), fq);
  assert.deepEqual(weekly.map((w) => [w.week, w.visits]), [
    ['2026-11-09', 2],
    ['2026-11-16', 0],
  ]);

  insert({ guest_key: 'g1', ts: Date.UTC(2026, 11, 5, 10, 0), path: '/skip' }); // December
  const monthly = monthlySeriesFiltered(db, Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 31, 23, 59), fq);
  assert.deepEqual(monthly.map((m) => [m.month, m.visits]), [
    ['2026-11', 2],
    ['2026-12', 0],
  ]);
});

test('toCsv quotes commas, quotes, newlines, and renders null as empty', () => {
  const rows = [
    { a: 'plain', b: 'x' },
    { a: 'has,comma', b: 'has"quote' },
    { a: 'line\nbreak', b: null },
  ];
  assert.equal(
    toCsv(rows, ['a', 'b']),
    'a,b\nplain,x\n"has,comma","has""quote"\n"line\nbreak",\n',
  );
  assert.equal(toCsv([], ['a']), 'a\n', 'headers alone for an empty row set');
});

test('toCsv neutralizes spreadsheet formula injection (CWE-1236)', () => {
  const rows = [
    { a: '=SUM(1,1)', b: '+cmd' },
    { a: '-CMD', b: '@import' },
    { a: '\ttab', b: '\rCR' },
    { a: '=has"inner"quote', b: null },
    { a: '/about', b: '9-5' },
    { a: '', b: '=only-empty-quoted' },
  ];
  const out = toCsv(rows, ['a', 'b']);
  // Formula metacharacters get a leading single-quote neutralizer (then
  // normal CSV quoting applies when the cell also contains structure chars).
  assert.equal(out.includes("'=SUM(1,1)"), true, 'leading = is neutralized');
  assert.equal(out.includes("'+cmd"), true, 'leading + is neutralized');
  assert.equal(out.includes("'-CMD"), true, 'leading - is neutralized');
  assert.equal(out.includes("'@import"), true, 'leading @ is neutralized');
  assert.equal(out.includes("'\ttab"), true, 'leading tab is neutralized');
  assert.equal(out.includes("'\rCR"), true, 'leading CR is neutralized');
  assert.equal(
    out.includes('"\'=has""inner""quote"'),
    true,
    'neutralization composes with existing quoting rules',
  );
  // Plain values that merely *contain* or *end in* metacharacters are untouched.
  assert.equal(out.includes('/about'), true);
  assert.equal(out.includes('9-5'), true);
  // Empty cells stay empty even though the header/neighbor may be malicious.
  assert.equal(out.includes(',\n'), true);
  assert.equal(
    toCsv([{ a: '=1+1' }], ['a']),
    'a\n\'=1+1\n',
    'exact cell shape stays deterministic',
  );
});
