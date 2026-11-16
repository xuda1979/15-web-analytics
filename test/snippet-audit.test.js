// The audit's snippet_size check must be a real gate: it fails when the served
// collect snippet is missing or exceeds the ~1KB budget, and passes only when a
// file within budget is actually measured. Before this check was verified at
// report time, the status was hardcoded to 'pass' while the byte count was only
// quoted in the detail. These tests exercise every branch of the gate directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { snippetSizeCheck, ipStoreCheck, retentionCheck } from '../src/audit.js';

test('snippet_size passes when the shipped snippet is within budget', () => {
  const check = snippetSizeCheck(906, path.join('public', 'wa.js'));
  assert.equal(check.status, 'pass', 'measured in-budget snippet passes');
  assert.match(check.detail, /\d+ bytes/, 'detail cites the real byte count');
  assert.match(check.detail, /906/, 'detail cites the exact size');
  assert.match(check.detail, /budget/i, 'detail ties the size to the ~1KB budget');
});

test('snippet_size fails when the served snippet exceeds the ~1KB budget', () => {
  const check = snippetSizeCheck(1025, path.join('public', 'wa.js'));
  assert.equal(check.status, 'fail', 'oversized snippet fails the gate');
  assert.match(check.detail, /1025/, 'detail cites the oversized byte count');
  assert.match(check.detail, /budget/i, 'detail explains the violated budget');
});

test('snippet_size fails when the file is missing instead of passing silently', () => {
  const check = snippetSizeCheck(null, path.join('public', 'wa.js'));
  assert.equal(check.status, 'fail', 'missing snippet fails the gate');
  assert.match(check.detail, /could not be measured/, 'detail explains the missing file');
  assert.match(check.detail, /public[\\/]wa\.js/, 'detail names the expected file');
});

// The ip_not_stored check must verify the live database, not just echo the
// config flag: under WA_STORE_IP=0 it used to claim "raw IPs are never stored"
// even when legacy cleartext rows sat in the events table. These tests cover
// every branch of the report-time gate.
test('ip_not_stored passes only when no event stores a raw IP under WA_STORE_IP=0', () => {
  const check = ipStoreCheck(false, 0, 42);
  assert.equal(check.status, 'pass', 'storeIp=0 with zero cleartext rows passes');
  assert.match(check.detail, /0 of 42 events/, 'pass cites the scanned population');
  assert.match(check.detail, /salted HMAC guest key/, 'pass explains what is stored instead');
});

test('ip_not_stored fails when legacy cleartext rows exist under WA_STORE_IP=0', () => {
  const check = ipStoreCheck(false, 3, 100);
  assert.equal(check.status, 'fail', 'leftover raw-IP rows contradict the no-storage claim');
  assert.match(check.detail, /3 of 100 events/, 'fail cites the live leftover count');
  assert.match(check.detail, /WA_STORE_IP=0/, 'fail names the config the rows contradict');
  assert.match(check.detail, /delete/, 'fail explains the remediation');
});

test('ip_not_stored warns when WA_STORE_IP=1 is enabled, citing the live row count', () => {
  const check = ipStoreCheck(true, 7, 50);
  assert.equal(check.status, 'warn', 'deliberate opt-in storage is flagged');
  assert.match(check.detail, /7 of 50 events/, 'warn cites the live row count');
  assert.match(check.detail, /Disable for a stricter posture/, 'warn explains the trade-off');
});

// The data_retention check must verify the retention posture against the live
// events table, not just echo WA_RETENTION_DAYS: with a window configured it
// used to claim "events older than N days are pruned" even when rows older
// than the cutoff sat in the table. All branches below use fixed epoch ms so
// the details can be matched exactly: nowMs = 2026-11-16T00:00:00Z, a 30-day
// window cuts off at 2026-10-17, an event 40 days back (2026-10-07) is old,
// one at 2026-11-15 is inside the window.
const NOW = 1794787200000;
const INSIDE = 1794614400000; // 2026-11-14T00:00:00Z, inside a 30-day window
const OLD = 1791331200000; // 2026-10-07T00:00:00Z, 40 days before NOW
const PRUNED_AT = '2026-11-10T00:00:00.000Z';

test('data_retention passes when every event is inside the configured window', () => {
  const check = retentionCheck(30, PRUNED_AT, INSIDE, NOW, 0, 100);
  assert.equal(check.status, 'pass', 'in-window history passes the gate');
  assert.match(check.detail, /30-day window/, 'pass cites the configured window');
  assert.match(check.detail, /2026-11-14/, 'pass cites the oldest retained event');
  assert.match(check.detail, /2026-10-17/, 'pass cites the effective cutoff');
  assert.match(check.detail, /last automated prune: 2026-11-10/, 'pass cites the last prune run');
});

test('data_retention fails when events predate the window and were never pruned', () => {
  const check = retentionCheck(30, null, OLD, NOW, 2, 100);
  assert.equal(check.status, 'fail', 'old leftover rows contradict the auto-prune claim');
  assert.match(check.detail, /2 of 100 events predate the 30-day retention window/, 'fail cites the live old count');
  assert.match(check.detail, /2026-10-17/, 'fail cites the cutoff the rows violate');
  assert.match(check.detail, /no automated prune has ever run/, 'fail cites the missing prune evidence');
  assert.match(check.detail, /Run a prune/, 'fail explains the remediation');
});

test('data_retention fails even when a prune ran but never covered the old rows', () => {
  const check = retentionCheck(30, PRUNED_AT, OLD, NOW, 1, 5);
  assert.equal(check.status, 'fail', 'last_prune alone does not clear the gate');
  assert.match(check.detail, /1 of 5 events predate the 30-day retention window/, 'fail cites the live old count');
  assert.match(check.detail, /last automated prune: 2026-11-10/, 'fail cites the stale run alongside the remains');
});

test('data_retention reports the manual-prune posture when disabled', () => {
  const check = retentionCheck(0, null, OLD, NOW);
  assert.equal(check.status, 'pass', 'disabled retention is a deliberate posture, not a failure');
  assert.match(check.detail, /WA_RETENTION_DAYS=0/, 'pass cites the disabling config');
  assert.match(check.detail, /oldest retained event dates to 2026-10-07/, 'pass reports what is actually kept');
  assert.match(check.detail, /prune manually with npm run prune/, 'pass points at the on-demand path');
});

test('data_retention passes with nothing recorded yet in either posture', () => {
  assert.equal(
    retentionCheck(30, null, null, NOW).status,
    'pass',
    'empty table under an enabled window passes',
  );
  assert.match(retentionCheck(30, null, null, NOW).detail, /no events recorded yet/, 'no spurious claim is made');
  assert.equal(
    retentionCheck(0, null, null, NOW).status,
    'pass',
    'empty table under disabled retention passes',
  );
  assert.match(retentionCheck(0, null, null, NOW).detail, /no events have been recorded yet/, 'empty-table detail is explicit');
});
