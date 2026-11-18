// config.js reads every tunable from process.env at import time and applies
// two coercions — bool() (1/true/yes/on vs 0/false/no/off, anything else
// falls back) and int() (parseInt with a fallback) — plus path resolution
// rules for the DB under WA_DATA_DIR vs WA_DB_PATH. acceptance.test.js picks
// up the defaults implicitly (it runs the real server), but none of the
// branches — explicit overrides, invalid values, float truncation, the
// path-precedence matrix — were ever pinned. These tests import config.js
// fresh with a controlled env for each scenario: the module snapshots env at
// import time, so a distinct query string busts Node's module cache and every
// WA_* variable is reset first so no cross-test pollution leaks in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const WA_VARS = [
  'WA_HOST', 'WA_PORT', 'WA_DATA_DIR', 'WA_DB_PATH', 'WA_VISIT_WINDOW_MS',
  'WA_HASH_SALT', 'WA_STORE_IP', 'WA_REALTIME_WINDOW_MS',
  'WA_HOUR_OFFSET_MIN', 'WA_COLLECT_RATE_LIMIT', 'WA_COLLECT_RATE_WINDOW_MS',
  'WA_RETENTION_DAYS',
  'WA_SNIPPET_PATH', 'WA_COLLECT_PATH', 'WA_OVERVIEW_PATH',
  'WA_REALTIME_PATH', 'WA_EXPORT_PATH', 'WA_AUDIT_PATH', 'WA_PUBLIC_DIR',
];

// Import config.js in a pristine env, apply `patch`, and return the fresh
// module namespace (config + ensureDataDir share the same env snapshot).
let seq = 0;
async function loadConfig(patch) {
  for (const name of WA_VARS) delete process.env[name];
  for (const [name, value] of Object.entries(patch)) process.env[name] = value;
  seq += 1;
  return import(`../src/config.js?scenario=${seq}`);
}

test('defaults: every tunable has a documented value and paths resolve under the repo root', async () => {
  const { config: c } = await loadConfig({});
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.port, 8787);
  assert.equal(c.visitWindowMs, 1_000 * 60 * 30);
  assert.equal(c.hashSalt, 'wa-local-salt');
  assert.equal(c.storeIp, false);
  assert.equal(c.realtimeWindowMs, 1_000 * 60 * 5);
  assert.equal(c.hourOffsetMin, 0);
  assert.equal(c.collectRateLimit, 60);
  assert.equal(c.collectRateWindowMs, 60_000);
  assert.equal(c.retentionDays, 0);
  assert.equal(c.snippetPath, '/wa.js');
  assert.equal(c.publicDir, path.join(ROOT, 'public'));
  assert.equal(c.dataDir, path.join(ROOT, 'data'));
  assert.equal(c.dbPath, path.join(ROOT, 'data', 'analytics.sqlite'));
});

test('explicit env: numbers parse, true-ish flags flip, custom host/paths apply', async () => {
  const { config: c } = await loadConfig({
    WA_HOST: '0.0.0.0',
    WA_PORT: '9000',
    WA_STORE_IP: '1',
    WA_RETENTION_DAYS: '30',
    WA_COLLECT_RATE_LIMIT: '0',
    WA_SNIPPET_PATH: '/t.js',
  });
  assert.equal(c.host, '0.0.0.0');
  assert.equal(c.port, 9000);
  assert.equal(c.storeIp, true);
  assert.equal(c.retentionDays, 30);
  assert.equal(c.collectRateLimit, 0, '0 is a valid limit, retained not fallen back');
  assert.equal(c.snippetPath, '/t.js');
});

test('bool(): every true and false spelling is honored, anything else falls back', async () => {
  for (const value of ['1', 'true', 'TRUE', 'yes', 'on', ' On ']) {
    const { config: c } = await loadConfig({ WA_STORE_IP: value });
    assert.equal(c.storeIp, true, `WA_STORE_IP=${JSON.stringify(value)} is true`);
  }
  for (const value of ['0', 'false', 'FALSE', 'no', 'off']) {
    const { config: c } = await loadConfig({ WA_STORE_IP: value });
    assert.equal(c.storeIp, false, `WA_STORE_IP=${JSON.stringify(value)} is false`);
  }
  const { config: c } = await loadConfig({ WA_STORE_IP: 'nope' });
  assert.equal(c.storeIp, false, 'unrecognized value falls back to the default (false)');
});

test('int(): non-numeric input falls back to the default, floats truncate at the decimal point', async () => {
  const { config: badPort } = await loadConfig({ WA_PORT: 'abc' });
  assert.equal(badPort.port, 8787, 'non-numeric port falls back');
  const { config: floatPort } = await loadConfig({ WA_PORT: '12.9' });
  assert.equal(floatPort.port, 12, 'parseInt truncates the fractional part');
  const { config: floatWindow } = await loadConfig({ WA_VISIT_WINDOW_MS: '30.7' });
  assert.equal(floatWindow.visitWindowMs, 30, 'visit window truncates too');
  const { config: negRetention } = await loadConfig({ WA_RETENTION_DAYS: '-5' });
  assert.equal(negRetention.retentionDays, 0, 'negative ints are misconfiguration and fall back to the default');
});

