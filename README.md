# 15-web-analytics

Cookie-less, privacy-friendly website analytics for the China market
(a Plausible / Fathom slice). Fully self-hosted: one Node.js process, one
local SQLite file, no third-party services.

## Why

- **No cookies, no tracking IDs.** The collect endpoint never writes
  `Set-Cookie`; the snippet reads nothing off the device. Unique visitors are
  estimated locally with a privacy-safe heuristic.
- **No personal data.** No name / email / phone fields in the schema. The raw
  IP address is never stored by default — a salted HMAC of `ip|ua` is kept as
  an irreversible guest key. Region is captured at country granularity only.
- **Local by design.** Everything runs on your own box, which simplifies
  China's personal-information-protection requirements and keeps you in
  control of data flow and retention.

## Features

- Lightweight (~1KB) collect snippet that reports `path`, `referrer`, `title`,
  `screen`, and `lang` via `sendBeacon`/XHR.
- Pageviews, unique visitors (IP-hash + UA + 30min visit window heuristic),
  bounce rate, average visit duration, sources, devices, device models,
  browsers (with the dominant version, e.g. "Chrome 120"), countries, operating
  systems, visitor languages, screen sizes (top lists pair every visit count
  with the distinct uniques behind it), visits by hour of day (UTC,
  pageviews + distinct uniques per hour), referring pages, page titles, and
  entry/exit pages (each also paired with the distinct uniques landing on /
  leaving from it).
- Real-time view (last 5 minutes, per-minute buckets) and day / week / month
  aggregate views (the dashboard chart switches granularity, overlaying a
  distinct-uniques trend line on the pageview bars; the realtime sparkline
  rides its visits bars with the same distinct-uniques polyline).
- Filters by page, source, device, and date range.
- CSV/JSON export with IP redaction.
- Generated privacy-audit report documenting the data flow and compliance
  posture.
- Optional automatic data retention: events older than `WA_RETENTION_DAYS`
  are pruned on a schedule (startup + every 6h); `npm run prune` trims on
  demand. Aggregate caches are rebuilt after pruning so every series keeps
  summing to the totals.
- Optional raw-IP storage (`WA_STORE_IP=1`) is honored but flagged by the
  audit report as a deliberate trade-off.

## Quick start

Requires Node.js v22+ (uses the built-in `node:sqlite`).

```bash
npm install
npm start            # http://localhost:8787
```

Open the dashboard at <http://localhost:8787> and drop the snippet below into
the sites you want to measure.

## Snippet

```html
<script async src="https://your-host/wa.js" data-endpoint="https://your-host/api/collect"></script>
```

Or host the single file `public/wa.js` yourself and point
`data-endpoint` (or `window.waEndpoint`) at your collector. The endpoint
defaults to `location.origin + /api/collect`, so the snippet also works
cookie-lessly when served from the same origin without any config.

## CLI

```bash
npm run seed             # simulate ~60 days of demo traffic
npm run collect -- --path=/docs --referrer=https://github.com/ # record one pageview like a browser would
npm run prune            # delete events older than WA_RETENTION_DAYS (default 30 or --days=N)
npm run privacy-audit    # print the privacy audit report
```

`collect` accepts `--path`, `--referrer`, `--title`, `--lang`, `--sw`,
`--sh`, `--ip`, and `--ua`. Bots are excluded from metrics, matching the
server. `prune` accepts `--days=N` to override the retention window for a
single run. The `collect` and `seed` subcommands write into the configured
`WA_DATA_DIR` (`./data` by default).

## API

