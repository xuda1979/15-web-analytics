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
