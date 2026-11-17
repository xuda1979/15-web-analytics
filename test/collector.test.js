// Collector contracts: payload normalization and the visit/aggregate-cache
// write path. normalizeEvent() is the single gate every collect POST passes
// through — field coercions, truncations, UA parsing and the bot flag — yet
// until now it was only exercised as a fixture inside the aggregation /
// entryexit / monthly / retention suites. insertEvent() carries the
// unique-visitor heuristic (gap vs config.visitWindowMs), the per-visit
// entry/exit/visit-key edges, and the write-through realtime + weekly/monthly
// caches that the series reads depend on; bots must stay out of all of them
// or the cached series would disagree with the raw-event totals.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { config } from '../src/config.js';
import { openDb } from '../src/store.js';
import { loadOrCreateSecret } from '../src/privacy.js';
import { referrerDomain, normalizeEvent, insertEvent } from '../src/collector.js';

// 2026-11-10 09:00 UTC is a Tuesday.
const T = Date.UTC(2026, 10, 10, 9, 0);
const MIN = 60_000;
const UA = 'Collector-UA/1.0';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-col-'));
  const db = openDb(path.join(dir, 'test.sqlite'));
  const secret = loadOrCreateSecret(dir);
  const post = (pathname, meta = {}) => {
    const ev = normalizeEvent({ path: pathname }, { ua: UA, ...meta }, secret);
    ev.visited_at = new Date(ev.ts).toISOString();
    return insertEvent(db, ev);
  };
  return { db, secret, post };
}

test('normalizeEvent fills the visitor contract for a clean request', () => {
  const { secret } = fresh();
  const ev = normalizeEvent(
    {
      path: '/blog/post-1',
      referrer: 'https://www.Example.com/a?x=1',
      title: 'Title',
      lang: 'en',
      sw: '1280',
      sh: '720',
      country: 'us',
    },
    { ip: '203.0.113.9', ua: UA, ts: T, country: 'cn' },
    secret,
  );
  assert.equal(ev.ts, T);
  assert.equal(ev.visited_at, new Date(T).toISOString());
  assert.match(ev.guest_key, /^[0-9a-f]{64}$/);
  assert.equal(ev.ip, null, 'IP is not stored under the default WA_STORE_IP');
  assert.equal(ev.path, '/blog/post-1');
  assert.equal(ev.ref_domain, 'example.com', 'www prefix stripped from referrer host');
  assert.equal(ev.country, 'cn', 'meta.country (x-country header) beats the payload');
  assert.equal(ev.screen_w, 1280);
  assert.equal(ev.screen_h, 720);
  assert.equal(ev.is_bot, 0);
});

test('referrerDomain returns the www-less host or null', () => {
  assert.equal(referrerDomain('https://www.Example.com/foo?a=1#x'), 'example.com');
  assert.equal(referrerDomain('https://SITE.cn/path'), 'site.cn');
  assert.equal(referrerDomain('example.com/path'), null, 'bare host is not a valid URL');
  assert.equal(referrerDomain(''), null);
  assert.equal(referrerDomain(null), null);
  assert.equal(referrerDomain('not a url'), null);
});

test('normalizeEvent truncates long fields and clamps integers', () => {
  const { secret } = fresh();
  const ev = normalizeEvent(
    {
      path: '/x'.repeat(300),
      referrer: `https://r.io/${'p'.repeat(700)}`,
      title: 't'.repeat(500),
      lang: 'en-US-Extra-Long'.repeat(3),
      sw: '12.9',
      sh: '-5',
    },
    { ua: UA, ts: T },
    secret,
  );
  assert.equal(ev.path.length, 512, 'path capped at 512 chars');
  assert.equal(ev.referrer.length, 600, 'referrer capped at 600 chars');
  assert.equal(ev.title.length, 300, 'title capped at 300 chars');
  assert.equal(ev.lang.length, 20, 'lang capped at 20 chars');
  assert.equal(ev.screen_w, 12, 'parseInt truncates 12.9 at the decimal point');
  assert.equal(ev.screen_h, 0, 'negative screen height clamps to 0');
});

test('normalizeEvent tolerates absent payloads and odd values', () => {
  const { secret } = fresh();
  const ev = normalizeEvent({}, { ip: 'not-an-ip', ua: '', ts: T }, secret);
  assert.equal(ev.path, '/', 'missing path defaults to /');
  assert.equal(ev.ip, null);
  assert.equal(ev.ua, '', 'absent UA becomes an empty string');
  assert.equal(ev.ref_domain, null);
  assert.equal(ev.country, null);
  assert.equal(ev.screen_w, undefined, 'missing sw stays undefined (NULL on insert)');
  assert.equal(ev.browser, 'Unknown', 'unparseable UA falls back');
  assert.equal(ev.device, 'desktop');
  assert.equal(ev.device_model, '');
});

test('normalizeEvent parses the UA dimensions for a mobile visit', () => {
  const { secret } = fresh();
  const ev = normalizeEvent({ path: '/' }, { ip: '2001:db8::7', ua: IPHONE, ts: T }, secret);
  assert.equal(ev.browser, 'Mobile Safari');
  assert.equal(ev.browser_version, '17');
  assert.equal(ev.device, 'mobile');
  assert.equal(ev.device_model, 'iPhone');
  assert.equal(ev.os, 'iOS');
});