| Route | Method | Description |
| --- | --- | --- |
| `/wa.js` | GET | Collect snippet (no cookies) |
| `/api/collect` | POST | Record a pageview (204) |
| `/api/overview` | GET | Aggregate numbers (pageviews, uniques, sessions, bounce rate, avg visit duration), top lists (pages, sources, devices, device models, browsers, countries, operating systems, languages, screen sizes, referring pages, page titles), visits by hour of day, daily/weekly/monthly series, filters (`page`, `source`, `device`, `days`, `from`, `to`) |
| `/api/realtime` | GET | Per-minute buckets for the last `WA_REALTIME_WINDOW_MS` |
| `/api/export` | GET | Raw or summary data as CSV/JSON (`format=csv\|json`, `summary=1`); IP always redacted. The raw export carries one row per event, including the per-session `visit_key` (the timestamp of each visit's first event, shared by every event in that visit), the per-visit `entry_path` / `exit_path` edges, and the full `ua` user-agent string. Accepts the same `page` / `source` / `device` filters as `/api/overview` |
| `/api/audit` | GET | Privacy audit report (`format=text` for plain text) |
| `/api/health` | GET | Liveness check |
| `/` | GET | Dashboard |

## Configuration

All settings are environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `WA_HOST` / `WA_PORT` | `127.0.0.1` / `8787` | Bind address |
| `WA_DATA_DIR` | `./data` | Where the DB + secret live |
| `WA_DB_PATH` | `<dataDir>/analytics.sqlite` | SQLite file path |
| `WA_HASH_SALT` | unset | Optional seed for the first-time secret in `data/.wa_secret`: when set, the generated secret is `sha256(WA_HASH_SALT)` instead of random, so a recreated data dir derives the same keys. Ignored once the secret exists — hashes are stable across restarts because the secret persists |
| `WA_VISIT_WINDOW_MS` | `1800000` (30m) | Unique-visitor heuristic window |
| `WA_REALTIME_WINDOW_MS` | `300000` (5m) | Realtime window |
| `WA_COLLECT_RATE_LIMIT` | `60` | Max collect POSTs per IP per rate window (`0` disables) |
| `WA_COLLECT_RATE_WINDOW_MS` | `60000` | Rate-limit window for collect |
| `WA_STORE_IP` | `0` | Set `1` to store cleartext IPs (audit flags this) |
| `WA_RETENTION_DAYS` | `0` | Delete events older than this many days at startup + every 6h (`0` disables); the CLI `prune` subcommand runs it on demand |
| `WA_SNIPPET_PATH` | `/wa.js` | URL of the collector snippet |
| `WA_COLLECT_PATH` | `/api/collect` | URL of the collect POST endpoint; the snippet defaults to it (override client-side with the script's `data-endpoint` attribute or `window.waEndpoint`) |
| `WA_OVERVIEW_PATH` | `/api/overview` | URL of the overview endpoint (the default `/api/overview` stays active as an alias) |
| `WA_REALTIME_PATH` | `/api/realtime` | URL of the realtime endpoint |
| `WA_EXPORT_PATH` | `/api/export` | URL of the export endpoint (the default `/api/export` stays active as an alias) |
| `WA_AUDIT_PATH` | `/api/audit` | URL of the audit endpoint (the default `/api/audit` stays active as an alias) |

## Storage & privacy

- `events` is the append-only raw store; `agg_*` tables are incremental
  aggregate caches kept in sync on write, so dashboard reads never scan raw
  events.
- The guest key is `HMAC-SHA256(ip|ua, secret)`; without the server secret it
  cannot be reversed. The secret lives in `data/.wa_secret` (mode 0600).
- Exports always redact IPs (`10.20.30.x` for IPv4, first 3 hextets for IPv6),
  regardless of `WA_STORE_IP`.
- Bot user-agents are detected and excluded from metrics.
- The collect endpoint is rate-limited per IP (`WA_COLLECT_RATE_LIMIT`,
  default 60/minute) to keep the write path safe from scripts; excess requests
  get `429` with a `Retry-After` header.

## Privacy audit

Run `npm run privacy-audit` or open `/api/audit`. The report covers the data
flow (browser → collector → SQLite → dashboard/export), retention posture,
schema, and per-check status (cookies / personal fields / raw-IP storage /
snippet size / region granularity / storage locality). The raw-IP-storage
check gates on the live `events` table, not just the config flag: if any
event still carries a cleartext IP under `WA_STORE_IP=0` it fails, citing the
leftover rows. The retention check likewise verifies the live table: with a
window configured it fails if events older than the cutoff remain (citing the
count and the last prune run), and with pruning disabled it reports the
oldest retained event so the manual-prune posture is visible.

## Tests

```bash
npm run check
```

The acceptance suite boots the full server in-process against a temp SQLite
database and asserts: cookie-less responses on every route, sub-second
realtime visibility, the unique-visitor heuristic (2 simulated visitors across
multiple pages), correct daily/weekly aggregation, referrer/device/browser
reporting, page/source/device filters (including filtered series and filtered
exports), CSV/JSON export with IP redaction, the privacy audit report, and the
dashboard HTML.

## Deployment

Single-process, no external services.

```bash
# Container
docker build -t 15-web-analytics .
docker run -d -p 8787:8787 \
  -v analytics-data:/data \
  -e WA_HOST=0.0.0.0 \
  -e WA_DATA_DIR=/data \
  15-web-analytics
```

or just

```bash
npm ci --omit=dev && npm start
```

Mounting `WA_DATA_DIR` as a volume keeps the SQLite DB + per-install secret
persistent across restarts. The bundled `Dockerfile` (Node 22 Alpine) uses the
built-in `node:sqlite`, so there is nothing native to build.

## License

MIT
