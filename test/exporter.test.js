// Exporter contracts: raw events leave the box redacted (never the cleartext
// IP, even when WA_STORE_IP would have stored it), bot traffic never
// appears, filters narrow the rows, and the CSV forms keep stable headers.
// The summary export mirrors the dashboard and serializes every section;
// its empty-list CSV branch is pinned as well. acceptance.test.js exercised
// these only over HTTP with normal data; here exportEvents/exportSummary are
// called directly, including the WA_STORE_IP=1-shaped DB both postures would
// produce.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/store.js';
import { exportEvents, exportSummary } from '../src/exporter.js';

const T = Date.UTC(2026, 10, 10, 9, 0); // 2026-11-10 09:00 UTC
const SPAN = 3600_000;

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-exp-'));
  const db = openDb(path.join(dir, 'test.sqlite'));
  return { db, dir };
}

test('exportEvents redacts cleartext IPs and nulls absent ones', () => {
  const { db, dir } = fresh();
  try {
    const ins = db.prepare(
      'INSERT INTO events (ts, visited_at, guest_key, ip, ua, path, is_bot) VALUES (?,?,?,?,?,?,?)',
    );
    ins.run(T, new Date(T).toISOString(), 'g1', '203.0.113.9', 'Test/1.0', '/a', 0);
    ins.run(T + 2000, new Date(T + 2000).toISOString(), 'g2', null, 'Test/1.0', '/c', 0);

    const rows = exportEvents(db, T, T + SPAN, 'json');
    assert.equal(rows.length, 2, 'both non-bot events exported');
    const r1 = rows[0];
    assert.equal(r1.ip, '203.0.113.x', 'IPv4 last octet masked on export');
    assert.ok(!r1.ip.includes('203.0.113.9'), 'cleartext IP never leaves the box');
    assert.equal(rows[1].ip, null, 'NULL ip stays NULL (acceptance sees the same)');
    assert.equal(r1.visitsSerial, 1, 'visitsSerial exported as a Number');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('exportEvents masks IPv6 addresses on export', () => {
  const { db, dir } = fresh();
  try {
    db.prepare(
      'INSERT INTO events (ts, visited_at, guest_key, ip, ua, path, is_bot) VALUES (?,?,?,?,?,?,?)',
    ).run(T, new Date(T).toISOString(), 'g3', '2001:db8:85a3:0:0:8a2e:370:7334', 'Test/1.0', '/v6', 0);
    const rows = exportEvents(db, T, T + SPAN, 'json');
    assert.equal(rows[0].ip, '2001:db8:85a3:xxxx:xxxx:xxxx:xxxx');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('exportEvents drops bot traffic and honors the path filter', () => {
  const { db, dir } = fresh();
  try {
    const ins = db.prepare(
      'INSERT INTO events (ts, visited_at, guest_key, ip, ua, path, is_bot) VALUES (?,?,?,?,?,?,?)',
    );
    ins.run(T, new Date(T).toISOString(), 'g1', '203.0.113.9', 'Test/1.0', '/a', 0);
    ins.run(T + 1000, new Date(T + 1000).toISOString(), 'g2', '2001:db8::1', 'Bot/1.0', '/b', 1);
    ins.run(T + 2000, new Date(T + 2000).toISOString(), 'g1', null, 'Test/1.0', '/c', 0);

    const all = exportEvents(db, T, T + SPAN, 'json');
    assert.deepEqual(
      all.map((r) => r.path),
      ['/a', '/c'],
      'bot event excluded, human events kept in ts order',
    );

    const filtered = exportEvents(db, T, T + SPAN, 'json', { sql: 'path = ?', args: ['/a'] });
    assert.deepEqual(
      filtered.map((r) => r.path),
      ['/a'],
      'path filter narrows the export',
    );
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('exportEvents CSV carries a stable header and equals the JSON contract', () => {
  const { db, dir } = fresh();
  try {
    db.prepare(
      'INSERT INTO events (ts, visited_at, guest_key, ip, ua, path, is_bot) VALUES (?,?,?,?,?,?,?)',
    ).run(T, new Date(T).toISOString(), 'g1', '203.0.113.9', 'Test/1.0', '/a', 0);

    const csv = exportEvents(db, T, T + SPAN, 'csv');
    const lines = csv.trim().split('\n');
    assert.equal(
      lines[0],
      'visited_at,guest_key,visit_key,ip,path,entry_path,exit_path,referrer,ref_domain,title,screen_w,screen_h,lang,country,browser,browser_version,device,device_model,os,ua',
      'CSV header covers every export column (no visitsSerial)',
    );
    assert.equal(lines.length, 2, 'one header + one row');
    assert.ok(lines[1].includes('203.0.113.x'), 'row IP is masked, same as JSON');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('exportSummary JSON carries every dashboard section, empty DB included', () => {
  const { db, dir } = fresh();
  try {
    const summary = exportSummary(db, T, T + SPAN, 'json');
    for (const key of [
      'totals', 'visit_stats', 'daily', 'weekly', 'monthly', 'pages', 'sources',
      'devices', 'models', 'browsers', 'countries', 'oses', 'languages', 'screens',
      'titles', 'referrers', 'hourly', 'returning', 'entries', 'exits',
    ]) {
      assert.ok(key in summary, `summary carries ${key}`);
    }
    assert.equal(summary.totalPages ?? summary.totals?.visits, 0, 'empty DB totals are zero');
    assert.equal(summary.hourly.length, 24, 'hourly axis is zero-filled');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('exportSummary CSV serializes every section and empty top lists fall back to a value header', () => {
  const { db, dir } = fresh();
  try {
    const csv = exportSummary(db, T, T + SPAN, 'csv');
    for (const section of [
      'totals', 'visit_stats', 'daily', 'weekly', 'monthly', 'pages', 'sources',
      'devices', 'models', 'browsers', 'countries', 'oses', 'languages', 'screens',
      'titles', 'referrers', 'hourly', 'returning', 'entries', 'exits',
    ]) {
      assert.ok(csv.includes(`# ${section}`), `CSV has a ${section} section`);
    }
    assert.match(csv, /# pages\n\nvalue\n/, 'empty top list section renders the value fallback header');
    const totalsBlock = csv.split('# totals')[1].split('# visit_stats')[0].trim();
    assert.equal(totalsBlock, 'visits,uniques\n0,0');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('exportSummary honors the filter argument across sections', () => {
  const { db, dir } = fresh();
  try {
    const ins = db.prepare(
      'INSERT INTO events (ts, visited_at, guest_key, ip, ua, path, is_bot) VALUES (?,?,?,?,?,?,?)',
    );
    ins.run(T, new Date(T).toISOString(), 'g1', '203.0.113.9', 'Test/1.0', '/free', 0);
    ins.run(T + 1000, new Date(T + 1000).toISOString(), 'g2', '203.0.113.10', 'Test/1.0', '/paid', 0);

    const fq = { sql: 'path = ?', args: ['/paid'] };
    const summary = exportSummary(db, T, T + SPAN, 'json', fq);
    assert.equal(summary.totals.visits, 1, 'totals respect the filter');
    assert.deepEqual(
      summary.pages.map((p) => p.path),
      ['/paid'],
      'filtered top pages only show the matching path',
    );
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
