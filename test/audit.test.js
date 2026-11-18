// audit.js report contracts: generateAudit() assembling the full privacy
// report against a live database, and the three internal evidence scanners
// (cookie / outbound / region) whose pass/fail wiring carries the product's
// compliance claims. snippet-audit.test.js already pins the three factored-out
// pure gates; this suite pins everything around them: the clean-posture report
// shape (7 checks all pass, pass_count/warn_count arithmetic, data_flow, schema
// round-trip, stats over the live table, config echo), and every branch where
// the report must contradict the config flag based on live data — legacy ip
// rows under WA_STORE_IP=0, a personal-named column, WA_STORE_IP=1 warning, and
// events older than WA_RETENTION_DAYS. env-based branches flip the imported
// config object between calls (each test file runs in its own process, and
// generateAudit reads config at call time), mirroring collector.test.js.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/store.js';
import { config } from '../src/config.js';
import { SCHEMA } from '../src/schema.js';
import { generateAudit } from '../src/audit.js';

// 2026-11-10 09:00 UTC is a Tuesday.
const T = Date.UTC(2026, 10, 10, 9, 0);
const MIN = 60_000;
const DAY = 24 * 3600 * 1000;
const LAST_PRUNE = '2026-11-10T00:00:00.000Z';

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-aud-'));
  const db = openDb(path.join(dir, 'test.sqlite'));
  const stmt = db.prepare(
    `INSERT INTO events (ts, visited_at, guest_key, ua, path, is_bot, ip)
     VALUES (?,?,?,?,?,?,?)`,
  );
  const insert = (row) => {
    stmt.run(
      row.ts, new Date(row.ts).toISOString(), row.guest_key, 'Audit-UA/1.0',
      row.path ?? '/', row.is_bot ?? 0, row.ip ?? null,
    );
  };
  return { db, insert };
}

// Flipping config fields read by generateAudit at call time (storeIp,
// retentionDays); the env snapshot is irrelevant since the module is already
// imported. Restored in a finally so the file's other tests see defaults.
function withCfg(patch, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(patch)) {
    prev[k] = config[k];
    config[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) config[k] = v;
  }
}

test('generateAudit on a fresh DB emits the full clean-posture report', () => {
  const { db } = fresh();
  const report = generateAudit(db);
  db.close();

  assert.equal(report.service, '15-web-analytics');
  assert.match(report.generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'ISO timestamp');

  assert.equal(report.data_flow.length, 5);
  assert.deepEqual(report.data_flow.map((s) => s.step), [1, 2, 3, 4, 5]);
  assert.ok(report.data_flow.every((s) => s.actor && s.action));

  assert.equal(report.schema, SCHEMA, 'the schema block is the shipped SCHEMA constant');
  assert.deepEqual(
    report.tables.map((t) => t.name),
    ['agg_daily_realtime', 'agg_monthly_buckets', 'events', 'meta'],
    'app tables only, sorted by name, no sqlite_* bookkeeping',
  );

  assert.equal(report.stats.events, 0);
  assert.equal(report.stats.real_events, 0);
  assert.equal(report.stats.guests, 0);
  assert.equal(report.stats.first_ts, null);
  assert.equal(report.stats.last_ts, null);
  assert.ok(report.stats.bytes > 0, 'dbstat reports real bytes on a fresh DB');
  assert.equal(report.stats.bytes_readable, '56.0 KB', 'fmtBytes renders the dbstat total');
  assert.equal(report.stats.ip_rows, 0);
  assert.equal(report.stats.db_path, config.dbPath);

  assert.deepEqual(report.config, {
    visit_window_ms: 1_000 * 60 * 30,
    realtime_window_ms: 1_000 * 60 * 5,
    store_ip: false,
    hash_salt_set: false,
    retention_days: 0,
    last_prune: null,
  });

  assert.equal(report.checks.length, 7);
  assert.deepEqual(report.checks.map((c) => c.id), [
    'no_cookies', 'no_personal_fields', 'ip_not_stored', 'snippet_size',
    'region_only', 'local_storage', 'data_retention',
  ]);
  assert.ok(report.checks.every((c) => c.status === 'pass'), 'clean repo: every check passes');
  assert.equal(report.pass_count, 7);
  assert.equal(report.warn_count, 0);
});

