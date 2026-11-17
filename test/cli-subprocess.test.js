// CLI subprocess tests: src/cli.js main()'s command dispatch (the argv-entry
// branch behind the direct-run guard at the bottom of the file) routes the
// documented npm scripts — `seed`, `collect`, `prune`, `privacy-audit`. The
// existing coverage only reaches the parse helpers (cli.test.js) and the
// exported seed()/collectOnce() bodies (cli-handlers.test.js), never the
// dispatch itself: main() is not exported and the guard only fires when the
// file is the process entry, so the prune/audit/usage branches and the audit
// highlight() printer are covered exactly the way lifecycle.test.js covers the
// server's main-entry block — by spawning the real binary with WA_DATA_DIR
// pointed at a throwaway dir. (Node's test-runner coverage attributes
// subprocess lines to the child, not the runner, so just like server.js's
// 412-474 these stay out of the report; they are exercised black-box.)
//
// All assertions are deterministic: events are inserted with fixed ages (no
// Math.random like `seed`), and the prune tests only count rows that sit many
// days from the retention cutoff, so the subprocess's own Date.now() cannot
// skew the outcome.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb } from '../src/store.js';
import { loadOrCreateSecret } from '../src/privacy.js';
import { insertEvent, normalizeEvent } from '../src/collector.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86_400_000;

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cli-run-'));
}

// Run `src/cli.js <args...>` as a subprocess against `dir` and resolve with
// { code, out, err } once it exits (mirrors lifecycle.test.js's seeding spawn).
function runCli(dir, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', 'src/cli.js', ...args],
      { cwd: ROOT, env: { ...process.env, WA_DATA_DIR: dir, ...extraEnv } },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('exit', (code) => resolve({ code, out, err }));
    child.on('error', reject);
  });
}

// Insert one event at a controlled age into `db`. Returns the normalized event.
function post(db, secret, { pathname, ip, ua, ts }) {
  const ev = normalizeEvent({ path: pathname }, { ip, ua }, secret);
  ev.ts = ts;
  ev.visited_at = new Date(ts).toISOString();
  insertEvent(db, ev);
  return ev;
}

// A small, fixed dataset: two events older than 30d, one between 7d and 30d,
// two recent — each with a distinct ip/ua so guest/uniques follow deterministically.
function fillDb(dir) {
  const dbPath = path.join(dir, 'analytics.sqlite');
  const db = openDb(dbPath);
  const secret = loadOrCreateSecret(dir);
  const now = Date.now();
  post(db, secret, { pathname: '/oldest', ip: '10.5.0.1', ua: 'UA-O1', ts: now - 40 * DAY });
  post(db, secret, { pathname: '/mid', ip: '10.5.0.2', ua: 'UA-O2', ts: now - 15 * DAY });
  post(db, secret, { pathname: '/old-ish', ip: '10.5.0.3', ua: 'UA-O3', ts: now - 20 * DAY });
  post(db, secret, { pathname: '/recent', ip: '10.6.0.1', ua: 'UA-N1', ts: now - 1 * DAY });
  post(db, secret, { pathname: '/now', ip: '10.6.0.2', ua: 'UA-N2', ts: now });
  const keys = { '/oldest': 'UA-O1', '/mid': 'UA-O2', '/old-ish': 'UA-O3', '/recent': 'UA-N1', '/now': 'UA-N2' };
  db.close();
  return { dbPath, keys };
}

