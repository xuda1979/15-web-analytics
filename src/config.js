// Central configuration for 15-web-analytics.
// Every tunable is overridable via environment variable so the server can run
// fully self-contained with sensible defaults.

import path from 'node:path';
import fs from 'node:fs';

function bool(value, fallback) {
  if (value === undefined) return fallback;
  const v = String(value).trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return fallback;
}

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

const root = path.resolve(import.meta.dirname, '..');

export const config = {
  host: process.env.WA_HOST || '127.0.0.1',
  port: int(process.env.WA_PORT, 8787),

  // Data directory. Defaults to ./data under the project root.
  dataDir: path.resolve(process.env.WA_DATA_DIR || path.join(root, 'data')),
  dbPath: path.resolve(
    process.env.WA_DB_PATH ||
      (process.env.WA_DATA_DIR
        ? path.join(process.env.WA_DATA_DIR, 'analytics.sqlite')
        : path.join(root, 'data', 'analytics.sqlite')),
  ),

  // Unique-visitor heuristic tuning. The guest key = hash(ip | ua | salt),
  // then a unique visitor is recorded when the previous event for the same
  // guest is older than `visitWindowMs`.
  visitWindowMs: int(process.env.WA_VISIT_WINDOW_MS, 1000 * 60 * 30),
  hashSalt: process.env.WA_HASH_SALT || 'wa-local-salt',

  // Privacy: by default the raw IP address is NEVER stored. Only an HMAC
  // hash (keyed with the local salt) is persisted. Set to "1" at your own
  // risk to store the cleartext IP — the privacy audit endpoint will flag it.
  storeIp: bool(process.env.WA_STORE_IP, false),

  // Real-time window (ms). Realtime endpoint trees events younger than this.
  realtimeWindowMs: int(process.env.WA_REALTIME_WINDOW_MS, 1000 * 60 * 5),

  // Collect rate limiting: max POSTs per IP per window. 0 disables.
  collectRateLimit: int(process.env.WA_COLLECT_RATE_LIMIT, 60),
  collectRateWindowMs: int(process.env.WA_COLLECT_RATE_WINDOW_MS, 60_000),

  snippetPath: process.env.WA_SNIPPET_PATH || '/wa.js',
  collectPath: process.env.WA_COLLECT_PATH || '/api/collect',
  overviewPath: process.env.WA_OVERVIEW_PATH || '/api/overview',
  realtimePath: process.env.WA_REALTIME_PATH || '/api/realtime',
  exportPath: process.env.WA_EXPORT_PATH || '/api/export',
  auditPath: process.env.WA_AUDIT_PATH || '/api/audit',

  // Static dashboard is served from public/.
  publicDir: path.resolve(process.env.WA_PUBLIC_DIR || path.join(root, 'public')),
};

export function ensureDataDir() {
  fs.mkdirSync(config.dataDir, { recursive: true });
}