test('clean report: scanner details cite the scanned populations', () => {
  const { db } = fresh();
  const report = generateAudit(db);
  const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
  db.close();

  assert.match(byId.no_cookies.detail, /No Set-Cookie writes in the server source/);
  assert.match(byId.no_cookies.detail, /scanned 2 files, \d+ lines/, 'server.js + wa.js only');
  assert.match(byId.no_personal_fields.detail, /4 tables, 34 columns/, 'live schema counts');
  assert.match(byId.no_personal_fields.detail, /no name, email, phone, or other personal identifier/);
  assert.match(byId.region_only.detail, /scanned 12 files, \d+ lines/, 'every src module but audit.js');
  assert.match(byId.region_only.detail, /optional x-country HTTP header/);
  assert.match(byId.local_storage.detail, /scanned 12 files, \d+ lines/);
  assert.match(byId.local_storage.detail, /No outbound transmission primitives/);
  assert.match(byId.ip_not_stored.detail, /0 of 0 events carry a cleartext IP/);
  assert.match(byId.snippet_size.detail, /within the ~1KB budget/);
});

test('stats reflect inserted events: bots excluded from real_events, guests distinct', () => {
  const { db, insert } = fresh();
  insert({ guest_key: 'g1', ts: T, path: '/a' });
  insert({ guest_key: 'g1', ts: T + MIN, path: '/b' });
  insert({ guest_key: 'g2', ts: T + 2 * MIN, path: '/c', is_bot: 1 });

  const report = generateAudit(db);
  db.close();
  assert.equal(report.stats.events, 3, 'raw count includes the bot');
  assert.equal(report.stats.real_events, 2, 'real_events excludes the bot');
  assert.equal(report.stats.guests, 2, 'distinct guest keys, bot or not');
  assert.equal(report.stats.first_ts, new Date(T).toISOString(), 'ISO round-trip');
  assert.equal(report.stats.last_ts, new Date(T + 2 * MIN).toISOString());
});

test('ip_not_stored warns under WA_STORE_IP=1 and cites live rows', () => {
  const { db, insert } = fresh();
  insert({ guest_key: 'g1', ts: T, path: '/a', ip: '203.0.113.9' });
  insert({ guest_key: 'g1', ts: T + MIN, path: '/b' });
  insert({ guest_key: 'g2', ts: T + 2 * MIN, path: '/c', ip: '2001:db8::1' });
  insert({ guest_key: 'g3', ts: T + 3 * MIN, path: '/d', path2: '/d', is_bot: 1 });

  const report = withCfg({ storeIp: true }, () => generateAudit(db));
  db.close();
  const check = report.checks.find((c) => c.id === 'ip_not_stored');
  assert.equal(check.status, 'warn');
  assert.match(check.detail, /2 of 4 events carry one/, 'live ip row count cited');
  assert.equal(report.warn_count, 1);
  assert.equal(report.pass_count, 6);
  assert.equal(report.config.store_ip, true);
});

test('ip_not_stored fails on legacy cleartext rows under WA_STORE_IP=0', () => {
  const { db, insert } = fresh();
  insert({ guest_key: 'g1', ts: T, path: '/a', ip: '203.0.113.9' });
  insert({ guest_key: 'g2', ts: T + MIN, path: '/b' });

  const report = generateAudit(db);
  db.close();
  const check = report.checks.find((c) => c.id === 'ip_not_stored');
  assert.equal(check.status, 'fail');
  assert.match(check.detail, /1 of 2 events still carry a cleartext IP row under WA_STORE_IP=0/);
  assert.equal(report.pass_count, 6, 'the no-storage claim is contradicted by live data');
});

test('no_personal_fields fails when a personal-named column exists', () => {
  const { db } = fresh();
  db.exec('ALTER TABLE events ADD COLUMN email TEXT');

  const report = generateAudit(db);
  db.close();
  const check = report.checks.find((c) => c.id === 'no_personal_fields');
  assert.equal(check.status, 'fail');
  assert.match(check.detail, /personal identifiers: email/);
  assert.equal(report.pass_count, 6);
});

test('data_retention fails when events predate the configured window', () => {
  const { db, insert } = fresh();
  insert({ guest_key: 'g1', ts: Date.now() - 40 * DAY, path: '/old' });
  insert({ guest_key: 'g2', ts: Date.now() - DAY, path: '/new' });

  const report = withCfg({ retentionDays: 30 }, () => generateAudit(db));
  db.close();
  const check = report.checks.find((c) => c.id === 'data_retention');
  assert.equal(check.status, 'fail');
  assert.match(check.detail, /1 of 2 events predate the 30-day retention window/);
  assert.match(check.detail, /no automated prune has ever run/, 'meta has no last_prune yet');
  assert.equal(report.config.retention_days, 30);
  assert.equal(report.pass_count, 6);
});

