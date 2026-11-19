// The dashboard's "Activity by hour" card heading is rewritten at server boot
// to mirror WA_HOUR_OFFSET_MIN (src/server.js:89-94). helpers.js boots once
// with the default offset, so the label branches — non-zero and fractional
// offsets — are never exercised by the shared server. server.js snapshots
// config at module load AND config.js is a cacheable ESM module shared across
// cache-busted imports in one process, so each offset variant needs its own
// process: a real server subprocess with the env set before boot, like
// lifecycle.test.js. The repo public/ dashboard is served (WA_PUBLIC_DIR
// unset), so the rewrite is observable on the live `/` HTML.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wa-label-'));
}

// Ephemeral port OUTSIDE the ranges other suites bind at module load
// (helpers.js 8900-9399, public-dir.test.js 9900-10399, lifecycle seconds 884x)
// so parallel file execution cannot collide.
function port() {
  return 11000 + Math.floor(Math.random() * 400);
}

// Boot a fresh server subprocess. Resolves once /api/health answers 200.
function bootServer(dir, port, offsetMin) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', 'src/server.js'],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          WA_HOST: '127.0.0.1',
          WA_PORT: String(port),
          WA_DATA_DIR: dir,
          WA_HOUR_OFFSET_MIN: String(offsetMin),
        },
      },
    );
    let out = '';
    let err = '';
    proc.stdout.on('data', (c) => (out += c));
    proc.stderr.on('data', (c) => (err += c));

    const deadline = Date.now() + 10000;
    const poll = () => {
      http
        .get(`http://127.0.0.1:${port}/api/health`, (res) => {
          if (res.statusCode === 200) {
            resolve({ pid: proc.pid, proc, msg: () => out + err });
            return;
          }
          retry();
        })
        .on('error', retry);
      function retry() {
        if (Date.now() > deadline) {
          reject(new Error(`server did not boot:\n${out}\n${err}`));
          return;
        }
        setTimeout(poll, 100);
      }
    };
    proc.on('exit', (code) => reject(new Error(`server exited early (${code}):\n${out}\n${err}`)));
    poll();
  });
}

function get(port, url) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: url, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, text: () => buf.toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('default offset (0) keeps the "Activity by hour (UTC)" heading unchanged', async () => {
  const dir = tmpdir();
  const p = port();
  const { pid, proc } = await bootServer(dir, p, 0);
  try {
    const res = await get(p, '/');
    assert.equal(res.status, 200);
    assert.match(res.text(), /<h3>Activity by hour \(UTC\)<\/h3>/, 'offset 0 renders the plain UTC label');
  } finally {
    proc.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('offset 480 serves "Activity by hour (UTC+8)"', async () => {
  const dir = tmpdir();
  const p = port();
  const { proc } = await bootServer(dir, p, 480);
  try {
    const res = await get(p, '/');
    assert.equal(res.status, 200);
    assert.match(res.text(), /<h3>Activity by hour \(UTC\+8\)<\/h3>/, 'the UTC+8 label lands in the card heading');
    assert.ok(
      !res.text().includes('Activity by hour (UTC)</h3>'),
      'the replace must not leave the UTC heading in place for a non-zero offset',
    );
  } finally {
    proc.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fractional offset (UTC-5:30) renders with minutes', async () => {
  const dir = tmpdir();
  const p = port();
  const { proc } = await bootServer(dir, p, -330);
  try {
    const res = await get(p, '/');
    assert.equal(res.status, 200);
    assert.match(res.text(), /<h3>Activity by hour \(UTC-5:30\)<\/h3>/, 'fractional offsets render h:mm');
  } finally {
    proc.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
