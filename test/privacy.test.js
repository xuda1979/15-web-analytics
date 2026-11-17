// Privacy helpers are the identity secret behind every guest_key and the
// redaction gate on every exported row, yet no test imported privacy.js
// directly — loadOrCreateSecret was only seen as a fixture in the
// aggregation/entryexit/monthly/retention suites. These tests pin the
// anonymizeIp() redaction contract (what, exactly, leaves the server) and
// the hashGuest() HMAC contract (deterministic, keyed, input-splitting) on
// which unique-visitor math depends.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { anonymizeIp, hashGuest, loadOrCreateSecret } from '../src/privacy.js';

test('anonymizeIp redacts the IPv4 last octet', () => {
  assert.equal(anonymizeIp('203.0.113.42'), '203.0.113.x');
  assert.equal(anonymizeIp('127.0.0.1'), '127.0.0.x');
});

test('anonymizeIp keeps only the first three IPv6 hextets', () => {
  assert.equal(
    anonymizeIp('2001:db8:85a3:0:0:8a2e:370:7334'),
    '2001:db8:85a3:xxxx:xxxx:xxxx:xxxx',
  );
});

test('anonymizeIp survives a short loopback IPv6 without leaking a full address', () => {
  // '::1' has fewer than three hextets; the loopback prefix is not sensitive
  // and the redaction still masks every address-bearing hextet.
  assert.equal(anonymizeIp('::1'), '::1:xxxx:xxxx:xxxx:xxxx');
  assert.equal(anonymizeIp('fe80::1'), 'fe80::1:xxxx:xxxx:xxxx:xxxx');
});

test('anonymizeIp falls back for non-IPs and returns empty for absent IPs', () => {
  assert.equal(anonymizeIp('4.4.4'), '<redacted>', 'short IPv4 is not a valid address');
  assert.equal(anonymizeIp('not-an-ip'), '<redacted>');
  assert.equal(anonymizeIp(''), '', 'empty IP stays empty');
  assert.equal(anonymizeIp(null), '', 'missing IP stays empty');
});

test('hashGuest returns a 64-hex digest, deterministic per input and secret', () => {
  const secret = 'privacy-test-secret';
  const d1 = hashGuest('203.0.113.7', 'Mozilla/x', secret);
  const d2 = hashGuest('203.0.113.7', 'Mozilla/x', secret);
  assert.match(d1, /^[0-9a-f]{64}$/, 'SHA-256 hex digest');
  assert.equal(d1, d2, 'same ip+ua+secret repeats exactly');
});

test('hashGuest changes with the UA and with the secret', () => {
  const secret = 'privacy-test-secret';
  const base = hashGuest('203.0.113.7', 'Mozilla/x', secret);
  assert.notEqual(hashGuest('203.0.113.7', 'Mozilla/y', secret), base, 'ua is part of the key');
  assert.notEqual(hashGuest('203.0.113.7', 'Mozilla/x', 'other-secret'), base, 'secret keys the digest');
});

test('hashGuest treats missing ip/ua exactly like empty strings', () => {
  const secret = 'privacy-test-secret';
  assert.equal(
    hashGuest('10.0.0.1', null, secret),
    hashGuest('10.0.0.1', '', secret),
    'null ua hashes as empty ua',
  );
  assert.equal(
    hashGuest(null, 'UA', secret),
    hashGuest('', 'UA', secret),
    'null ip hashes as empty ip',
  );
  assert.equal(hashGuest(undefined, undefined, secret), hashGuest('', '', secret));
});

test('loadOrCreateSecret persists a stable 0600 secret across calls', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-priv-'));
  try {
    const a = loadOrCreateSecret(dir);
    const b = loadOrCreateSecret(dir);
    assert.match(a, /^[0-9a-f]{64}$/, 'generated secret is a 64-hex digest');
    assert.equal(a, b, 're-reading the store returns the same secret (guest keys stay stable)');
    const file = path.join(dir, '.wa_secret');
    assert.ok(fs.existsSync(file), 'secret file is written to the data dir');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'secret file is owner-readable only');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
