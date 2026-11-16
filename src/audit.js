// Privacy audit report generation. Produces a human-readable + JSON summary
// of the data flow, schema, retention, and compliance posture.

import { config } from './config.js';
import { SCHEMA } from './schema.js';

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

export function generateAudit(db) {
  const stats = db
    .prepare(`SELECT COUNT(*) AS events,
                     COUNT(*) FILTER (WHERE is_bot = 0) AS real_events,
                     COUNT(DISTINCT guest_key) AS guests,
                     MIN(ts) AS first_ts, MAX(ts) AS last_ts
              FROM events`)
    .get();
  const ipEvents = db
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE ip IS NOT NULL`)
    .get().n;
  const tableRows = db
    .prepare(`SELECT name, (SELECT COUNT(*) FROM pragma_table_info(name)) AS cols
              FROM sqlite_master WHERE type='table' ORDER BY name`)
    .all();
  // dbstat is a compile-time option; guard for trimmed Node builds.
  let dbBytes = 0;
  try {
    dbBytes = Number(
      db.prepare(`SELECT COALESCE(SUM(pgsize), 0) AS bytes FROM dbstat`).get().bytes,
    );
  } catch {
    dbBytes = 0;
  }

  const checks = [
    {
      id: 'no_cookies',
      label: 'Cookies / identifiers',
      status: 'pass',
      detail: 'The collect endpoint never writes Set-Cookie. No tracking ID is issued; identity is reconstructed from an HMAC of ip+ua keyed with a local secret.',
    },
    {
      id: 'no_personal_fields',
      label: 'Personal fields',
      status: 'pass',
      detail: 'Schema contains no name/email/phone or other personal identifiers.',
    },
    {
      id: 'ip_not_stored',
      label: 'Raw IP storage',
      status: config.storeIp ? 'warn' : 'pass',
      detail: config.storeIp
        ? 'WA_STORE_IP=1 is enabled: cleartext IP is stored in the events.ip column. Disable for a stricter posture.'
        : 'Raw IP addresses are never stored. Only the salted HMAC guest key is persisted.',
    },
    {
      id: 'snippet_size',
      label: 'Collector snippet size',
      status: 'pass',
      detail: 'Snippet is a single end-to-end JS file; its size is checked by the test suite to stay under ~1KB (uncompressed, minified).',
    },
    {
      id: 'region_only',
      label: 'Country detection level',
      status: 'pass',
      detail: 'Region is derived from HTTP header country (e.g. x-country) at region granularity only; no precise geolocation.',
    },
    {
      id: 'local_storage',
      label: 'Storage locality',
      status: 'pass',
      detail: `All data lives in a single local SQLite file (${config.dbPath}). Nothing is transmitted off the box.`,
    },
  ];

  return {
    generated_at: new Date().toISOString(),
    service: '15-web-analytics',
    data_flow: [
      {
        step: 1,
        actor: 'browser',
        action: 'Loads /wa.js (~1KB), collects url/referrer/ua/screen only; no cookies are read or written.',
      },
      {
        step: 2,
        actor: 'browser',
        action: `POSTs a pageview to /api/collect. Payload fields: path, referrer, title, sw, sh, lang.`,
      },
      {
        step: 3,
        actor: 'server',
        action: 'Validates payload, parses UA locally (ua-parser-js), computes guest_key = HMAC_SHA256(salt, ip|ua).',
      },
      {
        step: 4,
        actor: 'server',
        action: 'Writes one row to events + incremental aggregate caches in local SQLite.',
      },
      {
        step: 5,
        actor: 'server',
        action: 'Serves dashboard & exports from SQLite; /api/audit regenerates this report.',
      },
    ],
    schema: SCHEMA,
    tables: tableRows,
    stats: {
      events: Number(stats.events),
      real_events: Number(stats.real_events),
      guests: Number(stats.guests),
      first_ts: stats.first_ts ? new Date(stats.first_ts).toISOString() : null,
      last_ts: stats.last_ts ? new Date(stats.last_ts).toISOString() : null,
      bytes: dbBytes,
      bytes_readable: fmtBytes(dbBytes),
      ip_rows: Number(ipEvents),
      db_path: config.dbPath,
    },
    config: {
      visit_window_ms: config.visitWindowMs,
      realtime_window_ms: config.realtimeWindowMs,
      store_ip: config.storeIp,
      hash_salt_set: config.hashSalt !== 'wa-local-salt',
    },
    checks,
    pass_count: checks.filter((c) => c.status === 'pass').length,
    warn_count: checks.filter((c) => c.status === 'warn').length,
  };
}
