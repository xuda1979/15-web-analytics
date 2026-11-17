// Entry/exit semantics: counted per VISIT, not per event.
//
// A visit is a burst of events from one guest within `visitWindowMs`. Each
// visit contributes exactly one entry (first page) and one exit (last page),
// regardless of how many pages it contains. The report must:
//   1. not multiply-count an entry/exit for every event of the visit
//   2. keep the visit's entry fixed at the first page even while later pages
//      stream in (refreshEntryExit finalizes in-flight visits)
//   3. apply page filters to the *visit* (a visit touching the filtered page
//      is included, and reports that visit's real entry/exit pages)
//   4. pair each edge's visit count with the distinct uniques behind it (two
//      visits from the same guest count 2 visits but 1 unique, mirroring the
//      other top lists)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/store.js';
import { loadOrCreateSecret } from '../src/privacy.js';
import { insertEvent, normalizeEvent, refreshEntryExit } from '../src/collector.js';
import { entryExitPages, entryExitFiltered } from '../src/analytics.js';

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-ee-'));
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

const UA = 'Entry-Exit-UA/1.0';
// 2026-11-09 is a Monday (UTC).
const TUE = Date.UTC(2026, 10, 10, 9, 0);
const MIN = 60_000;

test('entry/exit counted per visit: 1 entry + 1 exit per visit, not per event', () => {
  const { db, secret } = fresh();
  // Visit A: 3 pages within the window.
  post(db, secret, { pathname: '/entry-a', ip: '10.0.0.1', ua: UA, ts: TUE });
  post(db, secret, { pathname: '/mid', ip: '10.0.0.1', ua: UA, ts: TUE + MIN });
  post(db, secret, { pathname: '/exit-a', ip: '10.0.0.1', ua: UA, ts: TUE + 2 * MIN });
  // Visit B: a second visit for the same guest after the window.
  post(db, secret, { pathname: '/entry-b', ip: '10.0.0.1', ua: UA, ts: TUE + 2 * 3600_000 });

  const r = entryExitPages(db, TUE, TUE + 4 * 3600_000, 10);
  const totalEntries = r.entries.reduce((a, b) => a + b.visits, 0);
  const totalExits = r.exits.reduce((a, b) => a + b.visits, 0);
  assert.equal(totalEntries, 2, 'exactly one entry per visit (2 visits)');
  assert.equal(totalExits, 2, 'exactly one exit per visit (2 visits)');

  const entryA = r.entries.find((e) => e.path === '/entry-a');
  assert.ok(entryA?.visits === 1, 'visit A entry is /entry-a exactly once');
  assert.ok(!r.entries.some((e) => e.path === '/mid'), '/mid is not an entry');
  assert.ok(!r.entries.some((e) => e.path === '/exit-a'), 'exit-a is not an entry');
  const exitA = r.exits.find((e) => e.path === '/exit-a');
  assert.ok(exitA?.visits === 1, 'visit A exit is /exit-a exactly once');
  const exitB = r.exits.find((e) => e.path === '/entry-b');
  assert.ok(exitB?.visits === 1, 'single-page visit B is its own entry and exit');
  db.close();
});

test('refreshEntryExit keeps a long visit stable and reports 1 entry/1 exit', () => {
  const { db, secret } = fresh();
  post(db, secret, { pathname: '/home', ip: '10.0.0.2', ua: UA, ts: TUE });
  post(db, secret, { pathname: '/pricing', ip: '10.0.0.2', ua: UA, ts: TUE + MIN });
  post(db, secret, { pathname: '/blog', ip: '10.0.0.2', ua: UA, ts: TUE + 2 * MIN });
  refreshEntryExit(db, TUE);

  const r = entryExitPages(db, TUE, TUE + 4 * 3600_000, 10);
  assert.equal(r.entries.reduce((a, b) => a + b.visits, 0), 1);
  assert.equal(r.exits.reduce((a, b) => a + b.visits, 0), 1);
  assert.equal(r.entries[0].path, '/home');
  assert.equal(r.exits[0].path, '/blog');
  db.close();
});

test('filtered entry/exit: pages filter the visit, entry/exit remain the visit edges', () => {
  const { db, secret } = fresh();
  // One visit: /start -> /featured -> /end
  post(db, secret, { pathname: '/start', ip: '10.0.0.3', ua: UA, ts: TUE });
  post(db, secret, { pathname: '/featured', ip: '10.0.0.3', ua: UA, ts: TUE + MIN });
  post(db, secret, { pathname: '/end', ip: '10.0.0.3', ua: UA, ts: TUE + 2 * MIN });
  post(db, secret, { pathname: '/other-start', ip: '10.0.0.4', ua: UA, ts: TUE + 3600_000 });
  refreshEntryExit(db, TUE);

  const span = [TUE, TUE + 2 * 3600_000];
  const fq = { sql: 'path = ?', args: ['/featured'] };
  const r = entryExitFiltered(db, span[0], span[1], 10, fq);
  assert.deepEqual(
    r.entries.map((e) => [e.path, e.visits]),
    [['/start', 1]],
    'visit touching /featured reports its true entry /start',
  );
  assert.deepEqual(
    r.exits.map((e) => [e.path, e.visits]),
    [['/end', 1]],
    'visit touching /featured reports its true exit /end',
  );
  db.close();
});

