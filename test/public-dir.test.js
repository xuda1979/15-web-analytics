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

import { test, after, mock } from 'node:test';
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

test('directory paths under /static/ answer 404 instead of crashing the stream', async () => {
  // Before the guard grew a stat check, an existing directory slipped past
  // fs.existsSync and fs.createReadStream(dir) emitted an unhandled EISDIR
  // ('error' event, no listener) which crashed the whole process.
  fs.mkdirSync(path.join(publicDir, 'assets'), { recursive: true });

  for (const url of ['/static/', '/static/assets', '/static/assets/']) {
    const res = await request('GET', url);
    assert.equal(res.status, 404, `${url} must 404, not stream a directory`);
    assert.equal(res.text(), 'not found');
  }

  // A trailing slash on a real file resolves to the file itself, so it still
  // serves — the guard rejects directories, not URL residue.
  fs.writeFileSync(path.join(publicDir, 'file.css'), 'body{}');
  const file = await request('GET', '/static/file.css/');
  assert.equal(file.status, 200, 'trailing slash on a file resolves to the file');
});

test('a sibling of publicDir with a shared prefix stays out of reach', async () => {
  // Bare prefix compares (`resolved.startsWith(publicDir)`) would also accept
  // a directory whose name merely starts with publicDir's basename, e.g. a
  // tmpdir `<tmp>/wa-pub-...-evil/`. Prove the separator-aware guard refuses it.
  const base = process.env.WA_PUBLIC_DIR;
  const evil = `${base}-evil`;
  fs.mkdirSync(evil, { recursive: true });
  fs.writeFileSync(path.join(evil, 'pwn.txt'), 'nope');
  try {
    const rel = evil.replace(`${path.dirname(base)}${path.sep}`, '');
    const res = await request('GET', `/static/${rel}/pwn.txt`);
    assert.equal(res.status, 404, 'sibling-dir file resolved by path.resolve must not be served');
  } finally {
    fs.rmSync(evil, { recursive: true, force: true });
  }
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

// A request that tolerates the connection being aborted mid-response: the
// guarded handler destroys the response when the read stream fails to open,
// which the client sees as a reset without a usable body. The suite's request()
// helper would reject on that; this one resolves with 'aborted' instead.
function fragileGet(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: url }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', () => resolve({ status: 'aborted' }));
      res.on('end', () => resolve({ status: res.statusCode, text: () => Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', () => resolve({ status: 'aborted' }));
    req.setTimeout(timeoutMs, () => resolve({ status: 'aborted' }));
    req.end();
  });
}

test('a static that passes stat but fails to open cannot crash the server', async () => {
  // The statSync().isFile() guard runs before the file is opened, so a file
  // that loses read permission (or is deleted) between the two can still fail
  // in fs.createReadStream. An unattached 'error' event there used to crash the
  // whole process (EACCES uncaught); the response is destroyed instead.
  const blocked = path.join(publicDir, 'blocked.txt');
  fs.writeFileSync(blocked, 'secret-bytes');
  fs.chmodSync(blocked, 0o000);
  const outcome = await fragileGet('/static/blocked.txt');
  fs.chmodSync(blocked, 0o644); // restore even if the assertion below fails
  fs.rmSync(blocked, { force: true });

  assert.ok(outcome.status !== 200 || outcome.text() !== 'secret-bytes', 'blocked bytes are not delivered');
  const health = await request('GET', '/api/health');
  assert.equal(health.status, 200, 'the server survives an open-failure on a static file');
});

test('an unreadable snippet wa.js cannot crash the server either', async () => {
  // handleSnippet probes config.publicDir/wa.js via existsSync, then opens the
  // stream — the same stat/open race as /static/. The custom dir's blocked
  // copy shadows the repo fallback, so the open failure must be contained.
  const blockedJs = path.join(publicDir, 'wa.js');
  fs.writeFileSync(blockedJs, '// secret snippet');
  fs.chmodSync(blockedJs, 0o000);
  const outcome = await fragileGet('/wa.js');
  fs.chmodSync(blockedJs, 0o644); // restore so later tests see the repo fallback
  fs.rmSync(blockedJs, { force: true });

  assert.ok(outcome.status !== 200 || outcome.text() !== '// secret snippet', 'blocked snippet bytes are not delivered');
  const health = await request('GET', '/api/health');
  assert.equal(health.status, 200, 'the server survives an open-failure on the snippet');
});

test('the snippet 404s only when both the custom dir and the repo fallback lack wa.js', async () => {
  // handleSnippet probes config.publicDir/wa.js then the repo public/wa.js and
  // only falls through to notFound when both are absent. The repo copy always
  // exists on disk, so the fall-through is reachable only by mocking
  // fs.existsSync to say no for both probes, then restoring it so the after()
  // teardown (and this file's other tests) still see real files.
  mock.method(fs, 'existsSync', () => false);
  try {
    const res = await request('GET', '/wa.js');
    assert.equal(res.status, 404);
    assert.equal(res.text(), 'not found');
  } finally {
    mock.restoreAll();
  }
  const real = await request('GET', '/wa.js');
  assert.equal(real.status, 200, 'the repo fallback serves again after the mock is restored');
});
