// Retention tests: pruning deletes old events and keeps the aggregate caches
// consistent (dashboard invariant: every series sums to the raw totals).
//
// Run against a throwaway SQLite DB with controlled timestamps (mirrors
// aggregation.test.js: modules read `config` at import time, so an explicit
// DB path is used rather than the default ./data).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/store.js';
import { loadOrCreateSecret } from '../src/privacy.js';
import { insertEvent, normalizeEvent } from '../src/collector.js';
import { pruneEvents } from '../src/retention.js';
import { totals, dailySeries, weeklySeries, monthlySeries } from '../src/analytics.js';

const DAY = 86_400_000;

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-ret-'));
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

const sumVisits = (series) => series.reduce((a, b) => a + b.visits, 0);

test('prune: deletes old events and rebuilds caches so every series sums to totals', () => {
  const { db, secret } = fresh();
  const now = Date.now();

  // Recent: guest A's 3-page visit + guest B single page.
  post(db, secret, { pathname: '/rv1', ip: '10.1.0.1', ua: 'UA-A', ts: now - 1 * DAY });
  post(db, secret, { pathname: '/rv2', ip: '10.1.0.1', ua: 'UA-A', ts: now - 1 * DAY + 60_000 });
  post(db, secret, { pathname: '/rv3', ip: '10.1.0.1', ua: 'UA-A', ts: now - 1 * DAY + 120_000 });
  post(db, secret, { pathname: '/rvb', ip: '10.1.0.2', ua: 'UA-B', ts: now - 2 * DAY });
  // Old: guest C single page, inside the retention window boundary.
  post(db, secret, { pathname: '/old1', ip: '10.2.0.1', ua: 'UA-C', ts: now - 30 * DAY });

  const range = [now - 5 * DAY, now];
  const beforeTotals = totals(db, range[0], range[1]);
  assert.equal(sumVisits(dailySeries(db, range[0], range[1])), beforeTotals.visits, 'daily sums before prune');
  assert.equal(sumVisits(weeklySeries(db, range[0], range[1])), beforeTotals.visits, 'weekly sums before prune');
  assert.equal(sumVisits(monthlySeries(db, range[0], range[1])), beforeTotals.visits, 'monthly sums before prune');

  const res = pruneEvents(db, now - 5 * DAY);
  assert.equal(res.deleted, 1, 'only the 30-day-old event is pruned');
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM events WHERE path = '/old1'`).get().n, 0, 'old row deleted');
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM events WHERE is_bot = 0`).get().n, 4, 'recent events survive');

  // Invariants hold after the cache rebuild.
  const afterTotals = totals(db, range[0], range[1]);
  assert.equal(afterTotals.visits, beforeTotals.visits, 'recent totals untouched');
  assert.equal(sumVisits(dailySeries(db, range[0], range[1])), afterTotals.visits, 'daily sums after prune');
  assert.equal(sumVisits(weeklySeries(db, range[0], range[1])), afterTotals.visits, 'weekly sums after prune');
  assert.equal(sumVisits(monthlySeries(db, range[0], range[1])), afterTotals.visits, 'monthly sums after prune');

  // The run is recorded for the audit report.
  const lastPrune = db.prepare(`SELECT value FROM meta WHERE key = 'last_prune'`).get();
  assert.ok(lastPrune && lastPrune.value, 'meta.last_prune is recorded');

  db.close();
});

