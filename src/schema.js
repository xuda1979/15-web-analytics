// Database schema for 15-web-analytics.
//
// Design notes:
//  - `events` is the append-only raw store (the "source of truth").
//  - `agg_daily*` and `agg_weekly*` tables are denormalized aggregate caches.
//    They are rebuilt on demand (upsert per event) so that queries never need
//    to scan raw events, keeping dashboard reads fast on large data sets.
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
  os         TEXT,
  is_bot     INTEGER NOT NULL DEFAULT 0
);

-- Daily aggregate caches (cache of last agg run; rebuilt incrementally).
-- NOTE: entries/exits are NOT cached here - entry/exit counts are derived
-- from the raw events table (entryExitPages/entryExitFiltered), so those
-- columns were removed to avoid dead writes on the insert path.
CREATE TABLE IF NOT EXISTS agg_daily_pages (
  d         TEXT NOT NULL,
  path      TEXT NOT NULL,
  visits    INTEGER NOT NULL DEFAULT 0,
  uniques   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (d, path)
);
CREATE TABLE IF NOT EXISTS agg_daily_sources (
  d         TEXT NOT NULL,
  source    TEXT NOT NULL,
  visits    INTEGER NOT NULL DEFAULT 0,
  uniques   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (d, source)
);
CREATE TABLE IF NOT EXISTS agg_daily_devices (
  d         TEXT NOT NULL,
  kind      TEXT NOT NULL,
  visits    INTEGER NOT NULL DEFAULT 0,
  uniques   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (d, kind)
);
CREATE TABLE IF NOT EXISTS agg_daily_browsers (
  d         TEXT NOT NULL,
  browser   TEXT NOT NULL,
  visits    INTEGER NOT NULL DEFAULT 0,
  uniques   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (d, browser)
);
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
CREATE INDEX IF NOT EXISTS idx_events_ts     ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_guest  ON events(guest_key, ts);
CREATE INDEX IF NOT EXISTS idx_events_path   ON events(path);
CREATE INDEX IF NOT EXISTS idx_events_visit  ON events(visit_key);
`;

// Full schema string (tables + indexes) for fresh installs and the audit report.
export const SCHEMA = SCHEMA_TABLES + SCHEMA_INDEXES;
