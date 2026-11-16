// Subprocess lifecycle tests: boot the real server binary (not the in-process
// test harness) to exercise the parts guarded behind the direct-run block in
// src/server.js — automatic retention pruning at startup and graceful SIGTERM
// shutdown. These also lock in the documented behavior (用户手册 §4.3) that the
// SQLite WAL/SHM auxiliary files are merged/removed on a clean stop.

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wa-life-'));
}

// Boot a fresh server subprocess in `dir` on `port`. Returns logs + pid once
// the server reports listening (poll /api/health).
function bootServer(dir, port, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const started = spawn(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', 'src/server.js'],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          WA_HOST: '127.0.0.1',
          WA_PORT: String(port),
          WA_DATA_DIR: dir,
          ...extraEnv,
        },
      },
    );
    let out = '';
    let err = '';
    started.stdout.on('data', (c) => (out += c));
    started.stderr.on('data', (c) => (err += c));
    const deadline = Date.now() + 10000;
    const poll = () => {
      http
        .get(`http://127.0.0.1:${port}/api/health`, (res) => {
          if (res.statusCode === 200) {
            resolve({ pid: started.pid, logs: () => out, stderr: () => err, proc: started });
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
    started.on('exit', (code) => reject(new Error(`server exited early (${code}):\n${out}\n${err}`)));
    poll();
  });
}

test('automatic retention prunes old events at startup', async () => {
  const dir = tmpdir();
  try {
    // Seed demo data (crosses 60 days), then boot with a 7-day retention window.
    await new Promise((resolve, reject) => {
      const seed = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/cli.js', 'seed'], {
        cwd: ROOT,
        env: { ...process.env, WA_DATA_DIR: dir },
      });
      seed.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`seed failed: ${code}`))));
    });
    const total = fs.readFileSync(path.join(dir, 'analytics.sqlite'));
    assert.ok(total.length > 0, 'seeded database exists');

    const { pid, logs } = await bootServer(dir, 8840, { WA_RETENTION_DAYS: '7' });
    // Give the startup prune a moment to finish.
    await new Promise((r) => setTimeout(r, 500));
    const logText = logs();
    const match = logText.match(/\[retention\] pruned (\d+) events older than \d+d/);
    assert.ok(match, `expected retention prune log, got:\n${logText}`);
    assert.ok(Number(match[1]) > 0, 'pruned a positive number of events');
    process.kill(pid, 'SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('graceful SIGTERM exits and merges the WAL (no -wal/-shm left)', async () => {
  const dir = tmpdir();
  let proc;
  try {
    const booted = await bootServer(dir, 8841);
    proc = booted.proc;
    const { pid, logs } = booted;
    // Force some WAL traffic so an uncheckpointed frame exists.
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`http://127.0.0.1:8841/api/collect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          path: `/wal-${Date.now()}${i}`,
          referrer: '',
          title: '',
          sw: 1920,
          sh: 1080,
          lang: 'en',
        }),
      });
      assert.equal(res.status, 204);
    }
    // SIGTERM should trigger a clean exit well inside the 3s force-exit window.
    process.kill(pid, 'SIGTERM');
    const exitCode = await Promise.race([
      new Promise((resolve) => proc.once('exit', (code) => resolve(code))),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 6000)),
    ]);
    assert.equal(exitCode, 0, `process exited after SIGTERM (got ${exitCode})`);
    const logText = logs();
    assert.match(logText, /received SIGTERM, shutting down/, `expected shutdown log, got:\n${logText}`);
    // WAL/SHM must be merged into the main DB on clean close.
    const files = fs.readdirSync(dir);
    assert.ok(files.some((f) => f === 'analytics.sqlite'), 'main DB exists');
    assert.ok(!files.some((f) => f.endsWith('-wal')), 'no -wal left after graceful stop');
    assert.ok(!files.some((f) => f.endsWith('-shm')), 'no -shm left after graceful stop');
    proc = null;
  } finally {
    if (proc) try { proc.kill('SIGKILL'); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
