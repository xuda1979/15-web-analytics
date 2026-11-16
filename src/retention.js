// Data retention: prune events older than a cutoff and keep the aggregate
// caches consistent.
//
// The events table is the source of truth; the agg_* tables are incremental
// caches (write-through on insert). Deleting raw events without touching the
// caches would leave the daily/weekly monthly series disagreeing with the raw
// totals (a dashboard invariant). So a prune:
//   1. DELETEs old events,
//   2. wipes all agg caches,
//   3. rebuilds them from the surviving non-bot events, replicating the exact
//      write-through logic in insertEvent() (per-guest unique-visitor
//      heuristic, visit-window splitting, realtime + monthly buckets),
//   4. re-runs refreshEntryExit() so entry/exit edges reflect the pruned set,
//   5. records the run in meta(last_prune).

import { config } from './config.js';
import { dayKey, monthKey, monthStart, weekStart } from './store.js';
import { refreshEntryExitCore } from './collector.js';

const AGG_TABLES = [
  'agg_daily_pages',
  'agg_daily_sources',
  'agg_daily_devices',
  'agg_daily_browsers',
  'agg_daily_realtime',
  'agg_monthly_buckets',
];

// Increment a counter cache given the numeric deltas (mirror of
// collector.js `upsert`, kept private here).
function upsert(db, table, where, uniqDelta) {
  const args = { ...where, u: uniqDelta };
  db.prepare(
    `INSERT INTO ${table} (${Object.keys(where).join(', ')}, visits, uniques)
     VALUES (${Object.keys(where).map(() => '?').join(', ')}, 1, ?)
     ON CONFLICT(${Object.keys(where).join(', ')}) DO UPDATE SET
       visits = visits + 1,
       uniques = uniques + excluded.uniques`,
  ).run(...Object.values(where), args.u);
}

// Delete events older than cutoffMs and rebuild the aggregate caches from the
// surviving (non-bot) rows. Returns { deleted, cutoff_ts }.
export function pruneEvents(db, cutoffMs) {
  db.exec('BEGIN');
  try {
    const deleted = Number(
      db.prepare('DELETE FROM events WHERE ts < ?').run(cutoffMs).changes,
    );

    if (deleted > 0) {
      for (const t of AGG_TABLES) db.exec(`DELETE FROM ${t}`);

      // Rebuild in the same order insertEvent() writes caches, applying the
      // same unique-visitor heuristic against the surviving rows only.
      const rows = db
        .prepare(
          `SELECT guest_key, ts, path, ref_domain, device, browser
           FROM events WHERE is_bot = 0
           ORDER BY guest_key, ts`,
        )
        .all();

      let lastKey = null;
      let lastTs = 0;
      for (const r of rows) {
        const uniq = lastKey !== r.guest_key || r.ts - lastTs > config.visitWindowMs ? 1 : 0;
        lastKey = r.guest_key;
        lastTs = r.ts;
        const dk = dayKey(r.ts);

        upsert(db, 'agg_daily_pages', { d: dk, path: r.path }, uniq);

        upsert(db, 'agg_daily_sources', { d: dk, source: r.ref_domain || '(direct)' }, uniq);
        upsert(db, 'agg_daily_devices', { d: dk, kind: r.device }, uniq);
        upsert(db, 'agg_daily_browsers', { d: dk, browser: r.browser || 'Unknown' }, uniq);

        const bm = Math.floor(r.ts / 60_000) * 60_000;
        db.prepare(
          `INSERT INTO agg_daily_realtime(day, bucket1m, visits, uniques)
           VALUES (?, ?, 1, ?)
           ON CONFLICT(day, bucket1m) DO UPDATE SET
             visits = visits + 1, uniques = uniques + excluded.uniques`,
        ).run(dk, bm, uniq);

        db.prepare(
          `INSERT INTO agg_monthly_buckets(yyyymm, bucket, start, visits, uniques)
           VALUES (?, 'week', ?, 1, ?)
           ON CONFLICT(yyyymm, bucket, start) DO UPDATE SET
             visits = visits + 1, uniques = uniques + excluded.uniques`,
        ).run(monthKey(r.ts), weekStart(r.ts).getTime(), uniq);

        db.prepare(
          `INSERT INTO agg_monthly_buckets(yyyymm, bucket, start, visits, uniques)
           VALUES (?, 'month', ?, 1, ?)
           ON CONFLICT(yyyymm, bucket, start) DO UPDATE SET
             visits = visits + 1, uniques = uniques + excluded.uniques`,
        ).run(monthKey(r.ts), monthStart(r.ts).getTime(), uniq);
      }

      // Re-frame entry/exit edges across surviving events (preserves shared
      // visit keys and rewrites edges at the new boundaries). Runs inside the
      // current transaction (core variant; no nested BEGIN).
      refreshEntryExitCore(db, cutoffMs);

      db.prepare(
        `INSERT INTO meta(key, value) VALUES ('last_prune', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(new Date().toISOString());
    }

    db.exec('COMMIT');
    return { deleted, cutoff_ts: cutoffMs };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