test('prune: exceeding the visit window splits one guest into two visits', () => {
  const { db, secret } = fresh();
  const now = Date.now();
  const ua = 'UA-Split';

  // Same guest: one event now, one event just inside the retention window
  // (gap >> visitWindowMs = 30min). The old event is pruned; the survivor must
  // become a fresh single-event visit (its own entry/exit).
  post(db, secret, { pathname: '/recent', ip: '10.3.0.1', ua, ts: now - 1 * DAY });
  post(db, secret, { pathname: '/keep-almost-oldest', ip: '10.3.0.1', ua, ts: now - 6 * DAY });

  const cutoff = now - 5 * DAY;
  const res = pruneEvents(db, cutoff);
  assert.equal(res.deleted, 1, 'the >5d event is pruned');
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM events WHERE is_bot = 0`).get().n, 1, 'one survivor');

  // The survivor remains countable over a wide window (its ts is around
  // now - 6d, not old enough to push it out of an 8-day overview range).
  const range = [now - 8 * DAY, now];
  const t = totals(db, range[0], range[1]);
  assert.equal(t.visits, 1, 'survivor counted once');
  assert.equal(t.uniques, 1, 'survivor is its own unique visitor after the gap');
  assert.equal(sumVisits(dailySeries(db, range[0], range[1])), t.visits, 'series sum to totals');

  db.close();
});

test('prune: a cutoff that deletes nothing is a no-op — caches and meta untouched', () => {
  const { db, secret } = fresh();
  const now = Date.now();

  // All events sit on or after the cutoff, so nothing qualifies for deletion.
  post(db, secret, { pathname: '/fresh', ip: '10.4.0.1', ua: 'UA-N', ts: now });
  post(db, secret, { pathname: '/exact', ip: '10.4.0.2', ua: 'UA-N', ts: now - 1 * DAY });

  const aggRows = () => ({
    rt: db.prepare('SELECT count(*) n FROM agg_daily_realtime').get().n,
    buckets: db.prepare('SELECT count(*) n FROM agg_monthly_buckets').get().n,
  });
  assert.deepEqual(aggRows(), { rt: 2, buckets: 2 }, 'write-through caches populated by the inserts');

  const cutoff = now - 1 * DAY; // strictly-interior cutoff: the exact-1d event survives (`ts < cutoff` only)
  const res = pruneEvents(db, cutoff);
  assert.equal(res.deleted, 0, 'nothing matched the cutoff');
  assert.equal(res.cutoff_ts, cutoff, 'cutoff_ts echoes the caller');
  assert.equal(db.prepare('SELECT count(*) n FROM events').get().n, 2, 'events table untouched');

  // The `if (deleted > 0)` guard must not fire: no cache wipe, no last_prune row.
  assert.deepEqual(aggRows(), { rt: 2, buckets: 2 }, 'agg caches are not wiped on a no-op');
  assert.equal(db.prepare(`SELECT count(*) n FROM meta WHERE key = 'last_prune'`).get().n, 0, 'no prune run is recorded');

  // Dashboard invariant still holds after the no-op.
  const range = [now - 2 * DAY, now];
  const t = totals(db, range[0], range[1]);
  assert.equal(t.visits, 2);
  assert.equal(sumVisits(dailySeries(db, range[0], range[1])), t.visits, 'series still sum to totals');

  db.close();
});

test('prune: an empty DB never records a last_prune run', () => {
  const { db } = fresh();

  const res = pruneEvents(db, Date.now());
  assert.equal(res.deleted, 0, 'no rows to delete');
  assert.equal(db.prepare(`SELECT count(*) n FROM meta WHERE key = 'last_prune'`).get().n, 0, 'meta stays bare');
  assert.equal(db.prepare('SELECT count(*) n FROM agg_daily_realtime').get().n, 0, 'caches stay empty');

  db.close();
});

test('prune: bot events are deleted but stay absent from metrics', () => {
  const { db, secret } = fresh();
  const now = Date.now();

  const postRaw = (pathname, ip, ua, ts, isBot) => {
    const ev = normalizeEvent({ path: pathname }, { ip, ua }, secret);
    ev.ts = ts;
    ev.visited_at = new Date(ts).toISOString();
    insertEvent(db, { ...ev, is_bot: isBot });
  };
  postRaw('/bot-old', '10.9.0.1', 'Mozilla Googlebot', now - 30 * DAY, 1);
  postRaw('/human', '10.9.0.2', 'UA-H', now - 1 * DAY, 0);

  const before = totals(db, now - 5 * DAY, now);
  assert.equal(before.visits, 1, 'bot excluded from metrics before prune');

  const res = pruneEvents(db, now - 5 * DAY);
  assert.equal(res.deleted, 1, 'bot row is still pruned from the raw store');
  const after = totals(db, now - 5 * DAY, now);
  assert.equal(after.visits, 1, 'metrics unchanged');
  assert.equal(sumVisits(dailySeries(db, now - 5 * DAY, now)), after.visits, 'series consistent');

  db.close();
});

test('prune: a mid-rebuild failure rolls back the partial delete (atomicity)', () => {
  const { db, secret } = fresh();
  const now = Date.now();

  // Two events: one older than the cutoff (so the DELETE qualifies), one
  // recent. The inserts write both series caches (write-through), so a
  // mid-rebuild failure must restore every side effect, not just the raw rows.
  post(db, secret, { pathname: '/atomic-old', ip: '10.7.0.1', ua: 'UA-AT', ts: now - 30 * DAY });
  post(db, secret, { pathname: '/atomic-new', ip: '10.7.0.2', ua: 'UA-AT', ts: now - 1 * DAY });

  const rows = () => ({
    events: db.prepare('SELECT COUNT(*) n FROM events').get().n,
    rt: db.prepare('SELECT COUNT(*) n FROM agg_daily_realtime').get().n,
    buckets: db.prepare('SELECT COUNT(*) n FROM agg_monthly_buckets').get().n,
  });
  const before = rows();

  // Sabotage the rebuild: a trigger fires on the very first INSERT into
  // agg_daily_realtime, i.e. after pruneEvents has already DELETEd the old
  // events and wiped both caches inside the transaction.
  db.exec(`
    CREATE TRIGGER fail_rebuild BEFORE INSERT ON agg_daily_realtime
    BEGIN SELECT RAISE(ABORT, 'sabotage: rebuild insert'); END
  `);

  try {
    assert.throws(() => pruneEvents(db, now - 5 * DAY), 'the rebuild failure propagates');
  } finally {
    db.exec('DROP TRIGGER IF EXISTS fail_rebuild');
  }

  // The ROLLBACK in pruneEvents' catch undid the DELETE and cache wipes: every
  // table sits exactly as it did before the prune.
  assert.deepEqual(rows(), before, 'rollback restores raw events and both series caches');
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM events WHERE path = '/atomic-old'").get().n,
    1,
    'the qualifying event survives the rollback',
  );
  assert.equal(db.prepare(`SELECT count(*) n FROM meta WHERE key = 'last_prune'`).get().n, 0,
    'no prune run is recorded on a failed commit');

  db.close();
});
