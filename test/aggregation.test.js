// Focused aggregation tests: daily/weekly bucketing correctness on controlled
// timestamps, run against a throwaway SQLite DB (no live HTTP server).
//
// These complement the acceptance suite: because the acceptance server is
// shared across tests and only sees "now"-timestamped events, the weekly
// bucket-fit (Monday-midnight alignment + same-week grouping) could not be
// asserted there.
//
// Note: the modules read `config` at import time, so a different DB path per
// test is passed explicitly (openDb(path), loadOrCreateSecret(dir)).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { tmpdir } from './helpers.js';
import { openDb, weekStart } from '../src/store.js';
import { loadOrCreateSecret } from '../src/privacy.js';
import { insertEvent, normalizeEvent } from '../src/collector.js';
import { weeklySeries, dailySeries } from '../src/analytics.js';

function fresh() {
  const dir = tmpdir();
  const db = openDb(path.join(dir, 'test.sqlite'));
  const secret = loadOrCreateSecret(dir);
  return { db, secret };
}

function post(db, secret, { pathname, ip, ua, ts }) {
  const ev = normalizeEvent({ path: pathname }, { ip, ua }, secret);
  ev.ts = ts;
  ev.visited_at = new Date(ts).toISOString();
  insertEvent(db, ev);
}

test('weekly buckets: same-week events group together, aligned to Monday UTC midnight', () => {
  const { db, secret } = fresh();
  const ua = 'Weekly-UA/1.0';

  // Tuesday 2026-11-10, two different hours of the same day.
  post(db, secret, { pathname: '/a', ip: '10.0.0.1', ua, ts: Date.UTC(2026, 10, 10, 9, 0) });
  post(db, secret, { pathname: '/b', ip: '10.0.0.1', ua, ts: Date.UTC(2026, 10, 10, 17, 0) });
  // Sunday 2026-11-15 23:59 — still the UTC week starting Monday 2026-11-09.
  post(db, secret, { pathname: '/c', ip: '10.0.0.2', ua, ts: Date.UTC(2026, 10, 15, 23, 59) });
  // Tuesday 2026-11-17 — next week (Monday 2026-11-16).
  post(db, secret, { pathname: '/d', ip: '10.0.0.1', ua, ts: Date.UTC(2026, 10, 17, 3, 30) });

  const ws = weeklySeries(db, Date.UTC(2026, 10, 9), Date.UTC(2026, 10, 24));
  const wk1 = ws.find((w) => w.week === '2026-11-09');
  const wk2 = ws.find((w) => w.week === '2026-11-16');
  assert.ok(wk1, 'week of 2026-11-09 present');
  assert.ok(wk2, 'week of 2026-11-16 present');
  assert.equal(wk1.visits, 3, 'three events in the Monday-starting week, regardless of time of day');
  assert.equal(wk2.visits, 1, 'one event in the following week');
  assert.equal(new Date(wk1.start).getUTCHours(), 0, 'week start aligned to UTC midnight');
  assert.equal(new Date(wk1.start).getUTCDay(), 1, 'week start is a Monday');
  assert.equal(new Date(wk2.start).getUTCDay(), 1, 'week 2 start is a Monday');

  db.close();
});

test('daily buckets: per-UTC-day counts and zero-fill', () => {
  const { db, secret } = fresh();
  post(db, secret, { pathname: '/d1', ip: '10.0.1.1', ua: 'D/1.0', ts: Date.UTC(2026, 10, 12, 0, 5) });
  post(db, secret, { pathname: '/d2', ip: '10.0.1.1', ua: 'D/1.0', ts: Date.UTC(2026, 10, 12, 23, 59) });
  post(db, secret, { pathname: '/d3', ip: '10.0.1.2', ua: 'D/1.0', ts: Date.UTC(2026, 10, 14, 10, 0) });

  const series = dailySeries(db, Date.UTC(2026, 10, 12), Date.UTC(2026, 10, 14));
  assert.equal(series.length, 3, 'zero-filled for every day in range');
  assert.deepEqual(
    series.map((d) => [d.date, d.visits]),
    [
      ['2026-11-12', 2],
      ['2026-11-13', 0],
      ['2026-11-14', 1],
    ],
    'per-day counts are correct across UTC boundaries',
  );
  db.close();
});

test('weekStart truncates to Monday UTC midnight', () => {
  const t = Date.UTC(2026, 10, 15, 12, 30, 45); // Sunday midday
  const ws = weekStart(t).getTime();
  assert.equal(new Date(ws).toISOString(), '2026-11-09T00:00:00.000Z');
});
