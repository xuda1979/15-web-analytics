// CLI subcommand handlers were never unit tested: cli.test.js pins only the
// three pure parse helpers (int/collectArgs/pattern) and lifecycle.test.js
// boots `seed` as a black-box subprocess. These tests exercise seed() and
// collectOnce() directly against a throwaway SQLite DB. config.dataDir is
// patched (and restored) because seed()/collectOnce() resolve the privacy
// secret from it at call time — mirroring retention.test.js's comment that
// modules read `config` at import time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/store.js';
import { loadOrCreateSecret, hashGuest } from '../src/privacy.js';
import { config } from '../src/config.js';
import { seed, collectOnce } from '../src/cli.js';
import { totals, dailySeries, weeklySeries, monthlySeries } from '../src/analytics.js';

const DAY = 86_400_000;

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cli-'));
  const db = openDb(path.join(dir, 'test.sqlite'));
  const secret = loadOrCreateSecret(dir);
  const prevDir = config.dataDir;
  config.dataDir = dir;
  return {
    db,
    secret,
    restore: () => {
      config.dataDir = prevDir;
    },
  };
}

const sumVisits = (series) => series.reduce((a, b) => a + b.visits, 0);

test('seed: returns the deterministic real-event count, bot count, and cache posture', () => {
  const { db, restore } = fresh();
  try {
    const days = 30;
    const visitors = 4;
    const n = seed(db, { days, visitors });

    // Per-visitor pageview counts are deterministic: visits = 3 + (v % 3),
    // pageviews per visit = 4 + (v % 4), so n has a closed-form value.
    let expected = 0;
    for (let v = 0; v < visitors; v++) {
      expected += (3 + (v % 3)) * (4 + (v % 4));
    }
    assert.equal(n, expected, 'every inner pageview increment is counted and returned');

    const nonBot = db.prepare('SELECT COUNT(*) n FROM events WHERE is_bot = 0').get().n;
    assert.equal(nonBot, expected, 'return value matches the non-bot events table count');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM events WHERE is_bot = 1').get().n, 2, 'exactly 2 bot rows');

    const botRows = db.prepare('SELECT * FROM events WHERE is_bot = 1').all();
    assert.ok(botRows.every((r) => r.visit_key === null && r.entry_path === null && r.exit_path === null),
      'bot rows carry no visit edges (they are invisible to metrics)');

    // Bots never pollute the write-through caches.
    const cacheVisits = db.prepare('SELECT SUM(visits) s FROM agg_daily_realtime').get().s;
    const bucketVisits = db.prepare("SELECT SUM(visits) s FROM agg_monthly_buckets").get().s;
    assert.equal(cacheVisits, expected, 'realtime cache counts only real events');
    assert.equal(bucketVisits, expected * 2, 'weekly + monthly buckets each count every real event');

    // Dashboard invariant: every series sums to the raw totals. The range is
    // taken from the DB's own row bounds so the clock moving between seed()
    // and these assertions cannot clip either edge.
    const { m: lo, M: hi } = db
      .prepare('SELECT MIN(ts) m, MAX(ts) M FROM events WHERE is_bot = 0')
      .get();
    const t = totals(db, lo, hi);
    assert.equal(t.visits, expected, 'raw totals include no bots');
    assert.equal(sumVisits(dailySeries(db, lo, hi)), t.visits, 'daily sums to totals');
    assert.equal(sumVisits(weeklySeries(db, lo, hi)), t.visits, 'weekly sums to totals');
    assert.equal(sumVisits(monthlySeries(db, lo, hi)), t.visits, 'monthly sums to totals');
  } finally {
    restore();
    db.close();
  }
});

test('seed: stays inside the seeded range and populates breakdown dimensions', () => {
  const { db, restore } = fresh();
  try {
    const days = 60;
    // Anchor the boundary before seeding: seed's `nowFloor` clamp and its
    // `start` are both computed from Date.now() internally, so any clock tick
    // between here and the seed call would otherwise skew the comparison.
    const start = Date.now() - days * DAY;
    const nowFloor = Date.now() - 5 * 60_000;
    const n = seed(db, { days, visitors: 2 });

    const outOfRange = db
      .prepare('SELECT COUNT(*) n FROM events WHERE is_bot = 0 AND (ts < ? OR ts > ?)')
      .get(start, nowFloor).n;
    assert.equal(outOfRange, 0, 'every real event lands in [start, nowFloor] (bots are stamped at "now")');

    const paths = db.prepare('SELECT DISTINCT path FROM events WHERE is_bot = 0').all();
    assert.ok(paths.length >= 4, 'seed walks several of the real PATHS, got ' + paths.map((r) => r.path));
    assert.ok(n >= 16, 'two visitors over 60 days produce a healthy demo volume');
  } finally {
    restore();
    db.close();
  }
});

