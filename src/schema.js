// Database schema for 15-web-analytics.
//
// Design notes:
//  - `events` is the append-only raw store (the "source of truth").
//  - `agg_daily*` and `agg_weekly*` tables are denormalized aggregate caches
//    kept in sync on write; today they back only the daily/weekly/monthly
//    series reads (top lists always scan raw events).
//  - Per privacy defaults the IP is stored only as a salted HMAC digest
//    (`guest_key`) unless WA_STORE_IP=1.

export const SCHEMA_TABLES = `
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,        -- epoch ms per PAGEVIEW in a visit
  visited_at TEXT    NOT NULL,        -- ISO-8601 UTC, no sub-second
  guest_key  TEXT    NOT NULL,        -- salted HMAC of ip+ua (never the IP)
  ip         TEXT,                    -- cleartext IP; NULL unless STORE_IP
  ua         TEXT    NOT NULL,
  path       TEXT    NOT NULL,
  referrer   TEXT,
  ref_domain TEXT,                    -- normalized referrer host
  title      TEXT,
  screen_w   INTEGER,
  screen_h   INTEGER,
  lang       TEXT,
  country    TEXT,                    -- region-level only (from x-country)
  visit_key  INTEGER,                 -- ts of the visit's FIRST event (same for every event in a visit)
  entry_path TEXT,                    -- first path of the visit
  exit_path  TEXT,                    -- last path of the visit
  browser    TEXT,
  browser_version TEXT,
  device     TEXT,
  device_model TEXT,       -- e.g. "Pixel 8"; '' when the UA carries no model
  os         TEXT,
  is_bot     INTEGER NOT NULL DEFAULT 0
);

-- Daily aggregate caches (cache of last agg run; rebuilt incrementally).
-- NOTE: only the realtime (per-minute) series is cached today. The per-dimension
-- daily caches (pages/sources/devices/browsers) were removed - all top-list
-- breakdowns read the raw events table (topPages & co.), so the per-insert
-- upserts were pure write amplification with no read path. Entries/exits are
-- likewise derived from raw events (entryExitPages/entryExitFiltered).
CREATE TABLE IF NOT EXISTS agg_daily_realtime (
  day        TEXT NOT NULL,
  bucket1m   INTEGER NOT NULL,     -- epoch ms floored to the minute
  visits     INTEGER NOT NULL DEFAULT 0,
  uniques    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, bucket1m)
);
CREATE TABLE IF NOT EXISTS agg_monthly_buckets (
  yyyymm  TEXT NOT NULL,
  bucket  TEXT NOT NULL DEFAULT 'week',   -- 'week' | 'month'
  start   INTEGER NOT NULL,        -- bucket start epoch ms
  visits  INTEGER NOT NULL DEFAULT 0,
  uniques INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (yyyymm, bucket, start)
);

-- Minimal key/value meta.
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

export const SCHEMA_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_events_ts      ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_guest   ON events(guest_key, ts);
-- Composite (path, ts): page-filtered reads seek within the queried window
-- instead of scanning the path's full history (the single-column path index
-- beat the ts index and ignored the window entirely). The composite also
-- covers bare path=? lookups, so no separate single-column index is needed.
CREATE INDEX IF NOT EXISTS idx_events_path_ts ON events(path, ts);
CREATE INDEX IF NOT EXISTS idx_events_visit   ON events(visit_key);
CREATE INDEX IF NOT EXISTS idx_agg_realtime_bucket ON agg_daily_realtime(bucket1m);
`;

// Full schema string (tables + indexes) for fresh installs and the audit report.
export const SCHEMA = SCHEMA_TABLES + SCHEMA_INDEXES;
