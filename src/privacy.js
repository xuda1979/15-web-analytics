// Privacy helpers: keyed identity hashing, IP redaction for reports, and
// storage of a per-server secret used to key the hash.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Deterministic secret persisted next to the DB. Regenerating it changes
// every guest_key, which is fine: unique data is derived from fresh events.
export function loadOrCreateSecret(dataDir) {
  const secretFile = path.join(dataDir, '.wa_secret');
  try {
    const existing = fs.readFileSync(secretFile, 'utf8').trim();
    if (existing) return existing;
  } catch {
    /* not present yet */
  }
  const secret =
    config.hashSalt !== 'wa-local-salt'
      ? crypto.createHash('sha256').update(config.hashSalt).digest('hex')
      : crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretFile, secret, { mode: 0o600 });
  return secret;
}

// HMAC-SHA256 hex digest of `ip|ua` keyed by the local secret. The output is
// irreversible without the server secret. IP bytes never touch the DB.
export function hashGuest(ip, ua, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update([ip ?? '', ua ?? ''].join('|'))
    .digest('hex');
}

// Anonymize an IP for privacy-report / export views. Public heuristics
// (IPv4 last octet -> x, IPv6 keep first 3 hextets) applied BEFORE any
// storage consideration, used for redacted exports.
export function anonymizeIp(ip) {
  if (!ip) return '';
  if (ip.includes(':')) {
    const parts = ip.split(':');
    return `${parts.slice(0, 3).join(':')}:xxxx:xxxx:xxxx:xxxx`;
  }
  const parts = ip.split('.');
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.x`;
  return '<redacted>';
}