test('normalizeEvent flags bot UAs and stores no IP for them', () => {
  const { secret } = fresh();
  const ev = normalizeEvent(
    { path: '/x' },
    { ip: '203.0.113.9', ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', ts: T },
    secret,
  );
  assert.equal(ev.is_bot, 1);
  assert.equal(ev.ip, null);
});

test('normalizeEvent keeps the truncated cleartext IP when WA_STORE_IP is on', () => {
  config.storeIp = true;
  try {
    const { secret } = fresh();
    const ev = normalizeEvent({ path: '/x' }, { ip: '203.0.113.9', ua: UA, ts: T }, secret);
    assert.equal(ev.ip, '203.0.113.9', 'explicitly configured IP is retained');
    const long = normalizeEvent({ path: '/y' }, { ip: 'v4'.repeat(40), ua: UA, ts: T }, secret);
    assert.equal(long.ip.length, 64, 'cleartext IP is capped at 64 chars');
  } finally {
    config.storeIp = false;
  }
});

test('insertEvent: unique-visitor heuristic splits visits at visitWindowMs', () => {
  const { db, post } = fresh();
  const r1 = post('/a', { ts: T });
  const r2 = post('/b', { ts: T + MIN });
  const r3 = post('/c', { ts: T + 2 * MIN });
  const r4 = post('/d', { ts: T + 2 * 3600_000 });

  assert.equal(r1.isUnique, true, 'first event of a guest starts a visit');
  assert.equal(r2.isUnique, false, 'event within the window continues the visit');
  assert.equal(r3.isUnique, false);
  assert.equal(r4.isUnique, true, 'gap larger than the window starts a fresh visit');
  assert.ok(Number.isInteger(r1.id) && r1.id > 0, 'insert returns the row id');

  const rows = db
    .prepare('SELECT path, visit_key, entry_path, exit_path FROM events ORDER BY ts')
    .all();
  assert.equal(rows[0].entry_path, '/a');
  assert.equal(rows[1].entry_path, '/a', 'continuing events inherit the visit entry');
  assert.equal(rows[1].exit_path, '/b', 'exit tracks the latest page');
  assert.equal(rows[2].exit_path, '/c');
  assert.equal(rows[3].visit_key, T + 2 * 3600_000, 'new visit key is its first event ts');
  assert.equal(rows[3].entry_path, '/d');
  for (const row of rows.slice(0, 3)) {
    assert.equal(row.visit_key, T, 'window-close events share the first event visit key');
  }
  assert.notEqual(rows[3].visit_key, T, 'second visit carries a distinct key');
});

test('insertEvent excludes bots from edges and aggregate caches', () => {
  const { db, post } = fresh();
  post('/a', { ts: T });
  post('/noisy', { ts: T + MIN, ua: 'Mozilla/5.0 (compatible; Googlebot/2.1)' });
  post('/b', { ts: T + 2 * MIN });

  const bot = db.prepare("SELECT * FROM events WHERE path = '/noisy'").get();
  assert.equal(bot.is_bot, 1);
  assert.equal(bot.entry_path, null, 'bots carry no visit edges');
  assert.equal(bot.exit_path, null);
  assert.equal(bot.visit_key, null);

  const b = db.prepare("SELECT visit_key FROM events WHERE path = '/b'").get();
  assert.equal(b.visit_key, T, 'a bot in between never breaks the human visit');

  const realtime = db.prepare('SELECT sum(visits) v, sum(uniques) u FROM agg_daily_realtime').get();
  assert.deepEqual({ ...realtime }, { v: 2, u: 1 }, 'only the two human events reach the realtime cache');
  const weekly = db.prepare("SELECT visits, uniques FROM agg_monthly_buckets WHERE bucket = 'week'").get();
  assert.deepEqual({ ...weekly }, { visits: 2, uniques: 1 }, 'week cache skips the bot');
  const monthly = db.prepare("SELECT visits, uniques FROM agg_monthly_buckets WHERE bucket = 'month'").get();
  assert.deepEqual({ ...monthly }, { visits: 2, uniques: 1 }, 'month cache skips the bot');
});

test('insertEvent counts a second distinct visit as +1 unique in the caches', () => {
  const { db, post } = fresh();
  post('/a', { ts: T });
  post('/b', { ts: T + 40 * MIN }); // gap > 30 min window
  const weekly = db.prepare("SELECT visits, uniques FROM agg_monthly_buckets WHERE bucket = 'week'").get();
  assert.deepEqual({ ...weekly }, { visits: 2, uniques: 2 });
  const rt = db.prepare('SELECT count(*) c FROM agg_daily_realtime').get();
  assert.equal(rt.c, 2, 'one realtime row per distinct minute bucket');
});

test('insertEvent aligns realtime/weekly/monthly buckets to the UTC calendar key', () => {
  const { db, post } = fresh();
  post('/a', { ts: T }); // Tue 2026-11-10 09:00 UTC
  const rt = db.prepare('SELECT day, bucket1m FROM agg_daily_realtime').get();
  assert.equal(rt.day, '2026-11-10');
  assert.equal(rt.bucket1m, Math.floor(T / MIN) * MIN, 'bucket1m floors to the minute');
  const weekly = db.prepare("SELECT yyyymm, start FROM agg_monthly_buckets WHERE bucket = 'week'").get();
  assert.equal(weekly.yyyymm, '2026-11');
  assert.equal(weekly.start, Date.UTC(2026, 10, 9), 'week bucket starts Monday 2026-11-09 00:00 UTC');
  const monthly = db.prepare("SELECT yyyymm, start FROM agg_monthly_buckets WHERE bucket = 'month'").get();
  assert.equal(monthly.yyyymm, '2026-11');
  assert.equal(monthly.start, Date.UTC(2026, 10, 1), 'month bucket starts 2026-11-01 00:00 UTC');
});
