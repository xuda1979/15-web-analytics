// Privacy audit report generation. Produces a human-readable + JSON summary
// of the data flow, schema, retention, and compliance posture.

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { SCHEMA } from './schema.js';

// The snippet's "~1KB budget". The status gate below fails the check when the
// served file is missing or exceeds this, matching what the report prose claims.
const SNIPPET_BUDGET_BYTES = 1024;

// Actual byte size of the served collector snippet, or null when the file is
// absent (so a future refactor can't silently desync report and reality). The
// catch also keeps an unstatable snippet (e.g. a WA_PUBLIC_DIR that does not
// resolve, or a filesystem error between existsSync and statSync) from
// panicking the whole report: the size gate reports the failure instead.
function snippetBytes() {
  try {
    const f = path.join(config.publicDir, 'wa.js');
    return fs.existsSync(f) ? fs.statSync(f).size : null;
  } catch {
    return null;
  }
}

// The snippet_size gate, factored out of the report so it can be tested for
// every branch (missing file / over budget / within budget) without re-booting
// the server. `byteCount` is the measured size (`snippetBytes`), `publicDir`
// is where the snippet is served from — used only for the detail message.
export function snippetSizeCheck(byteCount, publicDir) {
  if (byteCount === null) {
    return {
      status: 'fail',
      detail: `The served snippet (public/wa.js) could not be measured — the file is missing from ${publicDir}. A privacy-first tracker must actually ship the snippet it describes.`,
    };
  }
  if (byteCount > SNIPPET_BUDGET_BYTES) {
    return {
      status: 'fail',
      detail: `The served snippet (public/wa.js) is ${byteCount} bytes — over the ${SNIPPET_BUDGET_BYTES}-byte (~1KB) budget. The collect payload should stay minimal and cookie-less.`,
    };
  }
  return {
    status: 'pass',
    detail: `The served snippet (public/wa.js) is a single end-to-end JS file, ${fmtBytes(byteCount)} (${byteCount} bytes), within the ~1KB budget.`,
  };
}

// The ip_not_stored gate, factored out of the report so every branch is
// testable without booting the server. The status follows the live database,
// not just the config flag: `storeIp` enables cleartext storage, but rows with
// a non-NULL ip can also pre-exist under storeIp=0 (legacy WA_STORE_IP=1 runs,
// seeds, or manual edits) — and the "Raw IP addresses are never stored" claim
// must not be issued against a database that still holds them. `ipRows` is the
// report-time count of events with a stored ip, `totalEvents` the events count
// used to state the scanned population.
export function ipStoreCheck(storeIp, ipRows, totalEvents) {
  if (storeIp) {
    return {
      status: 'warn',
      detail: `WA_STORE_IP=1 is enabled: cleartext IP is stored in the events.ip column (${ipRows} of ${totalEvents} events carry one). Disable for a stricter posture.`,
    };
  }
  if (ipRows > 0) {
    return {
      status: 'fail',
      detail: `${ipRows} of ${totalEvents} events still carry a cleartext IP row under WA_STORE_IP=0 — left behind by an earlier WA_STORE_IP=1 run or a manual edit. Only the salted HMAC guest key should be persisted; delete the legacy rows (or re-create the database) so the no-storage claim holds against the live data.`,
    };
  }
  return {
    status: 'pass',
    detail: `The events table was scanned at report time: 0 of ${totalEvents} events carry a cleartext IP — raw IP addresses are never stored, only the salted HMAC guest key is persisted.`,
  };
}

