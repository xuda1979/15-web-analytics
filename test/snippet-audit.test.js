// The audit's snippet_size check must be a real gate: it fails when the served
// collect snippet is missing or exceeds the ~1KB budget, and passes only when a
// file within budget is actually measured. Before this check was verified at
// report time, the status was hardcoded to 'pass' while the byte count was only
// quoted in the detail. These tests exercise every branch of the gate directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { snippetSizeCheck, ipStoreCheck } from '../src/audit.js';

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
