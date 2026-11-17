// The CLI's argument parsing was never unit tested: int(), collectArgs() and
// pattern() are module-private helpers that the collect and prune subcommands
// depend on for --sw/--sh screen parsing, the --key=value options map, and the
// --days override, yet only the seed subcommand was exercised end-to-end (in
// lifecycle.test.js). These tests cover every parse branch directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { int, collectArgs, pattern } from '../src/cli.js';

test('int parses a finite string and returns it', () => {
  assert.equal(int('5', 0), 5);
  assert.equal(int('390', 0), 390);
  assert.equal(int('  42  ', 0), 42, 'leading/trailing whitespace is tolerated');
});

test('int falls back on non-finite input', () => {
  assert.equal(int('abc', 9), 9, 'garbage falls back');
  assert.equal(int(undefined, 30), 30, 'undefined falls back');
  assert.equal(int(null, 30), 30, 'null falls back');
  assert.equal(int('', 30), 30, 'empty string falls back');
});

test('int handles negative and zero explicitly rather than silently', () => {
  assert.equal(int('-7', 30), -7, 'negative numbers parse');
  assert.equal(int('0', 30), 0, 'zero parses and is not mistaken for a fallback');
});

test('collectArgs maps every --key=value flag into an options object', () => {
  const opts = collectArgs([
    '--path=/docs',
    '--referrer=https://github.com/',
    '--lang=zh-CN',
  ]);
  assert.deepEqual(opts, {
    path: '/docs',
    referrer: 'https://github.com/',
    lang: 'zh-CN',
  });
});

test('collectArgs preserves values that contain "=" (e.g. a query string)', () => {
  const opts = collectArgs(['--referrer=https://a.example/?b=c&d=e']);
  assert.equal(opts['referrer'], 'https://a.example/?b=c&d=e');
});

test('collectArgs ignores non-flag args and returns an empty object without flags', () => {
  assert.deepEqual(collectArgs(['plain', '/positional']), {}, 'non-flag args are ignored');
  assert.deepEqual(collectArgs([]), {}, 'no args yields an empty map');
});

test('pattern returns the first regex capture match among the args', () => {
  assert.equal(pattern(['--sw=390', '--sh=844'], /^--sw=(\d+)/), '390');
  assert.equal(pattern(['--sh=844', '--sw=390'], /^--sw=(\d+)/), '390', 'first-in-list wins');
});

test('pattern returns null when nothing matches, so callers fall back to defaults', () => {
  assert.equal(pattern(['--sw=390'], /^--days=(\d+)/), null);
  assert.equal(pattern([], /^--sw=(\d+)/), null);
});

test('prune uses the CLI --days override instead of the config default', () => {
  const configDefault = 30;
  const days = int(pattern(['prune', '--days=90', '--force'], /^--days=(\d+)/), configDefault);
  assert.equal(days, 90, 'explicit --days beats the configured window');
  assert.equal(
    int(pattern(['prune'], /^--days=(\d+)/), configDefault),
    configDefault,
    'absent --days falls back to the config window',
  );
});