test('seed: verbose flag logs the deterministic event count and bot total', () => {
  const { db, restore } = fresh();
  try {
    const logs = [];
    const original = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    let n;
    try {
      n = seed(db, { days: 7, visitors: 3, verbose: true });
    } finally {
      console.log = original;
    }
    assert.equal(logs.length, 1, 'no other console output on the verbose path');
    assert.match(logs[0], /^seeded \d+ real events \+ 2 bots over 7 days$/, 'echoes count, bot total and window');
    assert.ok(logs[0].startsWith(`seeded ${n} real events`), 'logged count matches the returned determinstic count');
  } finally {
    restore();
    db.close();
  }
});

test('collectOnce: honors --ip/--ua/--referrer overrides and derives guest key from them', () => {
  const { db, restore } = fresh();
  try {
    const logs = [];
    const original = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
      collectOnce(db, [
        '--path=/cli-ipua',
        '--ip=203.0.113.7',
        '--ua=Mozilla/5.0 (X11; Linux x86_64) styled/2.0',
        '--referrer=https://www.example.org/deep/link?q=1',
        '--title=IP UA Test',
      ]);
    } finally {
      console.log = original;
    }
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^collect: id=\d+ path=\/cli-ipua unique=true$/, 'echoes id, path and uniqueness');

    const row = db.prepare('SELECT * FROM events WHERE path = ?').get('/cli-ipua');
    assert.ok(row, 'event row inserted');
    assert.equal(row.ip, null, 'WA_STORE_IP defaults off: the override feeds the guest key, the row stores null');
    assert.equal(row.ua, 'Mozilla/5.0 (X11; Linux x86_64) styled/2.0', '--ua override lands in the row');
    assert.equal(row.ref_domain, 'example.org', 'referrer host extracted with the www. prefix stripped');
    assert.equal(row.is_bot, 0, 'a custom UA is not a bot');
    assert.equal(row.guest_key, hashGuest('203.0.113.7', 'Mozilla/5.0 (X11; Linux x86_64) styled/2.0', loadOrCreateSecret(config.dataDir)),
      'guest key derived from the overridden ip/ua, not the cli defaults');
  } finally {
    restore();
    db.close();
  }
});

test('collectOnce: defaults apply when flags are omitted', () => {
  const { db, restore } = fresh();
  try {
    const logs = [];
    const original = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
      collectOnce(db, []);
    } finally {
      console.log = original;
    }
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^collect: id=\d+ path=\/ unique=true$/, 'defaults to / when --path is missing');

    const row = db.prepare('SELECT path, referrer, ref_domain, title, lang, ip, ua FROM events ORDER BY id DESC LIMIT 1').get();
    assert.equal(row.path, '/', 'path defaults to /');
    assert.equal(row.referrer, '', 'referrer defaults to empty string');
    assert.equal(row.ref_domain, null, 'empty referrer yields no ref domain');
    assert.equal(row.title, '', 'title defaults to empty');
    assert.equal(row.lang, '', 'lang defaults to empty');
    assert.equal(row.ip, null, 'ip defaults to the cli/1.0 identity, redacted when WA_STORE_IP is off');
    assert.equal(row.ua, 'cli/1.0', 'ua defaults to cli/1.0');
  } finally {
    restore();
    db.close();
  }
});

test('collectOnce: records a normalized event with parsed flags and echoes unique=true', () => {
  const { db, restore } = fresh();
  try {
    const logs = [];
    const original = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
      collectOnce(db, [
        '--path=/cli-test',
        '--sw=390',
        '--sh=844',
        '--referrer=https://example.com/?a=1',
        '--lang=en-US',
        '--title=CLI Test',
      ]);
    } finally {
      console.log = original;
    }
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^collect: id=\d+ path=\/cli-test unique=true$/, 'echoes id, path and uniqueness');

    const row = db.prepare('SELECT * FROM events WHERE path = ?').get('/cli-test');
    assert.ok(row, 'event row inserted');
    assert.equal(row.screen_w, 390, '--sw parsed');
    assert.equal(row.screen_h, 844, '--sh parsed');
    assert.equal(row.ref_domain, 'example.com', 'referrer host extracted');
    assert.equal(row.lang, 'en-US');
    assert.equal(row.title, 'CLI Test');
    assert.equal(row.is_bot, 0, 'cli/1.0 UA is not a bot');
    assert.equal(row.guest_key, hashGuest('127.0.0.1', 'cli/1.0', loadOrCreateSecret(config.dataDir)),
      'guest key derived from the default cli ip/ua and the data-dir secret');
  } finally {
    restore();
    db.close();
  }
});
