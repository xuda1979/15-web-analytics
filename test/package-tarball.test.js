// npm tarball allowlist test: bf7bf2e restricted the publish surface to
// src, public, README.md and LICENSE (the `files` field in package.json) so
// an npm publish can never leak the test/ tree or the software-copyright
// filing directory (15-web-analytics-软件著作权申请, ~128 kB of 源代码.txt).
//
// This test is the regression guard for that guarantee. `npm pack` is the
// single source of truth for what would ship (it honors .npmignore and the
// `files` allowlist), so we dry-run it in a scratch cwd and assert the
// resulting file list exactly. The assertions are structural invariants of
// the packaging change, not a diff of today's glob — they fail open (with
// the whole list in the message) on any drift. The `public/` and `src/`
// assertions are intentionally exact entries/order (alphabetical, npm
// deterministic) so the golden list doubles as a distribution manifest.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

test('npm pack ships exactly the allowlisted files and nothing else', () => {
  // npm pack needs a cwd; pack from the repo root, but keep any real
  // tarball out of the repo by pointing --pack-destination at a temp dir.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-npm-pack-'));
  try {
    const res = spawnSync('npm', ['pack', '--dry-run', '--json', '--pack-destination', tmp], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60_000,
    });
    assert.equal(res.status, 0, `npm pack failed: ${res.stderr}`);
    const summary = JSON.parse(res.stdout)[0];
    const files = summary.files.map((f) => f.path).sort();

    // The exact golden manifest — adds to src/ or public/ must extend it.
    assert.deepEqual(
      files,
      [
        'LICENSE',
        'README.md',
        'package.json',
        'public/index.html',
        'public/style.css',
        'public/wa.js',
        'src/analytics.js',
        'src/audit.js',
        'src/cli.js',
        'src/collector.js',
        'src/config.js',
        'src/exporter.js',
        'src/privacy.js',
        'src/ratelimit.js',
        'src/retention.js',
        'src/schema.js',
        'src/server.js',
        'src/store.js',
        'src/ua.js',
      ].sort(),
      `tarball manifest drifted — got:\n${files.join('\n')}`,
    );

    // The distribution-safety invariants, spelled out so the intent is
    // readable even if the golden list above changes with a new src file.
    assert.ok(!files.some((f) => f.startsWith('test/')), 'test/ never ships');
    assert.ok(
      !files.some((f) => f.includes('软件著作权申请')),
      'the software-copyright filing directory never ships',
    );
    assert.ok(!files.includes('SPEC.md'), 'the internal spec never ships');
    assert.ok(files.includes('LICENSE'), 'the MIT license always ships (MIT §1)');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
