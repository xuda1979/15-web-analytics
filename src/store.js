// SQLite access layer for 15-web-analytics.
//
// A single DatabaseSync handle is shared by all request handlers. SQLite
// serializes writes; busy_timeout keeps concurrent POSTs sane under a single
// Node process (event loop is single-threaded anyway).

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { config } from './config.js';
import { SCHEMA_TABLES, SCHEMA_INDEXES } from './schema.js';

// Columns added after the initial schema (visit-key work). Added via ALTER
// TABLE when a pre-existing DB lacks them, so an in-place upgrade keeps old
// events. refreshEntryExit() later backfills visit_key/entry_path/exit_path.
const EVENT_SQL_ADD = [
  'visit_key INTEGER',
  'entry_path TEXT',
  'exit_path TEXT',
  'device_model TEXT',
];

function migrate(db) {
  const cols = new Set(
    db
      .prepare(`SELECT name FROM pragma_table_info('events')`)
      .all()
      .map((r) => r.name),
  );
  for (const def of EVENT_SQL_ADD) {
    const name = def.split(' ')[0];
    if (!cols.has(name)) {
      db.exec(`ALTER TABLE events ADD COLUMN ${def}`);
    }
  }
}

export function openDb(dbPath = config.dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  // Tables first, then migrate pre-existing tables to the current schema,
  // then indexes (idx_events_visit references a column that may not exist
  // until the migration above has run).
  db.exec(SCHEMA_TABLES);
  migrate(db);
  db.exec(SCHEMA_INDEXES);
  db.exec(
    "INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1')",
  );
  return db;
}

// Real, per-minute (epoch ms) buckets for a time range.
export function bucketMinutes(startMs, endMs) {
  const out = [];
  const step = 60_000;
  const first = Math.floor(startMs / step) * step;
  for (let t = first; t <= endMs; t += step) out.push(t);
  return out;
}

// Shift an instant by the configured UTC offset before deriving calendar parts.
// With WA_HOUR_OFFSET_MIN=480 (UTC+8) a 16:30 UTC event is "2026-11-11 00:30",
// so day/week/month boundaries roll over at local midnight instead of 08:00
// UTC. Read at call time (not import time) so tests can mutate the config and
// existing installs pick up a new offset without a restart. Offset 0 keeps the
// exact original UTC behavior.
function shifted(ms) {
  return new Date(ms + config.hourOffsetMin * 60_000);
}

export function dayKey(ms) {
  const d = shifted(ms);
  const s = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${s(d.getUTCMonth() + 1)}-${s(d.getUTCDate())}`;
}

export function monthKey(ms) {
  const d = shifted(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function monthStart(ms) {
  // First day of the (local, offset-adjusted) month at midnight. Like
  // weekStart, this value is a bucketing key: events from the same local month
  // must share one aligned value.
  const d = shifted(ms);
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export function weekStart(ms) {
  // Monday-based at the (local, offset-adjusted) midnight; weeks align to that
  // zone's calendar, not to a DST schedule (the offset is constant minutes).
  // Truncation matters: agg_monthly_buckets.start is a bucketing key, and
  // events from the same week must share one aligned start value even if they
  // arrive at different times of day.
  const d = shifted(ms);
  const day = d.getUTCDay() || 7; // Sun=7
  d.setUTCDate(d.getUTCDate() - day + 1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export function iso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
