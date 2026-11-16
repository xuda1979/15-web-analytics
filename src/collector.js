// Visit collection: payload parsing, unique-visitor heuristic, and
// write-through aggregate cache updates.

import { config } from './config.js';
import { hashGuest } from './privacy.js';
import { parseUa, isBot } from './ua.js';
import { dayKey, monthKey, monthStart, weekStart } from './store.js';

function clampInteger(v) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(0, n) : undefined;
}

// Normalize a referrer to just its host (drop query/fragment/path).
export function referrerDomain(referrer) {
  if (!referrer) return null;
  try {
    return new URL(referrer).hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

// Parse a raw collect payload into a normalized event object.
export function normalizeEvent(payload, meta, secret) {
  const ua = meta.ua || payload.ua || '';
  const ip = meta.ip || payload.ip || '';
  const now = meta.ts || Date.now();
  const parsed = parseUa(ua);
  const visitedAt = new Date(now).toISOString();

  return {
    ts: now,
    visited_at: visitedAt, // full ISO with ms; store raw
    guest_key: hashGuest(ip, ua, secret),
    ip: config.storeIp ? ip.slice(0, 64) : null,
    ua: ua.slice(0, 500),
    path: String(payload.path || '/').slice(0, 512),
    referrer: String(payload.referrer || '').slice(0, 600),
    ref_domain: referrerDomain(payload.referrer),
    title: String(payload.title || '').slice(0, 300),
    screen_w: clampInteger(payload.sw),
    screen_h: clampInteger(payload.sh),
    lang: String(payload.lang || '').slice(0, 20),
    country:
      String(meta.country || payload.country || '').slice(0, 8) || null,
    browser: parsed.browser,
    browser_version: parsed.browserVersion,
    device: parsed.device,
    device_model: parsed.deviceModel,
    os: parsed.os,
    is_bot: isBot(ua) ? 1 : 0,
  };
}

// Insert a normalized event and update aggregate caches. Returns {id}.
export function insertEvent(db, event) {
  const windowMs = config.visitWindowMs;
  const isUnique =
    event.is_bot === 0 &&
    (() => {
      const prev = db
        .prepare(
          `SELECT ts FROM events
            WHERE guest_key = ? AND is_bot = 0
            ORDER BY ts DESC LIMIT 1`,
        )
        .get(event.guest_key);
      if (!prev) return true;
      return event.ts - prev.ts > windowMs;
    })();

  // Decide entry/exit edges for this event's visit.
  let entryPath = null;
  let exitPath = null;
  let visitKey = null;
  if (event.is_bot === 0) {
    if (isUnique) {
      // New visit starts here; its first-event ts IS the visit key.
      visitKey = event.ts;
      entryPath = event.path;
      exitPath = event.path;
    } else {
      // Continuing visit — reuse previous event's visit key + entry.
      const prev = db
        .prepare(
          `SELECT visit_key, entry_path FROM events
            WHERE guest_key = ? AND is_bot = 0
            ORDER BY ts DESC LIMIT 1`,
        )
        .get(event.guest_key);
      visitKey = (prev && prev.visit_key) || event.ts;
      entryPath = (prev && prev.entry_path) || event.path;
      exitPath = event.path;
    }
  }

  const stmt = db.prepare(`
    INSERT INTO events
      (ts, visited_at, guest_key, ip, ua, path, referrer, ref_domain,
       title, screen_w, screen_h, lang, country, browser, browser_version,
       device, device_model, os, is_bot, visit_key, entry_path, exit_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // node:sqlite refuses to bind `undefined`; use NULL for absent optionals.
  const bind = (v) => (v === undefined ? null : v);
  const res = stmt.run(
    event.ts,
    event.visited_at,
    event.guest_key,
    bind(event.ip),
    event.ua,
    event.path,
    bind(event.referrer),
    bind(event.ref_domain),
    bind(event.title),
    bind(event.screen_w),
    bind(event.screen_h),
    bind(event.lang),
    bind(event.country),
    event.browser,
    bind(event.browser_version),
    event.device,
    bind(event.device_model),
    event.os,
    event.is_bot,
    bind(visitKey),
    bind(entryPath),
    bind(exitPath),
  );
  const id = Number(res.lastInsertRowid);

  // --- Incremental aggregate caches (write-through) ---
  // Bots are excluded from all metrics (totals, series, top lists), so they
  // must not pollute the caches either — otherwise daily/weekly/realtime
  // views would disagree with the raw-event totals.
  if (event.is_bot === 0) {
    const dk = dayKey(event.ts);
    const uniqDelta = isUnique ? 1 : 0;

    // NOTE: the per-dimension daily caches (pages/sources/devices/browsers)
    // were removed — every top-list breakdown reads the raw events table, so
    // those per-insert upserts were dead writes. Entry/exit edges are likewise
    // per-VISIT and counted from raw events (entryExitPages/entryExitFiltered).
    // Only the realtime + weekly/monthly series keep write-through caches.

    // realtime per-minute buckets
    const bm = Math.floor(event.ts / 60_000) * 60_000;
    db.prepare(
      `INSERT INTO agg_daily_realtime(day, bucket1m, visits, uniques)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(day, bucket1m) DO UPDATE SET
         visits = visits + 1, uniques = uniques + excluded.uniques`,
    ).run(dk, bm, uniqDelta);

    // weekly buckets (UTC Monday-based)
    const ws = weekStart(event.ts);
    db.prepare(
      `INSERT INTO agg_monthly_buckets(yyyymm, bucket, start, visits, uniques)
       VALUES (?, 'week', ?, 1, ?)
       ON CONFLICT(yyyymm, bucket, start) DO UPDATE SET
         visits = visits + 1, uniques = uniques + excluded.uniques`,
    ).run(monthKey(event.ts), ws.getTime(), uniqDelta);

    // monthly buckets (UTC month-aligned)
    const ms = monthStart(event.ts);
    db.prepare(
      `INSERT INTO agg_monthly_buckets(yyyymm, bucket, start, visits, uniques)
       VALUES (?, 'month', ?, 1, ?)
       ON CONFLICT(yyyymm, bucket, start) DO UPDATE SET
         visits = visits + 1, uniques = uniques + excluded.uniques`,
    ).run(monthKey(event.ts), ms.getTime(), uniqDelta);
  } // end is_bot === 0

  return { id, isUnique };
}

// Recompute entry/exit edges for all non-bot events since `sinceMs`,
// honoring the visit window. Called periodically to keep edges accurate as
// sessions lengthen. Cheap for the fixture scale, and bounded by time range.
export function refreshEntryExit(db, sinceMs = Date.now() - 24 * 3600 * 1000) {
  db.exec('BEGIN');
  try {
    refreshEntryExitCore(db, sinceMs);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// The core edge-refresh routine without transaction management, so callers
// that already hold a transaction (e.g. pruneEvents) can reuse the exact same
// logic without nesting BEGIN/COMMIT.
export function refreshEntryExitCore(db, sinceMs) {
  const rows = db
    .prepare(
      `SELECT id, guest_key, ts, path, visit_key FROM events
        WHERE ts >= ? AND is_bot = 0
        ORDER BY guest_key, ts`,
    )
    .all(sinceMs);

  const byGuest = new Map();
  for (const r of rows) {
    if (!byGuest.has(r.guest_key)) byGuest.set(r.guest_key, []);
    byGuest.get(r.guest_key).push(r);
  }

  const update = db.prepare(
    `UPDATE events SET entry_path = ?, exit_path = ?,
                      visit_key = CASE WHEN visit_key IS NULL THEN ? ELSE visit_key END
     WHERE id = ?`,
  );
  // The visit key is the first event's ts; backfill it for legacy/imported
  // rows so entry/exit distinct-counting stays exact even before a refresh.
  const updateVisitKey = db.prepare(
    'UPDATE events SET visit_key = ? WHERE id = ?',
  );
  const setVisitKey = (frame, keyTs) => {
    for (const row of frame) {
      if (row.visit_key === null || row.visit_key === undefined) {
        updateVisitKey.run(keyTs, row.id);
        row.visit_key = keyTs;
      }
    }
  };

  // Aggregated entry/exit counts are computed by `entryExitPages` with
  // COUNT(DISTINCT visit_key), so they cannot drift: every non-bot event that
  // started a visit carries a distinct visit_key, and an event that merely
  // continues a visit points at the same key. refreshEntryExit only needs to
  // keep the per-event columns accurate for raw exports and candidate reads.
  for (const all of byGuest.values()) {
    let start = 0;
    for (let i = 1; i <= all.length; i++) {
      const gap = i < all.length ? all[i].ts - all[i - 1].ts : Infinity;
      if (gap <= config.visitWindowMs && i < all.length) continue;
      const frame = all.slice(start, i);
      start = i;
      if (!frame.length) continue;
      const entry = frame[0].path;
      const exit = frame[frame.length - 1].path;
      for (const row of frame) {
        if (row.entry_path !== entry || row.exit_path !== exit) {
          update.run(entry, exit, row.visit_key, row.id);
        }
      }
      setVisitKey(frame, frame[0].ts);
    }
  }
}