test('data_retention passes with fresh events and surfaces meta.last_prune', () => {
  const { db, insert } = fresh();
  insert({ guest_key: 'g1', ts: Date.now() - DAY, path: '/new' });
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('last_prune', LAST_PRUNE);

  const report = withCfg({ retentionDays: 30 }, () => generateAudit(db));
  db.close();
  const check = report.checks.find((c) => c.id === 'data_retention');
  assert.equal(check.status, 'pass');
  assert.match(check.detail, /oldest retained event \(.*\) is inside the 30-day window/);
  assert.match(check.detail, /last automated prune: 2026-11-10/);
  assert.equal(report.config.last_prune, LAST_PRUNE, 'last_prune echoed verbatim');
});

test('read failures: an excluded snippet still yields a full 7-check report', () => {
  // snippetBytes() (audit.js 16-22) returns null for a snippet the operator's
  // deployment does not ship, and cookieEvidence()'s catch (159-161) drops the
  // snippet target from its scanned set when readFileSync throws. Both reads go
  // through config.publicDir: point it at an empty directory so wa.js is
  // genuinely absent, then verify the report flips snippet_size to fail, still
  // cites the server source (scanned 1 file), and assembles all 7 checks.
  const { db } = fresh();
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-nosnip-'));
  try {
    const report = withCfg({ publicDir: emptyDir }, () => generateAudit(db));
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    assert.equal(byId.snippet_size.status, 'fail', 'snippet_size fails — status flips');
    assert.match(byId.snippet_size.detail, /could not be measured — the file is missing/);
    assert.match(byId.no_cookies.detail, /No Set-Cookie writes in the server source/);
    assert.match(byId.no_cookies.detail, /scanned 1 file/, 'the snippet target is excluded from the scanned set');
    assert.equal(report.checks.length, 7, 'the missing snippet must not collapse the report');
    assert.equal(byId.region_only.status, 'pass', 'server-side scanners are unaffected');
    assert.equal(byId.local_storage.status, 'pass');
    assert.equal(report.pass_count, 6, 'only snippet_size fails');
    assert.equal(report.warn_count, 0);
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
  db.close();
});

test('read failures: a public dir that is a file yields "could not be measured", not a panic', () => {
  // snippetBytes() (audit.js 18-25) resolves null for a WA_PUBLIC_DIR that
  // points at a regular file: existsSync swallows the ENOTDIR from probing
  // `<file>/wa.js` (Node's existsSync converts lstat errors into a false
  // result) and the ternary short-circuits, so the size gate reports "could
  // not be measured" instead of panicking. The statSync-throw path through the
  // catch itself is pinned separately below — no real file state can both pass
  // existsSync and then throw, so that branch is reached only by mocking.
  const { db } = fresh();
  const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-nosnipacc-'));
  const fileDir = path.join(parentDir, 'public');
  fs.writeFileSync(fileDir, 'not a directory');
  try {
    const report = withCfg({ publicDir: fileDir }, () => generateAudit(db));
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    assert.equal(byId.snippet_size.status, 'fail', 'unmeasurable snippet still fails the gate');
    assert.match(byId.snippet_size.detail, /could not be measured/, 'fallback names the unmeasurable state');
    assert.equal(report.checks.length, 7, 'the bad public dir must not collapse the report');
    assert.equal(report.pass_count, 6, 'only snippet_size fails');
    assert.equal(report.warn_count, 0);
  } finally {
    fs.rmSync(parentDir, { recursive: true, force: true });
  }
  db.close();
});

test('read failures: a statSync throw between existsSync and size resolves "could not be measured"', () => {
  // snippetBytes() (audit.js 18-25) guards the stat with a catch, but no real
  // file state can exercise it: existsSync swallows every lstat error (EACCES,
  // ENOTDIR, dangling-symlink ENOENT) into a false result, so the friendly
  // `f = existsSync ? statSync : null` ternary never lets a filesystem error
  // reach the stat. The only way through the catch is an FS race — the file
  // vanishes (or its perms flip) between the existsSync probe and the stat. A
  // mocked statSync that throws reproduces that race deterministically: the
  // catch must resolve null, flip snippet_size to fail, and leave the other
  // six checks standing.
  const { db } = fresh();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-nostat-'));
  try {
    // The snippet must exist on disk (existsSync passes) so the only failure
    // point left is the stat call:
    fs.writeFileSync(path.join(dir, 'wa.js'), 'console.log(1)');
    mock.method(fs, 'statSync', () => {
      throw new Error('simulated ENOENT between probe and stat');
    });
    assert.throws(() => fs.statSync(path.join(dir, 'wa.js')), 'mock is live before the report runs');

    const report = withCfg({ publicDir: dir }, () => generateAudit(db));
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    assert.equal(byId.snippet_size.status, 'fail', 'the stat throw surfaces as a failed size gate');
    assert.match(byId.snippet_size.detail, /could not be measured/, 'the catch reports the unmeasurable state');
    assert.equal(report.checks.length, 7, 'the stat failure must not collapse the report');
    assert.equal(report.pass_count, 6, 'only snippet_size fails');
    assert.equal(report.warn_count, 0);
  } finally {
    mock.restoreAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  db.close();
});

test('read failures: an unreadable src module is excluded from both scanners', () => {
  // outboundEvidence() and regionEvidence() both guard their per-file
  // readFileSync with a catch-and-continue. Make one src module unreadable at
  // report time (a permission collision a fresh deploy could actually hit): the
  // scanner counts the surviving 11 files and the report still passes every
  // check, because the unreadable file contributed no hits to either pattern.
  //
  // The sabotage runs against a throwaway COPY of the source, injected via
  // generateAudit's opts.srcDir. Chmod'ing a live shared module (src/ua.js)
  // used to race sibling test processes, which import it in parallel and got
  // EACCES while the file sat at 0o000.
  const { db } = fresh();
  const srcDir = path.join(import.meta.dirname, '..', 'src');
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-srccopy-'));
  const work = path.join(workRoot, 'src');
  try {
    fs.cpSync(srcDir, work, { recursive: true });
    fs.chmodSync(path.join(work, 'ua.js'), 0o000);
    const report = generateAudit(db, { srcDir: work });
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    assert.match(byId.region_only.detail, /scanned 11 files/, 'region scanner excludes the unreadable module');
    assert.match(byId.local_storage.detail, /scanned 11 files/, 'outbound scanner excludes it too');
    assert.equal(byId.region_only.status, 'pass', 'no hits, so the check still passes');
    assert.equal(byId.local_storage.status, 'pass');
    assert.equal(report.checks.length, 7);
    assert.equal(report.pass_count, 7);
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
  assert.ok(fs.statSync(path.join(srcDir, 'ua.js')).mode & 0o444, 'live src/ua.js is never touched');
  db.close();
});

test('stats: a database larger than 1 MiB renders bytes_readable in MB', () => {
  const { db } = fresh();
  // A live database past 1 MiB is normal production posture; dbstat sums every
  // page allocated by the file, so one oversized ua cell crosses the 1 MiB
  // threshold without touching a single report contract. fmtBytes (audit.js)
  // branches at 1 MiB, and no report path had ever fed it a value that large.
  db.prepare(
    `INSERT INTO events (ts, visited_at, guest_key, ua, path, is_bot)
     VALUES (?,?,?,?,?,0)`,
  ).run(T, new Date(T).toISOString(), 'g-big', 'x'.repeat(1_100_000), '/big');

  const report = generateAudit(db);
  db.close();

  assert.ok(report.stats.bytes > 1024 ** 2, `dbstat crosses 1 MiB, got ${report.stats.bytes} bytes`);
  assert.equal(
    report.stats.bytes_readable,
    `${(report.stats.bytes / 1024 ** 2).toFixed(1)} MB`,
    'fmtBytes renders the MB branch',
  );
  assert.match(report.stats.bytes_readable, / MB$/, 'unit is MB, not KB');

  // The oversized row must not disturb the clean-posture report.
  const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
  assert.equal(report.checks.length, 7);
  assert.equal(report.stats.events, 1);
  assert.equal(report.stats.real_events, 1);
  assert.equal(report.stats.guests, 1);
  assert.equal(byId.no_personal_fields.status, 'pass');
  assert.equal(report.pass_count, 7);
});
