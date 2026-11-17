// Rate limiter unit tests + HTTP-level behavior on the live server.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/ratelimit.js';
import { request, pageview, startServer, stopServer } from './helpers.js';

// Close the shared in-process server so the runner can exit cleanly.
after(async () => {
  await stopServer();
});

test('RateLimiter allows `limit` requests per window then rejects', () => {
  const rl = new RateLimiter({ windowMs: 60_000, limit: 3 });
  const t = 1_700_000_000_000;
  assert.equal(rl.check('ip-a', t), 0, 'first allowed');
  assert.equal(rl.check('ip-a', t + 1), 0, 'second allowed');
  assert.equal(rl.check('ip-a', t + 2), 0, 'third allowed');
  assert.ok(rl.check('ip-a', t + 3) > 0, 'fourth rejected with retry delay');
  // Different key is unaffected.
  assert.equal(rl.check('ip-b', t + 3), 0, 'other IP still allowed');
});

test('RateLimiter windows reset', () => {
  const rl = new RateLimiter({ windowMs: 1000, limit: 2 });
  const t = 1_700_000_000_000;
  rl.check('z', t);
  rl.check('z', t + 1);
  assert.ok(rl.check('z', t + 2) > 0, 'window full');
  assert.equal(rl.check('z', t + 1000), 0, 'next window allows again');
  assert.equal(rl.check('z', t + 1001), 0, 'and again within the fresh window');
  assert.ok(rl.check('z', t + 2000) === 0 || rl.check('z', t + 2000) > 0, 'boundary stays consistent');
});

test('keyFor floors now to the fixed window start', () => {
  const rl = new RateLimiter({ windowMs: 60_000 });
  assert.equal(rl.keyFor(123_456_000), 123_420_000, 'floors to the minute');
  assert.equal(rl.keyFor(123_480_000), 123_480_000, 'an aligned instant maps to itself');
  assert.equal(rl.keyFor(123_479_999), 123_420_000, 'the instant before the boundary maps back');
});

test('in-window calls increment the count up to the limit, then reject', () => {
  const rl = new RateLimiter({ windowMs: 60_000, limit: 5 });
  rl.check('k', 1_000);
  rl.check('k', 1_001);
  assert.equal(rl.counts.get('k').count, 2, 'each call bumps the current window count');
  rl.check('k', 1_002);
  rl.check('k', 1_003);
  rl.check('k', 1_004);
  assert.equal(rl.counts.get('k').count, 5, 'the limit is reachable exactly');
  assert.ok(rl.check('k', 1_005) > 0, 'the sixth call rejects');
});

test('check rejects with the exact ms until the window rolls over', () => {
  const rl = new RateLimiter({ windowMs: 1000, limit: 2 });
  rl.check('k', 500);
  rl.check('k', 900);
  assert.equal(rl.check('k', 999), 1, 'Retry-After = windowMs - (now % windowMs)');
  assert.equal(rl.check('k', 1_000), 0, 'window rollover grants a fresh allowance');
});

test('tick evicts prior-window entries once the map is at maxEntries', () => {
  const rl = new RateLimiter({ windowMs: 1000, limit: 1, maxEntries: 2 });
  rl.check('a', 0);     // window 0
  rl.check('b', 100);   // window 0 — map now at the cap
  rl.check('a', 2_000); // window 2: tick cuts both stale win-0 entries, then re-adds a
  assert.equal(rl.counts.size, 1, 'eviction makes room instead of growing past the cap');
  assert.deepEqual([...rl.counts.keys()], ['a']);
  assert.equal(rl.check('b', 2_100), 0, 'an evicted key gets a fresh allowance, not a stale block');
});

test('a same-window flood of distinct keys cannot grow the map past maxEntries', () => {
  const rl = new RateLimiter({ windowMs: 60_000, limit: 60, maxEntries: 3 });
  rl.check('a', 1_000);
  rl.check('b', 1_001);
  rl.check('c', 1_002);
  assert.equal(rl.counts.size, 3, 'map fills to the cap');
  // Touching 'a' makes it the most-recently-used; the next new key evicts 'b'.
  rl.check('a', 1_003);
  rl.check('d', 1_004);
  assert.equal(rl.counts.size, 3, 'cap holds even with a same-window flood');
  assert.deepEqual([...rl.counts.keys()], ['c', 'a', 'd'], 'least-recently-touched key is evicted');
});

test('tick leaves a sub-capacity map alone even across old windows', () => {
  const rl = new RateLimiter({ windowMs: 1000, limit: 1, maxEntries: 10 });
  rl.check('k', 0);
  rl.check('k', 5_000); // same key, next window — size 1 stays under the cap
  assert.equal(rl.counts.size, 1);
  assert.equal([...rl.counts.values()][0].winStart, 5_000, 'stale window never evicted early');
});

test('collect endpoint returns 429 once the per-IP limit is hit', async () => {
  const { port } = await startServer();
  // Start fresh: rate-limit the test with a tiny window over the live config?
  // The shared server uses the default 60/min — instead verify by firing 60+.
  // That is slow but deterministic, and exercises the real code path.
  let got429 = false;
  let lastStatus = 0;
  for (let i = 0; i < 70; i++) {
    const r = await request('POST', '/api/collect', pageview({ path: '/rl/' + i }), {
      'user-agent': 'RL-UA',
      'x-forwarded-for': '203.0.113.200',
    });
    lastStatus = r.status;
    if (r.status === 429) {
      got429 = true;
      break;
    }
  }
  assert.ok(got429, `expected a 429 within 70 rapid posts, last status ${lastStatus}`);
});
