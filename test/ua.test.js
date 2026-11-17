// The UA parser drives the browser / device / operating-system / device-model
// breakdowns and the bot exclusion — the sole runtime dependency — yet no test
// imported it directly; acceptance.test.js only saw its effects through the
// HTTP routes. These tests pin parseUa() and isBot() on real user-agent
// strings so the dimensions and the bot gate behave predictably.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseUa, isBot, parserCache, PARSER_CACHE_MAX } from '../src/ua.js';

test('parseUa reads desktop Chrome on Windows', () => {
  const r = parseUa(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  );
  assert.equal(r.browser, 'Chrome');
  assert.equal(r.browserVersion, '120', 'dominant version is the major');
  assert.equal(r.os, 'Windows');
  assert.equal(r.device, 'desktop');
  assert.equal(r.deviceModel, '', 'desktop UAs carry no concrete model');
});

test('parseUa identifies an iPhone visit as mobile Safari on iOS', () => {
  const r = parseUa(
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  );
  assert.equal(r.browser, 'Mobile Safari');
  assert.equal(r.browserVersion, '17');
  assert.equal(r.os, 'iOS');
  assert.equal(r.device, 'mobile');
  assert.equal(r.deviceModel, 'iPhone');
});

test('parseUa carries the Android device model (Pixel 7)', () => {
  const r = parseUa(
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36',
  );
  assert.equal(r.browser, 'Chrome');
  assert.equal(r.browserVersion, '119');
  assert.equal(r.os, 'Android');
  assert.equal(r.device, 'mobile');
  assert.equal(r.deviceModel, 'Pixel 7');
});

test('parseUa treats Firefox on Linux as a desktop browser', () => {
  const r = parseUa('Mozilla/5.0 (X11; Linux x86_64; rv:115.0) Gecko/20100101 Firefox/115.0');
  assert.equal(r.browser, 'Firefox');
  assert.equal(r.browserVersion, '115');
  assert.equal(r.os, 'Linux');
  assert.equal(r.device, 'desktop');
});

test('parseUa falls back to Unknown without crashing on missing UAs', () => {
  for (const ua of ['', undefined, null]) {
    const r = parseUa(ua);
    assert.equal(r.browser, 'Unknown', `browser fallback for ${String(ua)}`);
    assert.equal(r.os, 'Unknown', `os fallback for ${String(ua)}`);
    assert.equal(r.device, 'desktop', `desktop fallback for ${String(ua)}`);
    assert.equal(r.browserVersion, '', 'no phantom version');
    assert.equal(r.deviceModel, '', 'no phantom model');
  }
});

test('parseUa memoizes identical UAs (same object reference)', () => {
  const ua = 'Mozilla/5.0 (X11; Linux x86_64) Firefox/115.0';
  assert.equal(parseUa(ua), parseUa(ua), 'cache hit must return the cached result');
});

test('isBot flags crawlers, spiders, monitors and uptime probes', () => {
  for (const ua of [
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Sogou web spider/4.0',
    'Pinterest/0.2',
    'UptimeRobot/2.0',
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
  ]) {
    assert.equal(isBot(ua), true, `must flag ${ua}`);
  }
});

test('isBot is case-insensitive', () => {
  assert.equal(isBot('GoogleBot/2.1'), true, 'lower-cased "bot" still matches');
});

test('isBot lets real browsers and CLI tools through', () => {
  for (const ua of [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
    'HeadlessChrome/120.0.0.0',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 Safari/604.1',
    'curl/8.0',
    '',
    null,
    undefined,
  ]) {
    assert.equal(isBot(ua), false, `must NOT flag ${String(ua)}`);
  }
});

test('parseUa cache is bounded and evicts the oldest entry', () => {
  // Start from a known state: prior tests leave the module cache populated.
  parserCache.clear();
  const seed = `bounded-cache/${process.pid}-`;
  for (let i = 0; i < PARSER_CACHE_MAX; i++) parseUa(seed + i);
  assert.equal(parserCache.size, PARSER_CACHE_MAX, 'cache fills exactly to the cap');
  // A fresh UA past the cap evicts the very oldest entry (insertion order).
  const oldest = seed + 0;
  assert.ok(parserCache.has(oldest), 'the oldest entry is present before the eviction');
  parseUa(`${seed}xevict`);
  assert.equal(parserCache.size, PARSER_CACHE_MAX, 'cache stays at the cap after overflow');
  assert.equal(parserCache.has(oldest), false, 'oldest entry was evicted on overflow');
});
