// server.js is the largest src module (480 lines) yet has no dedicated test
// file: acceptance.test.js and lifecycle.test.js only hit its happy paths
// through the HTTP routes. These tests pin the edge behavior directly against
// the shared in-process server (helpers.js): the 400/204 body-handling
// contract, parseRange clamps and invalid-param fallbacks, clientIp
// precedence (x-real-ip wins over x-forwarded-for; the xff list uses its
// first element), the CSV export content negotiation (content-type +
// content-disposition), the audit text format, 404/wrong-method/missing-static
// responses, static serving with the encoded-traversal guard, the health
// shape, and the baseline hardening headers.
//
// helpers.js boots one server per process and one DB per process, so sibling
// tests share data — every test uses unique paths/IPs and relative assertions.

// NOTE: no static `../src/*` imports here on purpose. helpers.js sets the
// WA_* env vars (including WA_DATA_DIR) and then loads src/server.js via a
// cache-busted dynamic import; a top-level static import of src/config.js
// (or anything reaching it, like privacy.js) would snapshot the default env
// at module load and point the server at the real ./data instead of the
// throwaway tmpdir, breaking the per-process DB isolation this suite leans on.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { startServer, stopServer } from './helpers.js';

// Close the shared in-process server so the runner can exit cleanly.
after(async () => {
  await stopServer();
});

// helpers.request() always JSON-stringifies its body, so it cannot send
// malformed JSON. This raw client sends the literal bytes the server's
// readJsonBody must reject.
function rawRequest(port, method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: url, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: () => buf.toString('utf8'),
            json: () => JSON.parse(buf.toString('utf8') || 'null'),
          });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Sends a request and captures the outcome even when the server kills the
// socket mid-body (oversized payloads: readJsonBody destroys the request, so
// the client sees ECONNRESET and never an HTTP status line).
function rawRequestCapture(port, method, url, body, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: url, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode, text: () => buf.toString('utf8') });
        });
      },
    );
    req.on('error', (err) => resolve({ status: null, error: err.code }));
    req.write(body);
    req.end();
  });
}

test('collect: an oversized payload trips a hard connection reset, not a 4xx', async () => {
  const { port, request } = await startServer();

  // ~6 KB of JSON pushes readJsonBody (4096-byte limit) over the edge, so it
  // rejects and destroys the request socket.
  const big = { path: '/oversized', title: 'x'.repeat(6000) };
  const res = await rawRequestCapture(port, 'POST', '/api/collect', JSON.stringify(big), {
    'content-type': 'application/json',
    'user-agent': 'UA-Big',
  });

  assert.equal(res.status, null, 'no HTTP status is ever delivered');
  assert.equal(res.error, 'ECONNRESET', 'the socket is destroyed under the client');

  // The destroyed request must not take the server down with it.
  const health = await request('GET', '/api/health');
  assert.equal(health.status, 200, 'server survives the aborted request');
  assert.equal(health.json().ok, true);
});

test('collect: malformed JSON yields a 400 bad-payload JSON response', async () => {
  const { port, request } = await startServer();
  const res = await rawRequest(port, 'POST', '/api/collect', '{"path": "unterminated', {
    'content-type': 'application/json',
    'x-forwarded-for': '203.0.113.1',
    'user-agent': 'UA-Malformed',
  });
  assert.equal(res.status, 400);
  assert.match(res.headers['content-type'], /^application\/json/);
  assert.deepEqual(res.json(), { ok: false, error: 'bad payload' });
});

test('collect: an empty body is read as {} and answered 204', async () => {
  const { request } = await startServer();
  const res = await request('POST', '/api/collect', undefined, {
    'x-forwarded-for': '203.0.113.2',
    'user-agent': 'UA-Empty',
  });
  assert.equal(res.status, 204, 'empty body resolves to {} and inserts normally');
});

test('overview range: parseRange clamps and falls back on malformed params', async () => {
  const { request } = await startServer();

  // Explicit days is honored.
  let body = await (await request('GET', '/api/overview?days=60')).json();
  assert.equal(body.range.days, 60, 'valid days pass through');

  // Days beyond the 10-year cap are clamped to 3650.
  body = await (await request('GET', '/api/overview?days=100000')).json();
  assert.equal(body.range.days, 3650, 'days cap at 3650');

  // days=0 and non-numeric days fall back to the 30-day default.
  body = await (await request('GET', '/api/overview?days=0')).json();
  assert.equal(body.range.days, 30, 'days=0 falls back to the default');
  body = await (await request('GET', '/api/overview?days=abc')).json();
  assert.equal(body.range.days, 30, 'non-numeric days falls back to the default');
});

