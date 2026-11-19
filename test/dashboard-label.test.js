// The dashboard's "Activity by hour" card heading is rewritten at server boot
// to mirror WA_HOUR_OFFSET_MIN (src/server.js:89-94), and — once a pageview
// arrives — the hour bucket it lands in shifts by the same offset in the
// served /api/overview data. helpers.js boots once with the default offset, so
// neither the label branches (non-zero, fractional, west-of-UTC) nor the
// offset-shifted bucket math are exercised by the shared server. server.js
// snapshots config at module load AND config.js is a cacheable ESM module
// shared across cache-busted imports in one process, so each offset variant
// needs its own process: a real server subprocess with the env set before
// boot, like lifecycle.test.js. The repo public/ dashboard is served
// (WA_PUBLIC_DIR unset), so the rewrite is observable on the live `/` HTML and
// the data path on /api/overview.

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

function postJson(port, url, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      { host: '127.0.0.1', port, method: 'POST', path: url, agent: false,
        headers: { 'content-type': 'application/json', 'content-length': data.length } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, text: () => Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

// The collect contract is a plain pageview object (helpers.pageview shape).
function pageview(path) {
  return { path, referrer: '', title: '', sw: 1920, sh: 1080, lang: 'en' };
}

// Local hour-of-day index for a UTC date, given a minute offset — the same
// integer the server's strftime('%H', ts + offsetMin*60000) buckets into.
// Negative offsets wrap through midnight: an event at 00:10 UTC with offset
// -300 is 19:10 the prior local day, still bucket 19 on the dateless axis.
function localHour(utcDate, offsetMin) {
  const total = utcDate.getUTCHours() * 60 + utcDate.getUTCMinutes() + offsetMin;
  return (((Math.floor(total / 60) % 24) + 24) % 24);
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

test('offset -300 shifts the served hourly bucket into local hours (data)', async () => {
  const dir = tmpdir();
  const p = port();
  const { proc } = await bootServer(dir, p, -300);
  try {
    // A fresh pageview (distinct guest per collect) lands in the current UTC
    // hour; with UTC-5 the SAME event must be served in the previous local
    // hour by /api/overview.hourly[localHour] — the bucket math, not just the
    // heading, honors the west-zone offset.
    const res = await postJson(p, '/api/collect', pageview('/off/w'));
    assert.equal(res.status, 204, 'collect accepts the pageview');
    const json = JSON.parse((await get(p, '/api/overview')).text());
    const now = new Date();
    const local = localHour(now, -300);
    const expectedUtc = now.getUTCHours();
    const bucket = json.hourly[local];
    assert.ok(bucket && bucket.visits >= 1, `local hour ${local} got the visit`);
    if (local !== expectedUtc) {
      const utcBucket = json.hourly[expectedUtc];
      assert.ok(
        !utcBucket || utcBucket.visits === 0,
        `UTC hour ${expectedUtc} must stay empty when the local hour differs`,
      );
    }
  } finally {
    proc.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fractional offset -330 shifts served hourly buckets and labels the heading', async () => {
  const dir = tmpdir();
  const p = port();
  const { proc } = await bootServer(dir, p, -330);
  try {
    // A half-hour offset buckets events into 60-minute slots starting at
    // :30-past-the-hour UTC; the served axis index (0..23) tracks the local
    // clock, exercising the non-hour remainder branch data-side.
    const res = await postJson(p, '/api/collect', pageview('/off/f'));
    assert.equal(res.status, 204, 'collect accepts the pageview');
    const json = JSON.parse((await get(p, '/api/overview')).text());
    const now = new Date();
    const local = localHour(now, -330);
    const bucket = json.hourly[local];
    assert.ok(bucket && bucket.visits >= 1, `local hour ${local} got the visit at offset -330`);
    const html = await get(p, '/');
    assert.match(html.text(), /<h3>Activity by hour \(UTC-5:30\)<\/h3>/, 'fractional offsets render h:mm');
  } finally {
    proc.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