test('entry/exit pair every edge with distinct uniques (same guest twice = 2 visits, 1 unique)', () => {
  const { db, secret } = fresh();
  // Guest X enters /landing twice (two separate visits).
  post(db, secret, { pathname: '/landing', ip: '10.0.0.6', ua: UA, ts: TUE });
  post(db, secret, { pathname: '/landing', ip: '10.0.0.6', ua: UA, ts: TUE + 2 * 3600_000 });
  // Guest Y enters /landing once.
  post(db, secret, { pathname: '/landing', ip: '10.0.0.7', ua: UA, ts: TUE + 45 * MIN });

  const r = entryExitPages(db, TUE, TUE + 4 * 3600_000, 10);
  const landing = r.entries.find((e) => e.path === '/landing');
  assert.equal(landing?.visits, 3, 'three visits entered /landing');
  assert.equal(landing?.uniques, 2, 'two distinct guests are behind those visits');
  assert.ok(r.entries.every((e) => e.uniques != null), 'every entry row carries uniques');
  assert.ok(r.exits.every((e) => e.uniques != null), 'every exit row carries uniques');
  db.close();
});

test('filtered entry/exit pair visits with distinct uniques within the scope', () => {
  const { db, secret } = fresh();
  // Two visits from two guests both touch /featured.
  post(db, secret, { pathname: '/a', ip: '10.0.0.8', ua: UA, ts: TUE });
  post(db, secret, { pathname: '/featured', ip: '10.0.0.8', ua: UA, ts: TUE + MIN });
  post(db, secret, { pathname: '/featured', ip: '10.0.0.9', ua: UA, ts: TUE + 60 * MIN });
  post(db, secret, { pathname: '/featured', ip: '10.0.0.9', ua: UA, ts: TUE + 61 * MIN });

  const span = [TUE, TUE + 2 * 3600_000];
  const fq = { sql: 'path = ?', args: ['/featured'] };
  const r = entryExitFiltered(db, span[0], span[1], 10, fq);
  const entryA = r.entries.find((e) => e.path === '/a');
  const entryF = r.entries.find((e) => e.path === '/featured');
  const exitF = r.exits.find((e) => e.path === '/featured');
  assert.equal(entryA?.uniques, 1, 'single guest entered via /a');
  assert.equal(entryF?.uniques ?? 0, 1, 'single guest is behind the /featured entries');
  assert.equal(exitF?.visits, 2, 'two visits exited on /featured');
  assert.equal(exitF?.uniques, 2, 'distinct guests across those two exit visits');
  db.close();
});

test('legacy events without visit_key get backfilled and still count correctly', () => {
  const { db, secret } = fresh();
  // Simulate rows written before visit_key existed: insert directly with NULL visit_key.
  const mk = (pathname, ip, ts) => {
    const ev = normalizeEvent({ path: pathname }, { ip, ua: UA }, secret);
    ev.ts = ts;
    ev.visited_at = new Date(ts).toISOString();
    return ev;
  };
  const e1 = mk('/old/1', '10.0.0.5', TUE);
  const e2 = mk('/old/2', '10.0.0.5', TUE + MIN);
  const e3 = mk('/old/3', '10.0.0.5', TUE + 2 * MIN);
  const stmt = db.prepare(
    `INSERT INTO events
      (ts, visited_at, guest_key, ip, ua, path, referrer, ref_domain,
       title, screen_w, screen_h, lang, country, browser, browser_version,
       device, os, is_bot, visit_key, entry_path, exit_path)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const bind = (v) => (v === undefined ? null : v);
  for (const e of [e1, e2, e3]) {
    stmt.run(
      e.ts, e.visited_at, e.guest_key, bind(e.ip), e.ua, e.path, bind(e.referrer), bind(e.ref_domain),
      bind(e.title), bind(e.screen_w), bind(e.screen_h), bind(e.lang), bind(e.country), e.browser, bind(e.browser_version),
      e.device, e.os, e.is_bot, null, e.path, e.path,
    );
  }
  // Backfill happens on refresh.
  refreshEntryExit(db, TUE);
  const r = entryExitPages(db, TUE, TUE + 4 * 3600_000, 10);
  assert.equal(r.entries.reduce((a, b) => a + b.visits, 0), 1);
  assert.equal(r.exits.reduce((a, b) => a + b.visits, 0), 1);
  assert.equal(r.entries[0].path, '/old/1');
  assert.equal(r.exits[0].path, '/old/3');
  db.close();
});