test('overview range: invalid from/to bounds are ignored, not applied', async () => {
  const { request } = await startServer();
  const before = Date.now();
  const body = await (await request('GET', '/api/overview?days=3&to=notadate&from=notadate')).json();
  const after = Date.now();

  assert.equal(body.range.days, 3, 'valid days still governs the window');
  assert.ok(body.range.end >= before && body.range.end <= after, 'invalid to is ignored (end ~= now)');
  assert.equal(body.range.end - body.range.start, 3 * 86_400_000, 'window is exactly the requested days');
});

test('collect: x-real-ip wins, xff uses its first element; guest keys follow', async () => {
  const { request, db } = await startServer();

  // A: x-real-ip and x-forwarded-for both present — 203.0.113.7 wins.
  await request('POST', '/api/collect', { path: '/ip-prec-a' }, {
    'x-real-ip': '203.0.113.7',
    'x-forwarded-for': '198.51.100.1',
    'user-agent': 'UA-Prec',
  });
  // B: only x-forwarded-for — still 203.0.113.7, so the same guest key.
  await request('POST', '/api/collect', { path: '/ip-prec-b' }, {
    'x-forwarded-for': '203.0.113.7',
    'user-agent': 'UA-Prec',
  });
  // C: a proxy chain — the leftmost address is used.
  await request('POST', '/api/collect', { path: '/ip-prec-c' }, {
    'x-forwarded-for': '10.9.9.9, 10.8.8.8',
    'user-agent': 'UA-Chain',
  });

  const rowsA = db.prepare('SELECT guest_key FROM events WHERE path = ?').all('/ip-prec-a');
  const rowsB = db.prepare('SELECT guest_key FROM events WHERE path = ?').all('/ip-prec-b');
  const rowsC = db.prepare('SELECT guest_key FROM events WHERE path = ?').all('/ip-prec-c');
  assert.equal(rowsA.length, 1);
  assert.equal(rowsB.length, 1);
  assert.equal(rowsC.length, 1);
  assert.equal(rowsB[0].guest_key, rowsA[0].guest_key, 'xff alone yields the same key as x-real-ip');
  assert.notEqual(rowsC[0].guest_key, rowsA[0].guest_key, 'a different ip yields a different key');
});

test('export: CSV sets type and attachment disposition; JSON does not', async () => {
  const { request } = await startServer();

  const csv = await request('GET', '/api/export?days=30&format=csv');
  assert.match(csv.headers['content-type'], /^text\/csv; charset=utf-8$/);
  assert.match(
    csv.headers['content-disposition'],
    /^attachment; filename="events-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv"$/,
    'CSV is an attachment named after the requested day range',
  );

  const json = await request('GET', '/api/export?days=30');
  assert.match(json.headers['content-type'], /^application\/json/);
  assert.equal(json.headers['content-disposition'], undefined, 'JSON is not an attachment');
});

test('audit: format=text renders the plain-text report; the default is JSON', async () => {
  const { request } = await startServer();

  const text = await request('GET', '/api/audit?format=text');
  assert.match(text.headers['content-type'], /^text\/plain; charset=utf-8$/);
  const body = text.text();
  assert.match(body, /^Privacy Audit Report — 15-web-analytics/m, 'header line with the em-dash title');
  assert.match(body, /^  \[PASS\]/m, 'at least one PASS check renders');
  assert.match(body, /^DB: /m, 'the DB line renders');

  const jsonR = await request('GET', '/api/audit');
  assert.match(jsonR.headers['content-type'], /^application\/json/);
  const audit = jsonR.json();
  assert.equal(audit.pass_count, 7, 'clean-posture report has 7 passing checks');
  assert.ok(Array.isArray(audit.checks) && audit.checks.length === 7);
});

