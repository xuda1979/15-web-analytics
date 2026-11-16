// Monthly aggregation tests: month-aligned buckets on controlled timestamps,
// run against a throwaway SQLite DB (no live HTTP server).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, monthStart } from '../src/store.js';
import { loadOrCreateSecret } from '../src/privacy.js';
import { insertEvent, normalizeEvent } from '../src/collector.js';
import { monthlySeries, monthlySeriesFiltered } from '../src/analytics.js';

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-mon-'));
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

test('monthly buckets align to UTC month start and group by month', () => {
  const { db, secret } = fresh();
  const ua = 'Monthly-UA/1.0';

  // Three events in November 2026 (different days / hours).
  post(db, secret, { pathname: '/a', ip: '10.0.0.1', ua, ts: Date.UTC(2026, 10, 2, 8) });
  post(db, secret, { pathname: '/b', ip: '10.0.0.1', ua, ts: Date.UTC(2026, 10, 15, 23, 59) });
  // Same visitor, same month different day — unique still counts.
  post(db, secret, { pathname: '/c', ip: '10.0.0.1', ua, ts: Date.UTC(2026, 10, 25, 12) });
  // December.
  post(db, secret, { pathname: '/d', ip: '10.0.0.2', ua, ts: Date.UTC(2026, 11, 3, 1) });

  const ms = monthlySeries(db, Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 31));
  const nov = ms.find((m) => m.month === '2026-11');
  const dec = ms.find((m) => m.month === '2026-12');
  assert.ok(nov, 'November present');
  assert.ok(dec, 'December present');
  assert.equal(nov.visits, 3, 'three events in November, any time of day');
  assert.equal(dec.visits, 1, 'one event in December');
  assert.equal(nov.start, Date.UTC(2026, 10, 1), 'month start aligned to UTC midnight of the 1st');
  assert.equal(dec.month, '2026-12', 'month label is YYYY-MM');

  db.close();
});

test('monthlySeries zero-fills empty months in the range', () => {
  const { db, secret } = fresh();
  post(db, secret, { pathname: '/x', ip: '10.0.2.1', ua: 'M/1.0', ts: Date.UTC(2026, 10, 10) });

  const ms = monthlySeries(db, Date.UTC(2026, 10, 1), Date.UTC(2027, 0, 31));
  assert.deepEqual(
    ms.map((m) => [m.month, m.visits]),
    [
      ['2026-11', 1],
      ['2026-12', 0],
      ['2027-01', 0],
    ],
    'intermediate months should be zero-filled',
  );
  db.close();
});

test('monthStart truncates to UTC midnight of the 1st', () => {
  const t = Date.UTC(2026, 10, 15, 18, 45);
  const ms = monthStart(t).getTime();
  assert.equal(new Date(ms).toISOString(), '2026-11-01T00:00:00.000Z');
});

test('filtered monthly series agrees with filtered totals', () => {
  const { db, secret } = fresh();
  const ua = 'F-UA/1.0';
  const fq = { sql: 'path = ?', args: ['/hot'] };
  post(db, secret, { pathname: '/hot', ip: '10.0.3.1', ua, ts: Date.UTC(2026, 10, 5) });
  post(db, secret, { pathname: '/hot', ip: '10.0.3.1', ua, ts: Date.UTC(2026, 10, 20) });
  post(db, secret, { pathname: '/cold', ip: '10.0.3.2', ua, ts: Date.UTC(2026, 10, 9) });

  const ms = monthlySeriesFiltered(db, Date.UTC(2026, 10, 1), Date.UTC(2026, 10, 30), fq);
  const nov = ms.find((m) => m.month === '2026-11');
  assert.ok(nov);
  assert.equal(nov.visits, 2, 'only matching-page events count in the filtered monthly series');
  assert.equal(nov.uniques, 1, 'one unique visitor for the matching page');
  db.close();
});