// The data_retention gate, factored out of the report so every branch is
// testable without booting the server. The status must follow the live events
// table, not just echo the config flag: `retentionDays` selects the posture
// (automatic window vs manual-only), but the "events older than N days are
// pruned" claim only holds when the table actually lacks rows past the cutoff.
// `lastPrune` is meta.last_prune (recorded when a prune deleted rows),
// `oldestEventMs` the MIN(ts) of the live table (null when empty), `nowMs` the
// report-time clock used to derive the cutoff, `oldCount` the report-time
// count of events older than the cutoff, and `totalEvents` the events count
// used to state the scanned population.
export function retentionCheck(retentionDays, lastPrune, oldestEventMs, nowMs, oldCount = 0, totalEvents = 0) {
  const DAY_MS = 24 * 3600 * 1000;
  const lastRun = lastPrune
    ? `last automated prune: ${fmtDay(new Date(lastPrune).getTime())}`
    : 'no automated prune has ever run';
  if (retentionDays <= 0) {
    // Deliberate manual-prune posture (WA_RETENTION_DAYS=0 documented in the
    // README): never a violation of the config, but the detail reports the
    // oldest retained event so the operator sees what is actually kept.
    if (oldestEventMs === null) {
      return {
        status: 'pass',
        detail: 'Automatic pruning is disabled (WA_RETENTION_DAYS=0); no events have been recorded yet, so manual pruning (`npm run prune`) has nothing to trim.',
      };
    }
    return {
      status: 'pass',
      detail: `Automatic pruning is disabled (WA_RETENTION_DAYS=0) — a deliberate manual-prune posture. The oldest retained event dates to ${fmtDay(oldestEventMs)}; prune manually with npm run prune when it exceeds your retention needs.`,
    };
  }
  const cutoffMs = nowMs - retentionDays * DAY_MS;
  if (oldCount > 0) {
    return {
      status: 'fail',
      detail: `${oldCount} of ${totalEvents} events predate the ${retentionDays}-day retention window (cutoff ${fmtDay(cutoffMs)}) but still remain in the events table, contradicting the automatic-prune claim (startup + every 6h) and npm run prune; ${lastRun}. Run a prune so the retention claim holds against the live data.`,
    };
  }
  if (oldestEventMs === null) {
    return {
      status: 'pass',
      detail: `Events older than ${retentionDays} days are pruned automatically (startup + every 6h) and on demand via npm run prune; no events recorded yet; ${lastRun}.`,
    };
  }
  return {
    status: 'pass',
    detail: `Events older than ${retentionDays} days are pruned automatically (startup + every 6h) and on demand via npm run prune; the oldest retained event (${fmtDay(oldestEventMs)}) is inside the ${retentionDays}-day window (cutoff ${fmtDay(cutoffMs)}); ${lastRun}.`,
  };
}

function fmtDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

// Scan the shipped code for cookie machinery, so the "no cookies /
// identifiers" claim is verified at report time instead of asserted in
// prose. Translational writes (Set-Cookie) have to live in the server
// source, and client-side reads/writes (document.cookie, localStorage,
// sessionStorage) have to live in the collect snippet — both are static
// targets small enough to scan.
function cookieEvidence() {
  const targets = [
    {
      name: 'server source',
      file: path.join(import.meta.dirname, 'server.js'),
      pattern: /set-cookie/i,
    },
    {
      name: 'collect snippet',
      file: path.join(config.publicDir, 'wa.js'),
      pattern: /document\.cookie|\.cookie\s*=|localStorage|sessionStorage/i,
    },
  ];
  let files = 0;
  let lines = 0;
  const hits = [];
  for (const t of targets) {
    let text;
    try {
      text = fs.readFileSync(t.file, 'utf8');
    } catch {
      continue; // file absent — leave it out of the scanned set
    }
    files += 1;
    const fileLines = text.split('\n');
    lines += fileLines.length;
    fileLines.forEach((line, i) => {
      if (t.pattern.test(line)) hits.push(`${t.name}:${i + 1}: ${line.trim().slice(0, 90)}`);
    });
  }
  return { files, lines, hits };
}