test('routing: unknown routes, wrong methods, and missing statics all 404', async () => {
  const { request } = await startServer();

  let res = await request('GET', '/api/nope');
  assert.equal(res.status, 404);
  assert.equal(res.text(), 'not found');

  // POSTing to a GET-only route must not be treated as a collect.
  res = await request('POST', '/api/collect', { path: '/wrong-method' }, {});
  assert.equal(res.status, 204, 'POST /api/collect is the legitimate collect path');

  res = await request('GET', '/api/collect');
  assert.equal(res.status, 404, 'GET on the collect path is not a route');

  res = await request('GET', '/static/nope.css');
  assert.equal(res.status, 404);
  assert.equal(res.text(), 'not found');
});

test('static: real files serve with the right type; encoded traversal is blocked', async () => {
  const { request, dir } = await startServer();

  const css = await request('GET', '/static/style.css');
  assert.equal(css.status, 200);
  assert.match(css.headers['content-type'], /^text\/css/);

  // The URL parser normalizes literal ../ segments away before the handler
  // sees them, so traversal must be exercised via percent-encoded dots.
  const trav = await request('GET', '/static/%2e%2e/package.json');
  assert.equal(trav.status, 404, 'engineered traversal is refused');

  // The guard also refuses real files that resolve outside public/.
  const abs = await request('GET', '/static/%2e%2e/%2e%2e/package.json');
  assert.equal(abs.status, 404);
});

test('health: returns ok and a numeric timestamp', async () => {
  const { request } = await startServer();
  const before = Date.now();
  const res = await request('GET', '/api/health');
  const after = Date.now();
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^application\/json/);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.ok(Number.isInteger(body.ts) && body.ts >= before && body.ts <= after, 'ts is a fresh epoch ms');
});

test('hardening: every response carries the no-store and nosniff headers', async () => {
  const { request } = await startServer();
  for (const url of ['/wa.js', '/api/overview', '/api/health', '/static/style.css']) {
    const res = await request('GET', url);
    assert.match(res.headers['cache-control'], /no-store/, url);
    assert.equal(res.headers['x-content-type-options'], 'nosniff', url);
    assert.equal(res.headers['referrer-policy'], 'strict-origin-when-cross-origin', url);
  }
});