test('int(): negative windows are rejected so time-window math cannot invert', async () => {
  // A negative WA_REALTIME_WINDOW_MS makes realtime() compute
  // start = now - window = now + |window| — a future-bounded interval that is
  // always empty (silent dead dashboard). A negative WA_VISIT_WINDOW_MS makes
  // insertEvent treat every pageview as a new visit (the gap > window test is
  // always true). Both are wrong-data defects; the coercion must refuse them.
  const { config: negLive } = await loadConfig({ WA_REALTIME_WINDOW_MS: '-1' });
  assert.equal(negLive.realtimeWindowMs, 1_000 * 60 * 5, 'negative realtime window falls back to the 5m default');
  const { config: negVisit } = await loadConfig({ WA_VISIT_WINDOW_MS: '-3600000' });
  assert.equal(negVisit.visitWindowMs, 1_000 * 60 * 30, 'negative visit window falls back to the 30m default');
  const { config: negRate } = await loadConfig({ WA_COLLECT_RATE_WINDOW_MS: '-60000' });
  assert.equal(negRate.collectRateWindowMs, 60_000, 'negative rate window falls back to 60s');
  const { config: negPort } = await loadConfig({ WA_PORT: '-8787' });
  assert.equal(negPort.port, 8787, 'a negative port falls back to 8787 rather than binding port -8787');
  // -0 parses to -0, which is just as degenerate as any other negative.
  const { config: negZero } = await loadConfig({ WA_REALTIME_WINDOW_MS: '-0' });
  assert.equal(negZero.realtimeWindowMs, 1_000 * 60 * 5, '-0 is rejected too');
  // Sanity: legitimate non-negative overrides still parse.
  const { config: ok } = await loadConfig({ WA_VISIT_WINDOW_MS: '0', WA_RETENTION_DAYS: '0' });
  assert.equal(ok.visitWindowMs, 0, '0 remains a valid explicitly-configured value');
  assert.equal(ok.retentionDays, 0, '0 disabled-prune remains 0');
});

test('signedInt(): UTC offset accepts negatives (west zones) but not garbage', async () => {
  // The hour-of-day axis offset is the one tunable where a negative value is
  // meaningful — zones west of UTC. Garbage still falls back to 0.
  const { config: east } = await loadConfig({ WA_HOUR_OFFSET_MIN: '480' });
  assert.equal(east.hourOffsetMin, 480, 'UTC+8 parses to +480 minutes');
  const { config: west } = await loadConfig({ WA_HOUR_OFFSET_MIN: '-300' });
  assert.equal(west.hourOffsetMin, -300, 'US Eastern (UTC-5) parses to -300 minutes');
  const { config: half } = await loadConfig({ WA_HOUR_OFFSET_MIN: '330' });
  assert.equal(half.hourOffsetMin, 330, 'non-hour offsets like UTC+5:30 parse too');
  const { config: junk } = await loadConfig({ WA_HOUR_OFFSET_MIN: 'abc' });
  assert.equal(junk.hourOffsetMin, 0, 'non-numeric offset falls back to the 0/UTC default');
});

test('dbPath resolution: WA_DB_PATH wins outright, WA_DATA_DIR derives the sibling path', async () => {
  const { config: viaDataDir } = await loadConfig({ WA_DATA_DIR: '/tmp/wa-data-a' });
  assert.equal(viaDataDir.dataDir, '/tmp/wa-data-a');
  assert.equal(viaDataDir.dbPath, '/tmp/wa-data-a/analytics.sqlite');

  const { config: viaDbPath } = await loadConfig({ WA_DB_PATH: '/var/lib/an.sqlite' });
  assert.equal(viaDbPath.dbPath, '/var/lib/an.sqlite');

  const { config: both } = await loadConfig({ WA_DATA_DIR: '/tmp/wa-data-b', WA_DB_PATH: '/override/x.sqlite' });
  assert.equal(both.dbPath, '/override/x.sqlite', 'WA_DB_PATH takes precedence over WA_DATA_DIR');
  assert.equal(both.dataDir, '/tmp/wa-data-b', 'dataDir still honors WA_DATA_DIR');
});

test('ensureDataDir creates the configured data directory recursively', async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cfg-')), 'nested', 'data');
  try {
    const { config, ensureDataDir } = await loadConfig({ WA_DATA_DIR: dir });
    assert.equal(config.dataDir, dir, 'env patched before this instance imported');
    ensureDataDir();
    assert.ok(fs.statSync(dir).isDirectory(), 'nested data dir exists after ensureDataDir');
    ensureDataDir(); // idempotent, no throw
  } finally {
    fs.rmSync(path.dirname(path.dirname(dir)), { recursive: true, force: true });
  }
});
