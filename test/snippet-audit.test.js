// The audit's snippet_size check must be a real gate: it fails when the served
// collect snippet is missing or exceeds the ~1KB budget, and passes only when a
// file within budget is actually measured. Before this check was verified at
// report time, the status was hardcoded to 'pass' while the byte count was only
// quoted in the detail. These tests exercise every branch of the gate directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { snippetSizeCheck } from '../src/audit.js';

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