test('collect: a burst past the rate limit answers 429 and keeps the loop alive', async () => {
  const { request } = await startServer();

  // The shared in-process server runs with the default collect limiter
  // (config.collectRateLimit = 60, 60s window), and clientIp() keys off the
  // first x-forwarded-for value. A dedicated IP keeps this counter isolated
  // from sibling tests' distinct XFF assignments.
  const spamIp = '198.51.100.77';
  const ua = 'UA-RL';

  // 60 requests fit inside the window (the limiter's `count >= limit` check at
  // the edge re-arms the next request to the 61st).
  for (let i = 0; i < 60; i++) {
    const res = await request('POST', '/api/collect', { path: `/rl-${i}` }, {
      'x-forwarded-for': spamIp,
      'user-agent': ua,
    });
    assert.equal(res.status, 204, `request ${i + 1} passes`);
  }

  // The 61st trips the limit: 429, Retry-After in seconds, JSON error body.
  const over = await request('POST', '/api/collect', { path: '/rl-over' }, {
    'x-forwarded-for': spamIp,
    'user-agent': ua,
  });
  assert.equal(over.status, 429);
  assert.match(over.headers['content-type'], /^application\/json/);
  assert.match(over.headers['retry-after'], /^[1-9]\d*$/, 'retry-after is whole seconds > 0');
  assert.deepEqual(over.json(), { ok: false, error: 'rate limited' });

  // A rejected request must not take the loop down — health still answers, and
  // another IP (a different key) is unaffected by the burst.
  const health = await request('GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.json().ok, true);
  const other = await request('POST', '/api/collect', { path: '/rl-other' }, {
    'x-forwarded-for': '198.51.100.78',
    'user-agent': ua,
  });
  assert.equal(other.status, 204, 'a different client IP is not rate-limited');
});

test('export: a filtered CSV summary serializes every section under the filter', async () => {
  const { request } = await startServer();

  // Two distinct paths, two distinct IPs, so the ordering and the filtering
  // are unambiguous. The shared in-process DB also carries sibling tests'
  // rows, hence the days=30 window and per-test unique paths.
  await request('POST', '/api/collect', { path: '/fdsum/a' }, {
    'x-forwarded-for': '198.51.100.60',
    'user-agent': 'UA-Fdsum',
  });
  await request('POST', '/api/collect', { path: '/fdsum/b' }, {
    'x-forwarded-for': '198.51.100.61',
    'user-agent': 'UA-Fdsum',
  });

  const csv = await request('GET', '/api/export?days=30&format=csv&summary=1&page=/fdsum/a');
  assert.match(csv.headers['content-type'], /^text\/csv; charset=utf-8$/);
  assert.match(
    csv.headers['content-disposition'],
    /^attachment; filename="events-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv"$/,
    'a filtered summary stays an attachment',
  );

  // exportSummary joins sections with \n\n, so inside a section body index 0-1
  // are blank, index 2 is the column header, and the rows start at index 3.
  const pagesLines = csv.text().split('# pages')[1].split('\n');
  assert.match(pagesLines[3] ?? '', /fdsum\/a/, 'the pages section carries the filtered path row');
  assert.doesNotMatch(pagesLines[3] ?? '', /fdsum\/b/, 'the sibling path is filtered out of the pages section');

  const totalsBlock = csv.text().split('# totals')[1].split('# visit_stats')[0];
  assert.match(totalsBlock, /visits,uniques\n1,1/, 'totals reflect only the filtered path');
});

test('export: the unfiltered CSV summary contrasts by counting every row', async () => {
  const { request } = await startServer();

  // The shared in-process DB carries dozens of sibling rows (the 60 /rl-*
  // rate-limit paths dominate the top-50 pages list), so a pages-section
  // presence check would be fragile here. The contrast that matters: the
  // unfiltered summary counts all rows — which the filtered 1,1 total above
  // must narrow — while the filtered variant counts only the one path.
  await request('POST', '/api/collect', { path: '/fdsun/a' }, {
    'x-forwarded-for': '198.51.100.62',
    'user-agent': 'UA-Fdsun',
  });
  await request('POST', '/api/collect', { path: '/fdsun/b' }, {
    'x-forwarded-for': '198.51.100.63',
    'user-agent': 'UA-Fdsun',
  });

  const csv = await request('GET', '/api/export?days=30&format=csv&summary=1');
  assert.match(csv.headers['content-type'], /^text\/csv; charset=utf-8$/);
  const totalsLine = csv.text().split('# totals')[1].split('# visit_stats')[0].trim().split('\n')[1];
  const visits = Number(totalsLine.split(',')[0]);
  assert.ok(visits > 1, `unfiltered summary counts every row (visits=${visits})`);
  assert.ok(csv.text().includes('# pages'), 'the unfiltered summary still serializes the pages section');
});

test('audit: the text=1 shorthand renders the same plain-text report', async () => {
  const { request } = await startServer();

  const alias = await request('GET', '/api/audit?text=1');
  assert.match(alias.headers['content-type'], /^text\/plain; charset=utf-8$/);
  assert.match(alias.text(), /^Privacy Audit Report — 15-web-analytics/m, 'alias renders the text report');

  const canonical = await request('GET', '/api/audit?format=text');
  assert.match(canonical.headers['content-type'], /^text\/plain; charset=utf-8$/);
  // generated_at is re-stamped per request, so drop that line before comparing.
  const stripStamp = (t) => t.split('\n').filter((l) => !l.startsWith('Generated: ')).join('\n');
  assert.equal(stripStamp(alias.text()), stripStamp(canonical.text()), 'text=1 and format=text render an identical report');
});

// MUST stay the last test in this file: it deliberately breaks the shared
// in-process DB so every database-backed route throws, and after() then shuts
// the server down. No later test may rely on this server's DB.
test('error handling: a DB failure yields a 500 JSON body and a live server', async () => {
  const { request, db } = await startServer();

  // Sabotage the raw store so the next overview read throws mid-request. The
  // events table is the source of truth every analytics query reads, which is
  // exactly why its absence trips the top-level catch rather than the route.
  db.exec('DROP TABLE events');

  const res = await request('GET', '/api/overview?days=1');
  assert.equal(res.status, 500, 'the top-level catch answers 500');
  assert.match(res.headers['content-type'], /^application\/json/);
  assert.deepEqual(res.json(), { ok: false, error: 'internal' });

  // The catch path must still carry the baseline hardening headers, which are
  // set before the try block.
  assert.match(res.headers['cache-control'], /no-store/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');

  // The failure must not take the process down: /api/health touches no table
  // and still answers through the same request loop.
  const health = await request('GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.json().ok, true);
});
