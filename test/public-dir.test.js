// server.js custom-WA_PUBLIC_DIR behaviors. helpers-based suites boot the
// server against the repo public/ (full dashboard, real style.css, wa.js
// present), so three fallback branches were never exercised: the dashboard
// route's `'<h1>dashboard not built</h1>'` render when publicDir has no
// index.html (server.js:372), the CSP header that only lands on `/` and
// `/index.html` (331-336), and the /static/ mime fallback
// 'application/octet-stream' for unknown extensions (384). Because
// server.js snapshots dashboardHtml from config.publicDir at MODULE LOAD,
// this file sets WA_PUBLIC_DIR to a throwaway empty dir BEFORE its own
// cache-busted import — each test file is its own process, so the env never
// leaks into sibling suites — then bootstraps fixture files (an unknown-ext
// blob, a known-type css) in that dir. The snippet still resolves through
// handleSnippet's second path (repo public/wa.js), pinning that fallback too.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-pub-'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-pubdata-'));
const port = 9900 + Math.floor(Math.random() * 500);

process.env.WA_HOST = '127.0.0.1';
process.env.WA_PORT = String(port);
process.env.WA_DATA_DIR = dir;
process.env.WA_HASH_SALT = 'public-dir-test-salt';
process.env.WA_PUBLIC_DIR = publicDir;

const srvPath = path.resolve(import.meta.dirname, '..', 'src', 'server.js');
const mod = await import(`file://${srvPath}?cachebust=${Date.now()}`);
const server = mod.createServer();
await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

function request(method, url) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text: () => buf.toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  try {
    mod.__db.close();
  } catch {}
  fs.rmSync(publicDir, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('dashboard renders the not-built fallback when publicDir ships no index.html', async () => {
  const res = await request('GET', '/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^text\/html/);
  assert.equal(res.text(), '<h1>dashboard not built</h1>');
});

test('/index.html is served identically to /', async () => {
  const idx = await request('GET', '/index.html');
  assert.equal(idx.status, 200);
  assert.equal(idx.text(), '<h1>dashboard not built</h1>');
});

test('the CSP header lands on the dashboard routes and nowhere else', async () => {
  const CSP =
    "default-src 'self'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
  for (const url of ['/', '/index.html']) {
    const res = await request('GET', url);
    assert.equal(res.headers['content-security-policy'], CSP, `${url} carries the strict CSP`);
  }
  for (const url of ['/wa.js', '/api/health', '/static/logo.bin']) {
    const res = await request('GET', url);
    assert.equal(
      res.headers['content-security-policy'],
      undefined,
      `${url} is not a document route and must not carry CSP`,
    );
  }
});

test('statics from the custom publicDir: known mime, unknown ext, out-of-tree, missing', async () => {
  fs.writeFileSync(path.join(publicDir, 'style.css'), 'body{}');
  fs.writeFileSync(path.join(publicDir, 'logo.bin'), 'BLOB');

  const css = await request('GET', '/static/style.css');
  assert.equal(css.status, 200);
  assert.match(css.headers['content-type'], /^text\/css/);
  assert.equal(css.text(), 'body{}');

  const blob = await request('GET', '/static/logo.bin');
  assert.equal(blob.status, 200);
  assert.equal(blob.headers['content-type'], 'application/octet-stream', 'unknown extension hits the mime fallback');

  const missing = await request('GET', '/static/nope.css');
  assert.equal(missing.status, 404, 'a file absent from the custom dir 404s');

  const trav = await request('GET', '/static/%2e%2e/package.json');
  assert.equal(trav.status, 404, 'encoded traversal stays blocked with the custom dir');
});

test('the collect snippet still serves from the repo public/ when the custom dir has none', async () => {
  const res = await request('GET', '/wa.js');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^text\/javascript/);
  const text = res.text();
  assert.match(text, /collect/i, 'real snippet bytes from the repo fallback');
  assert.ok(
    fs.existsSync(path.join(import.meta.dirname, '..', 'public', 'wa.js')),
    'the repo fallback file exists',
  );
});