// Scan the server-side source for outbound-transmission primitives, so the
// "storage locality" claim is verified at report time instead of asserted in
// prose. The client snippet (public/wa.js) is deliberately NOT scanned: its
// sendBeacon/XHR is the ingestion path (browser -> this server), the product's
// core function, not an off-box transfer.
function outboundEvidence(dir = import.meta.dirname) {
  let files = 0;
  let lines = 0;
  const hits = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    // The scanner's own source is skipped: its pattern is defined as a regex
    // literal below, which would always self-match and create a false hit.
    if (f === 'audit.js') continue;
    let text;
    try {
      text = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    files += 1;
    const fileLines = text.split('\n');
    lines += fileLines.length;
    const pattern =
      /fetch\s*\(|https?\s*\.\s*request\s*\(|net\.(createConnection|connect|Socket)\b|dgram\.(createSocket|send)\b|\bWebSocket\b|child_process|\.sendBeacon\(|XMLHttpRequest/;
    fileLines.forEach((line, i) => {
      if (pattern.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 90)}`);
    });
  }
  return { files, lines, hits };
}

// Scan the server source for precise-geolocation machinery, so the
// "region-level only" claim is verified at report time instead of asserted in
// prose. The product's region signal is the optional x-country request header
// read once in server.js (handleCollect) and stored in the events.country
// column; any geo-IP/lookup source would contradict that. The scanner skips
// its own source for the same self-match reason as outboundEvidence. Note the
// pattern deliberately omits the literal word "geolocation": server.js ships a
// Permissions-Policy: geolocation=() denial header, which is evidence FOR this
// check (browser geolocation is blocked), not a violation.
function regionEvidence(dir = import.meta.dirname) {
  let files = 0;
  let lines = 0;
  const hits = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    // The scanner's own source is skipped: its pattern is defined as a regex
    // literal below, which would always self-match and create a false hit.
    if (f === 'audit.js') continue;
    let text;
    try {
      text = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    files += 1;
    const fileLines = text.split('\n');
    lines += fileLines.length;
    const pattern =
      /geoip|geolite|maxmind|ip2location|ip-api|ipinfo|ipwhois|latitude|longitude/i;
    fileLines.forEach((line, i) => {
      if (pattern.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 90)}`);
    });
  }
  return { files, lines, hits };
}

export function generateAudit(db, opts = {}) {
  // `opts.srcDir` lets the src-tree scanners (outboundEvidence,
  // regionEvidence) run against a caller-supplied tree. Default is the real
  // source dir; tests use a throwaway copy so a sabotaged file can never race
  // sibling test processes importing a shared module (a live chmod 0o000 on
  // src/ua.js made parallel runs flake with EACCES).
  const srcDir = opts.srcDir ?? import.meta.dirname;
  const lastPrune = db
    .prepare(`SELECT value FROM meta WHERE key = 'last_prune'`)
    .get()?.value ?? null;
  const stats = db
    .prepare(`SELECT COUNT(*) AS events,
                     COUNT(*) FILTER (WHERE is_bot = 0) AS real_events,
                     COUNT(DISTINCT guest_key) AS guests,
                     MIN(ts) AS first_ts, MAX(ts) AS last_ts
              FROM events`)
    .get();
  // Retention posture verified against the live table: count the events that
  // predate the configured window (prune semantics: ts < cutoff) so the gate
  // can check the automatic-prune claim, not just echo WA_RETENTION_DAYS.
  const retentionOldCount =
    config.retentionDays > 0
      ? Number(
          db
            .prepare(`SELECT COUNT(*) AS n FROM events WHERE ts < ?`)
            .get(Date.now() - config.retentionDays * 24 * 3600 * 1000).n,
        )
      : 0;
  const ipEvents = db
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE ip IS NOT NULL`)
    .get().n;
  const tableRows = db
    .prepare(`SELECT name, (SELECT COUNT(*) FROM pragma_table_info(name)) AS cols
              FROM sqlite_master WHERE type='table' ORDER BY name`)
    .all();
  // Scan the live schema for personal-identifier columns so the "no personal
  // fields" claim is verified at report time instead of asserted in prose.
  // sqlite_* tables (e.g. sqlite_sequence, created by AUTOINCREMENT) are
  // SQLite bookkeeping internals, not part of the application schema, so they
  // are excluded from the scan and the table listing.
  const appTables = tableRows.filter((t) => !t.name.startsWith('sqlite_'));
  const columnNames = [];
  for (const t of appTables) {
    for (const c of db.prepare(`SELECT name FROM pragma_table_info(?)`).all(t.name)) {
      columnNames.push(c.name);
    }
  }
  const personalColumns = columnNames.filter((c) =>
    /name|email|phone|mobile|tel\b|wechat|qq|id_card|id_number|identity|credential|token|birth/i.test(c),
  );
  // dbstat is a compile-time option; guard for trimmed Node builds.
  let dbBytes = 0;
  try {
    dbBytes = Number(
      db.prepare(`SELECT COALESCE(SUM(pgsize), 0) AS bytes FROM dbstat`).get().bytes,
    );
  } catch {
    dbBytes = 0;
  }

  const snippetByteCount = snippetBytes();

  const cookie = cookieEvidence();
  const outbound = outboundEvidence(srcDir);
  const region = regionEvidence(srcDir);

  const checks = [
    {
      id: 'no_cookies',
      label: 'Cookies / identifiers',
      status: cookie.hits.length ? 'fail' : 'pass',
      detail: cookie.hits.length
        ? `Cookie/local-storage machinery found in shipped code: ${cookie.hits.join('; ')}. A cookie-less tracker must not touch these APIs.`
        : `No Set-Cookie writes in the server source and no cookie/localStorage API use in the collect snippet (scanned ${cookie.files} files, ${cookie.lines} lines). No tracking ID is issued; identity is reconstructed from an HMAC of ip+ua keyed with a local secret.`,
    },
    {
      id: 'no_personal_fields',
      label: 'Personal fields',
      status: personalColumns.length ? 'fail' : 'pass',
      detail: personalColumns.length
        ? `Schema contains columns that look like personal identifiers: ${personalColumns.join(', ')}. Remove them for a privacy-first tracker.`
        : `Schema scanned at report time: ${appTables.length} tables, ${columnNames.length} columns; no name, email, phone, or other personal identifier columns found.`,
    },
    {
      id: 'ip_not_stored',
      label: 'Raw IP storage',
      ...ipStoreCheck(config.storeIp, Number(ipEvents), Number(stats.events)),
    },
    {
      id: 'snippet_size',
      label: 'Collector snippet size',
      ...snippetSizeCheck(snippetByteCount, config.publicDir),
    },
    {
      id: 'region_only',
      label: 'Country detection level',
      status: region.hits.length ? 'fail' : 'pass',
      detail: region.hits.length
        ? `Precise-geolocation machinery found in server source: ${region.hits.join('; ')}. A privacy-first tracker should only use the region-level signal.`
        : `Region is derived only from the optional x-country HTTP header at collect time (server.js handleCollect); no precise-geolocation machinery in the server source (scanned ${region.files} files, ${region.lines} lines).`,
    },
    {
      id: 'local_storage',
      label: 'Storage locality',
      status: outbound.hits.length ? 'fail' : 'pass',
      detail: outbound.hits.length
        ? `Outbound-transmission primitive${outbound.hits.length > 1 ? 's' : ''} found in server source: ${outbound.hits.join('; ')}. A self-hosted tracker should only answer inbound requests.`
        : `All data lives in a single local SQLite file (${config.dbPath}). No outbound transmission primitives in the server source (scanned ${outbound.files} files, ${outbound.lines} lines); nothing is transmitted off the box.`,
    },
    {
      id: 'data_retention',
      label: 'Data retention',
      ...retentionCheck(
        config.retentionDays,
        lastPrune,
        stats.first_ts ?? null,
        Date.now(),
        retentionOldCount,
        Number(stats.events),
      ),
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
    tables: appTables,
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
      retention_days: config.retentionDays,
      last_prune: lastPrune,
    },
    checks,
    pass_count: checks.filter((c) => c.status === 'pass').length,
    warn_count: checks.filter((c) => c.status === 'warn').length,
  };
}
