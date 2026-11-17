// The WA_*_PATH route-override surface at the HTTP layer. config.test.js pins
// only env -> config parsing, and helpers.js boots the shared in-process server
// with the default paths, so no test ever proved the router honors relocation.
// This file boots its own server (public-dir.test.js pattern) with all six path
// vars relocated, then pins the exact contract:
//
//   snippet / collect / realtime  — respond only on the relocated path; the old
//     default must 404 (these three are NOT aliased).
//   overview / export / audit     — answer on BOTH the relocated path and the
//     literal /api/* default, because public/index.html hardcodes the default
//     fetches and the aliases keep the dashboard working after relocation.
//
// The dashboard route (/), /api/health, and the cookie-less guarantee on the
// relocated collect are pinned here too, so an operator can relocate the API
// without silently losing the no-Set-Cookie posture.
//
// Like public-dir.test.js, the env is set BEFORE the cache-busted import; each
// test file is its own process, so the relocation never leaks into siblings.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-pathpub-'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-pathdata-'));
const port = 9900 + Math.floor(Math.random() * 500);

process.env.WA_HOST = '127.0.0.1';
process.env.WA_PORT = String(port);
process.env.WA_DATA_DIR = dir;
process.env.WA_HASH_SALT = 'paths-test-salt';
process.env.WA_PUBLIC_DIR = publicDir;
process.env.WA_SNIPPET_PATH = '/t.js';
process.env.WA_COLLECT_PATH = '/c';
process.env.WA_OVERVIEW_PATH = '/o';
process.env.WA_REALTIME_PATH = '/r';
process.env.WA_EXPORT_PATH = '/e';
process.env.WA_AUDIT_PATH = '/a';

const srvPath = path.resolve(import.meta.dirname, '..', 'src', 'server.js');
const mod = await import(`file://${srvPath}?cachebust=${Date.now()}`);
const server = mod.createServer();
await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const headers = { 'user-agent': 'UA-Paths' };
    if (typeof body === 'string') headers['content-type'] = 'application/json';
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
          });
        });
      },
    );
    req.on('error', reject);
    if (typeof body === 'string') req.write(body);
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

test('the relocated snippet serves real bytes; the old /wa.js default 404s', async () => {
  const custom = await request('GET', '/t.js');
  assert.equal(custom.status, 200);
  assert.match(custom.headers['content-type'], /^text\/javascript/);
  assert.match(custom.text(), /collect/i, 'real snippet bytes on the relocated path');

  const old = await request('GET', '/wa.js');
  assert.equal(old.status, 404, 'the default snippet path is not aliased');
});

test('the relocated collect answers 204 with no cookie; the old default 404s', async () => {
  const c1 = await request('POST', '/c', JSON.stringify({ path: '/reloc/a' }));
  assert.equal(c1.status, 204);
  assert.equal(c1.headers['set-cookie'], undefined, 'relocated collect is still cookie-less');
  assert.match(c1.headers['cache-control'], /no-store/, 'hardening headers ride along');

  const old = await request('POST', '/api/collect', JSON.stringify({ path: '/reloc/b' }));
  assert.equal(old.status, 404, 'the default collect path is not aliased');

  const get = await request('GET', '/c');
  assert.equal(get.status, 404, 'GET on the relocated collect is not a route');
});

test('relocated overview/export/audit answer on BOTH their path and the /api/* aliases', async () => {
  // The aliases exist so the dashboard — whose fetches hardcode the defaults —
  // keeps working after an operator relocates the API.
  await request('POST', '/c', JSON.stringify({ path: '/alias-check' }));

  for (const [custom, alias] of [
    ['/o', '/api/overview'],
    ['/e?days=30&format=csv', '/api/export?days=30&format=csv'],
    ['/a', '/api/audit'],
  ]) {
    const onCustom = await request('GET', custom);
    assert.equal(onCustom.status, 200, `${custom} serves on the relocated path`);
    const onAlias = await request('GET', alias);
    assert.equal(onAlias.status, 200, `${alias} still serves via the literal default`);
  }

  const overview = await (await request('GET', '/o')).text();
  assert.match(overview, /alias-check/, 'the overview reflects the relocated collect');
});

test('relocated realtime serves; the default /api/realtime 404s', async () => {
  await request('POST', '/c', JSON.stringify({ path: '/reloc-rt' }));

  const custom = await request('GET', '/r');
  assert.equal(custom.status, 200);
  assert.match(custom.headers['content-type'], /^application\/json/);

  const old = await request('GET', '/api/realtime');
  assert.equal(old.status, 404, 'the default realtime path is not aliased');
});

test('/api/health and the dashboard / are unaffected by the relocation', async () => {
  const health = await request('GET', '/api/health');
  assert.equal(health.status, 200);
  assert.match(health.text(), /"ok":true/);

  const root = await request('GET', '/');
  assert.equal(root.status, 200);
  assert.match(root.headers['content-type'], /^text\/html/);
  assert.match(root.headers['content-security-policy'], /default-src 'self'/, 'dashboard CSP is intact');
});
