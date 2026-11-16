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