test('prune via CLI: --days overrides the window and reports the deleted count', async () => {
  const dir = tmpdir();
  try {
    const { dbPath, keys } = fillDb(dir);

    // Three events are older than 7 days (/oldest 40d, /mid 15d, /old-ish 20d).
    const r = await runCli(dir, ['prune', '--days=7']);
    assert.equal(r.code, 0, `prune failed:\n${r.err}`);
    assert.match(r.out.trim(), /^prune: deleted 3 events older than 7 days$/, 'echoes the effective window, not the config default');

    const db = openDb(dbPath);
    for (const pathname of ['/oldest', '/mid', '/old-ish']) {
      assert.equal(db.prepare('SELECT COUNT(*) n FROM events WHERE path = ?').get(pathname).n, 0, `${pathname} pruned`);
    }
    for (const pathname of ['/recent', '/now']) {
      assert.equal(db.prepare('SELECT COUNT(*) n FROM events WHERE path = ?').get(pathname).n, 1, `${pathname} survives`);
    }
    assert.ok(db.prepare(`SELECT value FROM meta WHERE key = 'last_prune'`).get(), 'the run is recorded for the audit report');
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('prune via CLI: without --days it falls back to WA_RETENTION_DAYS', async () => {
  const dir = tmpdir();
  try {
    const { dbPath } = fillDb(dir);

    // WA_RETENTION_DAYS=30 is the documented default window; only the 40d and
    // 20d... no — 20d stays inside the 30d window, so exactly /oldest goes.
    const r = await runCli(dir, ['prune'], { WA_RETENTION_DAYS: '30' });
    assert.equal(r.code, 0, `prune failed:\n${r.err}`);
    assert.match(r.out.trim(), /^prune: deleted 1 events older than 30 days$/, 'config default drives the window');

    const db = openDb(dbPath);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE path = '/oldest'").get().n, 0, '/oldest (40d) pruned');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE path = '/old-ish'").get().n, 1, '/old-ish (20d) kept inside the window');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE path = '/mid'").get().n, 1, '/mid (15d) kept');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n, 4, 'exactly 4 survivors');
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('collect via CLI: main() dispatch records a normalized event', async () => {
  const dir = tmpdir();
  try {
    const r = await runCli(dir, ['collect', '--path=/cli-run', '--sw=390', '--sh=844', '--referrer=https://example.com/?a=1']);
    assert.equal(r.code, 0, `collect failed:\n${r.err}`);
    assert.match(r.out.trim(), /^collect: id=\d+ path=\/cli-run unique=true$/, 'echoes id, path and uniqueness');

    const db = openDb(path.join(dir, 'analytics.sqlite'));
    const row = db.prepare('SELECT * FROM events WHERE path = ?').get('/cli-run');
    assert.ok(row, 'event row inserted');
    assert.equal(row.screen_w, 390, '--sw parsed');
    assert.equal(row.screen_h, 844, '--sh parsed');
    assert.equal(row.ref_domain, 'example.com', 'referrer host extracted');
    const secret = loadOrCreateSecret(dir);
    assert.equal(row.guest_key, requireGuestKey(secret), 'keyed off the default cli ip/ua and the data-dir secret');
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// hashGuest is imported indirectly (privacy.js is already loaded above); a
// tiny local reader keeps the expected value inline with the subprocess's own.
import { createHmac } from 'node:crypto';
function requireGuestKey(secret) {
  return createHmac('sha256', secret).update('127.0.0.1|cli/1.0').digest('hex');
}

test('audit via CLI: highlight() prints the plain-report deck', async () => {
  const dir = tmpdir();
  try {
    fillDb(dir); // 5 real events, 5 distinct guests, no IP rows

    const r = await runCli(dir, ['audit']);
    assert.equal(r.code, 0, `audit failed:\n${r.err}`);
    const lines = r.out.trimEnd().split('\n');
    assert.equal(lines[0], 'Privacy audit report:', 'deck opens with the report header');

    const passLines = lines.filter((l) => /^  \[PASS\] /.test(l));
    assert.equal(passLines.length, 7, 'all seven checks pass on the controlled dataset');
    assert.ok(passLines.every((l) => /^  \[PASS\] [A-Za-z].*$/.test(l)), 'each check paints status + label');

    assert.match(lines.join('\n'), /^events=5 real=5 guests=5 ip_rows=0$/m, 'stats line reports the controlled rows');
    assert.match(lines.join('\n'), /^db=.*analytics\.sqlite \([^)]+\)$/m, 'db line shows the path and human-readable size');
    assert.equal(lines.at(-1), 'Use /api/audit?format=text for the full plain-text report.', 'deck ends with the API pointer');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown subcommand prints the usage line and exits cleanly', async () => {
  const dir = tmpdir();
  try {
    const r = await runCli(dir, ['frobnicate']);
    assert.equal(r.code, 0, 'usage is not an error path');
    assert.equal(r.out, 'usage: node src/cli.js <seed|collect|prune|audit>\n', 'exactly the usage line');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
