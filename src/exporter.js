// CSV / JSON export of filtered event data for privacy-compliant reporting.

import {
  toCsv,
  totals,
  dailySeries,
  weeklySeries,
  monthlySeries,
  topPages,
  topSources,
  topDevices,
  topBrowsers,
  topCountries,
  topOses,
  topLanguages,
  topScreens,
  topTitles,
  topReferrers,
  entryExitPages,
  hourlySeries,
  visitStats,
  totalsFiltered,
  visitStatsFiltered,
  dailySeriesFiltered,
  weeklySeriesFiltered,
  monthlySeriesFiltered,
  topPagesFiltered,
  topSourcesFiltered,
  topDevicesFiltered,
  topBrowsersFiltered,
  topCountriesFiltered,
  topOsesFiltered,
  topLanguagesFiltered,
  topScreensFiltered,
  topTitlesFiltered,
  topReferrersFiltered,
  entryExitFiltered,
  hourlySeriesFiltered,
} from './analytics.js';
import { anonymizeIp } from './privacy.js';

const EXPORT_COLUMNS = [
  'visitsSerial',
  'visited_at',
  'guest_key',
  'ip',
  'path',
  'referrer',
  'ref_domain',
  'title',
  'screen_w',
  'screen_h',
  'lang',
  'country',
  'browser',
  'browser_version',
  'device',
  'os',
];

const CSV_COLUMNS = EXPORT_COLUMNS.slice(1);

// Export raw events in [startMs, endMs). The IP column is always redacted or
// NULL regardless of the WA_STORE_IP setting. An optional `fq` predicate
// (`{sqlWithoutRange, args}`) narrows the export to a page/source/device.
export function exportEvents(db, startMs, endMs, format = 'json', fq) {
  const rows = db
    .prepare(
      `SELECT id, ${CSV_COLUMNS.join(', ')} FROM events
        WHERE ts >= ? AND ts <= ? AND is_bot = 0${fq ? ` AND ${fq.sql}` : ''}
        ORDER BY ts`,
    )
    .all(startMs, endMs, ...(fq ? fq.args : []))
    .filter((r) => r)
    .map((r) => ({
      ...r,
      visitsSerial: Number(r.visitsSerial || r.id),
      ip: r.ip ? anonymizeIp(r.ip) : null,
    }));

  if (format === 'csv') {
    const mapped = rows.map((r) => ({ ...r, visitsSerial: undefined }));
    return toCsv(mapped, CSV_COLUMNS);
  }
  return rows;
}

// Summary JSON/CSV mirroring the dashboard. Optional `fq` makes every section
// honor the page/source/device filters.
export function exportSummary(db, startMs, endMs, format = 'json', fq) {
  const summary = {
    totals: fq ? totalsFiltered(db, startMs, endMs, fq) : totals(db, startMs, endMs),
    visit_stats: fq ? visitStatsFiltered(db, startMs, endMs, fq) : visitStats(db, startMs, endMs),
    daily: fq ? dailySeriesFiltered(db, startMs, endMs, fq) : dailySeries(db, startMs, endMs),
    weekly: fq ? weeklySeriesFiltered(db, startMs, endMs, fq) : weeklySeries(db, startMs, endMs),
    monthly: fq ? monthlySeriesFiltered(db, startMs, endMs, fq) : monthlySeries(db, startMs, endMs),
    pages: fq ? topPagesFiltered(db, startMs, endMs, 50, fq) : topPages(db, startMs, endMs, 50),
    sources: fq ? topSourcesFiltered(db, startMs, endMs, 50, fq) : topSources(db, startMs, endMs, 50),
    devices: fq ? topDevicesFiltered(db, startMs, endMs, 50, fq) : topDevices(db, startMs, endMs, 50),
    browsers: fq ? topBrowsersFiltered(db, startMs, endMs, 50, fq) : topBrowsers(db, startMs, endMs, 50),
    countries: fq ? topCountriesFiltered(db, startMs, endMs, 50, fq) : topCountries(db, startMs, endMs, 50),
    oses: fq ? topOsesFiltered(db, startMs, endMs, 50, fq) : topOses(db, startMs, endMs, 50),
    languages: fq ? topLanguagesFiltered(db, startMs, endMs, 50, fq) : topLanguages(db, startMs, endMs, 50),
    screens: fq ? topScreensFiltered(db, startMs, endMs, 50, fq) : topScreens(db, startMs, endMs, 50),
    titles: fq ? topTitlesFiltered(db, startMs, endMs, 50, fq) : topTitles(db, startMs, endMs, 50),
    referrers: fq ? topReferrersFiltered(db, startMs, endMs, 50, fq) : topReferrers(db, startMs, endMs, 50),
    hourly: fq ? hourlySeriesFiltered(db, startMs, endMs, fq) : hourlySeries(db, startMs, endMs),
    entries: fq ? entryExitFiltered(db, startMs, endMs, 50, fq).entries : entryExitPages(db, startMs, endMs, 50).entries,
    exits: fq ? entryExitFiltered(db, startMs, endMs, 50, fq).exits : entryExitPages(db, startMs, endMs, 50).exits,
  };
  if (format === 'csv') {
    const sections = [];
    for (const [key, value] of Object.entries(summary)) {
      const rows = Array.isArray(value) ? value : [value];
      const cols =
        rows.length && rows[0]
          ? Object.keys(rows[0])
          : ['value'];
      sections.push(`# ${key}`);
      sections.push(toCsv(rows, cols).trim());
    }
    return sections.join('\n\n') + '\n';
  }
  return summary;
}
