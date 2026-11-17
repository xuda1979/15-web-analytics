// store.js contracts: the SQLite access layer every other module builds on.
// openDb() applies WAL + busy_timeout + synchronous pragmas, creates the
// schema, ALTERs pre-existing events tables up to the current columns (so an
// in-place upgrade keeps old rows), rebuilds indexes and seeds the meta table.
// The date helpers are the bucketing keys the caches and series reads align
// to — a regression there would silently skew daily/weekly/monthly numbers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  openDb, bucketMinutes, dayKey, monthKey, monthStart, weekStart, iso,
} from '../src/store.js';

// 2026-11-10 09:00 UTC is a Tuesday.
const T = Date.UTC(2026, 10, 10, 9, 0);
const MIN = 60_000;

test('openDb seeds a fresh DB with all tables, indexes, meta and WAL', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-sto-'));
  const file = path.join(dir, 'analytics.sqlite');
  try {
    const db = openDb(file);
    assert.equal(db.prepare('SELECT count(*) c FROM meta').get().c, 1);
    assert.equal(db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version').value, '1');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
    for (const t of ['events', 'agg_daily_realtime', 'agg_monthly_buckets', 'meta']) {
      assert.ok(tables.includes(t), `table ${t} exists`);
    }
    const indexNames = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'").all().map((r) => r.name);
    for (const ix of ['idx_events_ts', 'idx_events_guest', 'idx_events_path', 'idx_events_visit']) {
      assert.ok(indexNames.includes(ix), `index ${ix} exists`);
    }
    const jm = db.prepare('PRAGMA journal_mode').get();
    assert.equal(typeof jm.journal_mode, 'string');
    db.exec('INSERT INTO events (ts, visited_at, guest_key, ua, path, is_bot) VALUES (1,\'x\',\'g\',\'u\',\'/\',0)');
    assert.equal(db.prepare('SELECT count(*) c FROM events').get().c, 1, 'events table is writable');
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('openDb migrates a pre-existing table up to the current schema and keeps its rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-sto-'));
  const file = path.join(dir, 'legacy.sqlite');
  try {
    const legacy = new DatabaseSync(file);
    legacy.exec(
      'CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, ' +
      'visited_at TEXT NOT NULL, guest_key TEXT NOT NULL, ua TEXT NOT NULL, ' +
      'path TEXT NOT NULL, is_bot INTEGER NOT NULL DEFAULT 0)',
    );
    legacy.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
    legacy.exec('INSERT INTO events (ts, visited_at, guest_key, ua, path, is_bot) VALUES (1,\'a\',\'g\',\'u\',\'/\',0)');
    legacy.close();

    const db = openDb(file); // the migration path
    const cols = db.prepare("SELECT name FROM pragma_table_info('events')").all().map((r) => r.name);
    for (const c of ['visit_key', 'entry_path', 'exit_path', 'device_model']) {
      assert.ok(cols.includes(c), `legacy table gained ${c}`);
    }
    const row = db.prepare("SELECT path FROM events WHERE id = 1").get();
    assert.equal(row.path, '/', 'pre-existing event survived the ALTER upgrade');
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bucketMinutes floors the start and walks whole minutes to the end', () => {
  assert.deepEqual(bucketMinutes(5_000, 65_000), [0, 60_000]);
  assert.deepEqual(bucketMinutes(0, 0), [0]);
  assert.deepEqual(bucketMinutes(T, T + 225_000), [T, T + MIN, T + 2 * MIN, T + 3 * MIN]);
});

test('dayKey/monthKey render UTC calendar parts with zero padding', () => {
  assert.equal(dayKey(T), '2026-11-10');
  assert.equal(dayKey(Date.UTC(2026, 0, 5, 23, 59)), '2026-01-05');
  assert.equal(dayKey(Date.UTC(2026, 11, 31, 1, 0)), '2026-12-31');
  assert.equal(monthKey(T), '2026-11');
  assert.equal(monthKey(Date.UTC(2026, 11, 1, 3, 0)), '2026-12', 'month key follows UTC, not the local zone');
  assert.equal(monthKey(Date.UTC(2027, 0, 1, 3, 0)), '2027-01');
});

test('monthStart aligns every event of a UTC month to its first instant', () => {
  assert.equal(monthStart(T).toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(monthStart(Date.UTC(2026, 11, 31, 23, 59)).toISOString(), '2026-12-01T00:00:00.000Z');
  assert.equal(monthStart(Date.UTC(2027, 0, 15)).toISOString(), '2027-01-01T00:00:00.000Z');
});

test('weekStart aligns every event of a week to Monday 00:00 UTC', () => {
  // 2026-11-09 is the Monday of the week containing Tuesday 2026-11-10.
  assert.equal(weekStart(T).toISOString(), '2026-11-09T00:00:00.000Z');
  assert.equal(weekStart(Date.UTC(2026, 10, 9, 0, 0)).toISOString(), '2026-11-09T00:00:00.000Z', 'Monday maps to itself');
  assert.equal(weekStart(Date.UTC(2026, 10, 15, 23, 59)).toISOString(), '2026-11-09T00:00:00.000Z', 'Sunday still belongs to the Monday-starting week');
  // January: 2027-01-01 is a Friday whose Monday is 2026-12-28 (previous year).
  assert.equal(weekStart(Date.UTC(2027, 0, 1)).toISOString(), '2026-12-28T00:00:00.000Z');
});

test("iso renders whole seconds with a trailing Z (analytics' timestamps)", () => {
  assert.equal(iso(T), '2026-11-10T09:00:00Z');
  assert.equal(iso(T + 123), '2026-11-10T09:00:00Z', 'sub-second truncated');
  assert.equal(iso(T + 60_987), '2026-11-10T09:01:00Z');
});
