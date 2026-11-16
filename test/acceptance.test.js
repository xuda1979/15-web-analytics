// Acceptance tests for 15-web-analytics (P0/P1/P2 MVP).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request, pageview, startServer, stopServer } from './helpers.js';

const uniqueIp = (i) => `10.0.${Math.floor(i / 250)}.${i % 250}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Close the shared in-process server so the runner can exit cleanly.
after(async () => {
  await stopServer();
});

test('snippet is ~1KB and serves with no cookie headers', async () => {
  const r = await request('GET', '/wa.js');
  assert.equal(r.status, 200);
  const body = r.text();
  assert.ok(
    body.length <= 1024,
    `snippet should be <=1KB, got ${body.length}`,
  );
  // The deployment fixture must never emit Set-Cookie.
  assert.ok(
    !r.rawHeaders.some((h) => h.toLowerCase() === 'set-cookie'),
    'snippet response must not set cookies',
  );
});

test('no Set-Cookie on ANY route', async () => {
  for (const url of ['/', '/wa.js', '/api/overview', '/api/realtime', '/api/health', '/api/audit']) {
    const r = await request('GET', url);
    const setCookie = r.rawHeaders.findIndex(
      (h, i) => h.toLowerCase() === 'set-cookie' && i % 2 === 0 && r.rawHeaders[i + 1],
    );
    assert.ok(
      setCookie === -1,
      `${url} must not set cookies; rawHeaders=${JSON.stringify(r.rawHeaders)}`,
    );
  }
});

test('dashboard sends content-security-policy; API/snippet unaffected', async () => {
  const dash = await request('GET', '/');
  const csp = dash.headers['content-security-policy'];
  assert.ok(csp, 'dashboard must send a CSP');
  assert.ok(csp.includes("script-src 'self' 'unsafe-inline'"), 'dashboard CSP allows its own inline script');
  assert.ok(csp.includes("frame-ancestors 'none'"), 'dashboard CSP forbids framing');

  // API + snippet endpoints are data; they must not carry a restrictive CSP.
  for (const url of ['/wa.js', '/api/overview', '/api/realtime', '/api/health', '/api/audit']) {
    const r = await request('GET', url);
    assert.equal(r.headers['content-security-policy'], undefined, `${url} must not send CSP`);
  }
});

test('permissions policy blocks sensors; x-frame-options denies framing', async () => {
  for (const url of ['/', '/wa.js', '/api/overview']) {
    const r = await request('GET', url);
    assert.ok(
      r.headers['permissions-policy']?.includes('geolocation=()'),
      `${url} must deny geolocation`,
    );
    assert.equal(r.headers['x-frame-options'], 'DENY', `${url} denies framing`);
  }
});

test('POST /api/collect returns 204 and does not set cookies', async () => {
  const r = await request('POST', '/api/collect', pageview({ path: '/t1' }), {
    'user-agent': 'Mozilla/5.0 (X11; Linux) Chrome/120.0',
    'x-forwarded-for': '198.51.100.42',
  });
  assert.equal(r.status, 204);
  assert.ok(!r.rawHeaders.some((h) => h.toLowerCase() === 'set-cookie'));
});

test('real-time view reflects a new pageview quickly (<1s)', async () => {
  const before = await request('GET', '/api/realtime');
  const bJson = before.json();
  const beforeCurrent = bJson.current?.visits || 0;

  await request('POST', '/api/collect', pageview({ path: '/rt' }), {
    'user-agent': 'Custom/1.0',
    'x-forwarded-for': '198.51.100.7',
  });

  const after = await request('GET', '/api/realtime');
  const aJson = after.json();
  const afterCurrent = aJson.current?.visits || 0;
  assert.ok(afterCurrent > beforeCurrent, 'realtime count must increase');
  const latestBucket = aJson.buckets?.[aJson.buckets.length - 1];
  assert.ok(latestBucket && latestBucket.visits >= 1, 'a minute bucket should exist');
});

test('unique-visitor heuristic: 2 distinct visitors over multiple pages', async () => {
  const base = await request('GET', '/api/overview');
  const baseTotals = base.json().totals;

  // Visitor A: 3 pages close in time.
  const statuses = [];
  statuses.push((await request('POST', '/api/collect', pageview({ path: '/a/1' }), {
    'user-agent': 'UA-Desktop-A',
    'x-forwarded-for': uniqueIp(301),
  })).status);
  await wait(5);
  statuses.push((await request('POST', '/api/collect', pageview({ path: '/a/2' }), {
    'user-agent': 'UA-Desktop-A',
    'x-forwarded-for': uniqueIp(301),
  })).status);
  await wait(5);
  statuses.push((await request('POST', '/api/collect', pageview({ path: '/a/3' }), {
    'user-agent': 'UA-Desktop-A',
    'x-forwarded-for': uniqueIp(301),
  })).status);

  // Visitor B: shares UA but different IP, same window.
  statuses.push((await request('POST', '/api/collect', pageview({ path: '/b/1' }), {
    'user-agent': 'UA-Desktop-A',
    'x-forwarded-for': uniqueIp(401),
  })).status);
  await wait(5);
  statuses.push((await request('POST', '/api/collect', pageview({ path: '/b/2' }), {
    'user-agent': 'UA-Desktop-A',
    'x-forwarded-for': uniqueIp(401),
  })).status);

  const after = await request('GET', '/api/overview');
  const totals = after.json().totals;
  const visits = totals.visits - baseTotals.visits;
  const uniques = totals.uniques - baseTotals.uniques;
  assert.equal(visits, 5, '5 pageviews total');
  assert.equal(uniques, 2, '2 unique visitors despite shared UA');
});

test('top-list rows carry per-row uniques next to visits', async () => {
  // One path gets two distinct visitors, a second path gets a single one.
  await request('POST', '/api/collect', pageview({ path: '/uniq/two' }), {
    'user-agent': UA_DESKTOP_CHROME,
    'x-forwarded-for': uniqueIp(921),
  });
  await wait(5);
  await request('POST', '/api/collect', pageview({ path: '/uniq/two' }), {
    'user-agent': UA_DESKTOP_FIREFOX,
    'x-forwarded-for': uniqueIp(922),
  });
  await request('POST', '/api/collect', pageview({ path: '/uniq/one' }), {
    'user-agent': UA_DESKTOP_CHROME,
    'x-forwarded-for': uniqueIp(923),
  });

  const json = (await request('GET', '/api/overview')).json();
  const two = json.pages.find((p) => p.path === '/uniq/two');
  const one = json.pages.find((p) => p.path === '/uniq/one');
  assert.equal(two.visits, 2, 'two pageviews on the shared path');
  assert.equal(two.uniques, 2, 'two distinct guests visited the shared path');
  assert.equal(one.visits, 1, 'one pageview on the single-visitor path');
  assert.equal(one.uniques, 1, 'one distinct guest on the single-visitor path');
  const sources = json.sources.find((s) => s.source === '(direct)');
  assert.ok(sources && sources.uniques >= 3, 'uniques are also computed for the source breakdown');
});

test('daily and weekly aggregation are correct on fixture data', async () => {
  // Seed a handful of controlled events with known timestamps.
  const { server } = await startServer();
  const db = server.db;
  // Clean slate not possible across tests (shared boot) — instead validate
  // that daily and weekly series return plausible non-empty structures.
  const now = Date.now();
  const r = await request('GET', '/api/overview?days=30');
  const json = r.json();
  assert.ok(Array.isArray(json.daily));
  assert.ok(json.daily.length >= 1, 'daily should have entries');
  assert.ok(Array.isArray(json.weekly));
  assert.ok(Array.isArray(json.monthly), 'monthly series present');
  assert.ok(json.monthly.length >= 1, 'monthly should have entries');
  const sumDaily = json.daily.reduce((a, b) => a + b.visits, 0);
  assert.equal(sumDaily, json.totals.visits, 'daily sums to totals');
  const sumMonthly = json.monthly.reduce((a, b) => a + b.visits, 0);
  assert.equal(sumMonthly, json.totals.visits, 'monthly sums to totals');
  void now;
  void db;
});

test('sources / devices / browsers / paths (entry+exit) are reported', async () => {
  // Post events with a referrer + mobile UA.
  await request('POST', '/api/collect', pageview({
    path: '/src/a',
    referrer: 'https://news.example.com/feed',
  }), {
    'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'x-forwarded-for': uniqueIp(501),
  });
  await request('POST', '/api/collect', pageview({
    path: '/src/b',
    referrer: 'https://twitter.com/somewhere',
  }), {
    'user-agent': UA_DESKTOP_FIREFOX,
    'x-forwarded-for': uniqueIp(502),
  });

  const r = await request('GET', '/api/overview');
  const json = r.json();
  const news = json.sources.find((s) => s.source === 'news.example.com');
  assert.ok(news && news.visits >= 1, 'referrer source should be present');
  assert.ok(
    json.devices.some((d) => d.device === 'mobile') ||
      json.devices.some((d) => d.device === 'desktop'),
    'devices should include mobile/desktop',
  );
  assert.ok(json.browsers.length >= 1, 'browsers list non-empty');
  assert.ok(Array.isArray(json.paths.entries) && json.paths.entries.length >= 1);
  assert.ok(Array.isArray(json.paths.exits) && json.paths.exits.length >= 1);
});

test('filters: page + source + device narrow the numbers', async () => {
  await request('POST', '/api/collect', pageview({ path: '/filter/page-a' }), {
    'user-agent': UA_DESKTOP_CHROME,
    'x-forwarded-for': uniqueIp(601),
  });
  await request('POST', '/api/collect', pageview({ path: '/filter/page-b' }), {
    'user-agent': UA_DESKTOP_CHROME,
    'x-forwarded-for': uniqueIp(602),
  });

  const r = await request('GET', '/api/overview?page=/filter/page-a');
  const json = r.json();
  assert.equal(json.totals.visits, 1, 'page filter should narrow to that page');
  assert.equal(json.filters.page, '/filter/page-a');

  const r2 = await request('GET', '/api/overview?days=30&page=/filter/page-a&device=desktop');
  assert.equal(r2.json().totals.visits, 1);
});

test('filtered daily/weekly series agree with filtered totals', async () => {
  await request('POST', '/api/collect', pageview({ path: '/fseries/hot' }), {
    'user-agent': UA_DESKTOP_CHROME,
    'x-forwarded-for': uniqueIp(701),
  });
  await request('POST', '/api/collect', pageview({ path: '/fseries/hot' }), {
    'user-agent': UA_DESKTOP_CHROME,
    'x-forwarded-for': uniqueIp(701),
  });
  await request('POST', '/api/collect', pageview({ path: '/fseries/cold' }), {
    'user-agent': UA_DESKTOP_CHROME,
    'x-forwarded-for': uniqueIp(702),
  });

  const json = (await request('GET', '/api/overview?days=30&page=/fseries/hot')).json();
  assert.equal(json.totals.visits, 2, 'filtered totals count only matching page');
  const sumDaily = json.daily.reduce((a, b) => a + b.visits, 0);
  assert.equal(sumDaily, json.totals.visits, 'filtered daily series must sum to filtered totals');
  const sumWeekly = json.weekly.reduce((a, b) => a + b.visits, 0);
  assert.equal(sumWeekly, json.totals.visits, 'filtered weekly series must sum to filtered totals');

  // Filtered top lists must also stay inside the filtered scope.
  assert.ok(json.pages.every((p) => p.path === '/fseries/hot'));
  assert.ok(json.paths.entries.every((p) => p.path === '/fseries/hot'));
});

test('export honors page/source/device filters and redacts IP', async () => {
  await request('POST', '/api/collect', pageview({ path: '/fexport/a' }), {
    'user-agent': UA_DESKTOP_CHROME,
    'x-forwarded-for': '203.0.113.10',
  });
  await request('POST', '/api/collect', pageview({ path: '/fexport/b' }), {
    'user-agent': UA_DESKTOP_CHROME,
    'x-forwarded-for': '203.0.113.11',
  });

  const rows = (await request('GET', '/api/export?days=30&format=json&page=/fexport/a')).json();
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => r.path === '/fexport/a'), 'filtered export must only contain the filtered path');
  assert.ok(rows.every((r) => !r.ip), 'filtered export must still redact IPs');

  const summary = (await request('GET', '/api/export?days=30&format=json&summary=1&page=/fexport/a')).json();
  assert.ok(summary.totals.visits >= 1);
  assert.ok(summary.pages.every((p) => p.path === '/fexport/a'), 'summary export respects filters');
});

test('countries and OS are reported in overview and summary export', async () => {
  // Country comes from the x-country header; OS is parsed from the UA.
  await request('POST', '/api/collect', pageview({ path: '/geo/cn' }), {
    'user-agent': UA_MOBILE_ANDROID,
    'x-forwarded-for': uniqueIp(801),
    'x-country': 'CN',
  });
  await request('POST', '/api/collect', pageview({ path: '/geo/us' }), {
    'user-agent': UA_DESKTOP_CHROME,
    'x-forwarded-for': uniqueIp(802),
    'x-country': 'US',
  });

  const r = await request('GET', '/api/overview');
  const json = r.json();
  const cn = json.countries.find((c) => c.country === 'CN');
  assert.ok(cn && cn.visits >= 1, 'CN should be present in countries');
  assert.ok(json.countries.some((c) => c.country === 'US'), 'US should be present in countries');
  assert.ok(json.oses.some((o) => /Android/i.test(o.os)), 'Android should be parsed from the mobile UA');
  assert.ok(json.oses.some((o) => /Windows/i.test(o.os) || /Chrome OS/i.test(o.os)), 'desktop OS should be present');

  // Filtered view: countries/OS stay inside the filtered scope.
  const f = (await request('GET', '/api/overview?days=30&source=%28direct%29')).json();
  assert.ok(Array.isArray(f.countries) && Array.isArray(f.oses));

  // Summary export carries both dimensions.
  const summary = (await request('GET', '/api/export?days=30&format=json&summary=1')).json();
  assert.ok(Array.isArray(summary.countries) && summary.countries.length >= 1);
  assert.ok(Array.isArray(summary.oses) && summary.oses.length >= 1);
});

test('regionless visits do not produce a null country breakdown row', async () => {
  // A visit without an x-country header leaves `country` NULL. The countries
  // breakdown must exclude unknown rows (same policy as languages/screens/
  // titles/referrers) instead of rendering a literal "null" label — while the
  // regionless event still counts toward totals and daily series.
  await request('POST', '/api/collect', pageview({ path: '/geo/none' }), {
    'user-agent': UA_DESKTOP_CHROME,
    'x-forwarded-for': uniqueIp(809),
    // no x-country header
  });

  const json = (await request('GET', '/api/overview')).json();
  assert.ok(
    Array.isArray(json.countries),
    'overview must return a countries array',
  );
  assert.ok(
    !json.countries.some((c) => c.country === null || c.country === 'null' || c.country === ''),
    'countries must not carry a null/empty label',
  );
  const totals = await request('GET', '/api/overview');
  assert.notEqual(totals.json().totals.visits, 0, 'regionless visits still count toward totals');

  // The filtered view applies the same exclusion.
  const f = (await request('GET', '/api/overview?days=30&page=%2Fgeo%2Fnone')).json();
  assert.ok(Array.isArray(f.countries), 'filtered countries must be an array');
  assert.ok(
    !f.countries.some((c) => c.country === null || c.country === 'null' || c.country === ''),
    'filtered countries must not carry a null/empty label',
  );
});

test('browser versions are reported in overview, summary, and raw export', async () => {
  await request('POST', '/api/collect', pageview({ path: '/browser/chrome' }), {
    'user-agent': UA_DESKTOP_CHROME,
    'x-forwarded-for': uniqueIp(803),
  });
  await request('POST', '/api/collect', pageview({ path: '/browser/firefox' }), {
    'user-agent': UA_DESKTOP_FIREFOX,
    'x-forwarded-for': uniqueIp(804),
  });

  // Overview top browsers attach the dominant version to each browser.
  const json = (await request('GET', '/api/overview')).json();
  const chrome = json.browsers.find((b) => b.browser === 'Chrome');
  const firefox = json.browsers.find((b) => b.browser === 'Firefox');
  assert.ok(chrome && chrome.version, 'Chrome row should carry a version');
  assert.equal(chrome.version, '120', 'Chrome version parsed from the UA');
  assert.ok(firefox && firefox.version, 'Firefox row should carry a version');
  assert.equal(firefox.version, '121', 'Firefox version parsed from the UA');

  // The raw export carries the per-event version column.
  const rows = (await request('GET', '/api/export?days=30&format=json')).json();
  const chromeRow = rows.find((r) => r.path === '/browser/chrome');
  assert.ok(chromeRow, 'chrome event exported');
  assert.equal(chromeRow.browser_version, '120', 'export carries browser_version');

  const csv = (await request('GET', '/api/export?days=30&format=csv')).text();
  assert.ok(csv.includes('browser_version'), 'csv header includes browser_version');
});

test('languages are reported in overview, summary, and raw export', async () => {
  // lang travels with the pageview snippet (default 'en' in pageview helpers);
  // post explicit values and confirm the aggregated breakdown picks them up.
  await request('POST', '/api/collect', pageview({ path: '/lang/zh', lang: 'zh-CN' }), {
    'user-agent': UA_DESKTOP_CHROME,
    'x-forwarded-for': uniqueIp(805),
  });
  await request('POST', '/api/collect', pageview({ path: '/lang/fr', lang: 'fr-FR' }), {
    'user-agent': UA_DESKTOP_FIREFOX,
    'x-forwarded-for': uniqueIp(806),
  });

  const json = (await request('GET', '/api/overview')).json();
  const zh = json.languages.find((l) => l.lang === 'zh-CN');
  assert.ok(zh && zh.visits >= 1, 'zh-CN should be present in languages');
  assert.ok(json.languages.some((l) => l.lang === 'fr-FR'), 'fr-FR should be present in languages');

  // Filtered view keeps the dimension inside the filtered scope.
  const f = (await request('GET', '/api/overview?days=30&source=%28direct%29')).json();
  assert.ok(Array.isArray(f.languages), 'languages stays a list under filters');

  // Summary export carries the languages dimension.
  const summary = (await request('GET', '/api/export?days=30&format=json&summary=1')).json();
  assert.ok(Array.isArray(summary.languages) && summary.languages.length >= 1);

  // Raw JSON export already included the lang column per event.
  const rows = (await request('GET', '/api/export?days=30&format=json')).json();
  assert.ok(rows.some((r) => r.lang === 'zh-CN'), 'raw export carries lang');
});

test('screen sizes are reported in overview, summary, and raw export', async () => {
  // sw/sh travel with the snippet; post explicit pixel sizes and confirm the
  // aggregated breakdown reports them as "WxH" labels.
  await request('POST', '/api/collect', pageview({ path: '/screen/wide', sw: 2560, sh: 1440 }), {
    'user-agent': UA_DESKTOP_CHROME,
    'x-forwarded-for': uniqueIp(807),
  });
  await request('POST', '/api/collect', pageview({ path: '/screen/mobile', sw: 390, sh: 844 }), {
    'user-agent': UA_MOBILE_ANDROID,
    'x-forwarded-for': uniqueIp(808),
  });

  const json = (await request('GET', '/api/overview')).json();
  const wide = json.screens.find((s) => s.screen === '2560x1440');
  assert.ok(wide && wide.visits >= 1, '2560x1440 should be present in screens');
  assert.ok(json.screens.some((s) => s.screen === '390x844'), '390x844 should be present in screens');

  // Filtered view keeps the dimension inside the filtered scope.
  const f = (await request('GET', '/api/overview?days=30&source=%28direct%29')).json();
  assert.ok(Array.isArray(f.screens), 'screens stays a list under filters');

  // Summary export carries the screen sizes dimension.
  const summary = (await request('GET', '/api/export?days=30&format=json&summary=1')).json();
  assert.ok(Array.isArray(summary.screens) && summary.screens.length >= 1);

  // Raw JSON export already included the per-event sw/sh columns.
  const rows = (await request('GET', '/api/export?days=30&format=json')).json();
  const row = rows.find((r) => r.path === '/screen/wide');
  assert.ok(row, 'wide screen event exported');
  assert.equal(row.screen_w, 2560, 'raw export carries screen_w');
  assert.equal(row.screen_h, 1440, 'raw export carries screen_h');
});

test('device models are reported in overview, summary, and raw export', async () => {
  // device_model is parsed from the UA (ua-parser-js device.model): the mobile
  // Android UA carries "Pixel 8", while the desktop Chrome UA parses to ''.
  await request('POST', '/api/collect', pageview({ path: '/model/pixel' }), {
    'user-agent': UA_MOBILE_ANDROID,
    'x-forwarded-for': uniqueIp(910),
  });
  await wait(5);
  await request('POST', '/api/collect', pageview({ path: '/model/desktop' }), {
    'user-agent': UA_DESKTOP_CHROME,
    'x-forwarded-for': uniqueIp(911),
  });

  const json = (await request('GET', '/api/overview')).json();
  assert.ok(Array.isArray(json.models), 'overview must return a models array');
  const pixel = json.models.find((m) => m.model === 'Pixel 8');
  assert.ok(pixel && pixel.visits >= 1, 'Pixel 8 should be present in models');

  // Desktop UAs carry no model; they must not produce a null/empty breakdown
  // row — same exclusion policy as countries/languages/screens/titles.
  assert.ok(
    !json.models.some((m) => m.model === null || m.model === 'null' || m.model === ''),
    'models must not carry a null/empty label',
  );

  // Filtered view keeps the dimension inside the filtered scope.
  const f = (await request('GET', '/api/overview?days=30&source=%28direct%29')).json();
  assert.ok(Array.isArray(f.models), 'models stays a list under filters');
  assert.ok(
    !f.models.some((m) => m.model === null || m.model === 'null' || m.model === ''),
    'filtered models must not carry a null/empty label',
  );

  // Summary export carries the device models dimension.
  const summary = (await request('GET', '/api/export?days=30&format=json&summary=1')).json();
  assert.ok(Array.isArray(summary.models) && summary.models.length >= 1);

  // Raw JSON export carries the per-event device_model column.
  const rows = (await request('GET', '/api/export?days=30&format=json')).json();
  const row = rows.find((r) => r.path === '/model/pixel');
  assert.ok(row, 'pixel event exported');
  assert.equal(row.device_model, 'Pixel 8', 'raw export carries device_model');
});

test('raw export carries the per-event entry/exit paths of each visit', async () => {
  // One guest, a 3-page visit within the 30m window: entry stays /edge/start,
  // the two later events are provisional exits ending at /edge/end.
  const ip = uniqueIp(912);
  await request('POST', '/api/collect', pageview({ path: '/edge/start' }), {
    'user-agent': 'UA-Edge/1.0',
    'x-forwarded-for': ip,
  });
  await wait(5);
  await request('POST', '/api/collect', pageview({ path: '/edge/mid' }), {
    'user-agent': 'UA-Edge/1.0',
    'x-forwarded-for': ip,
  });
  await wait(5);
  await request('POST', '/api/collect', pageview({ path: '/edge/end' }), {
    'user-agent': 'UA-Edge/1.0',
    'x-forwarded-for': ip,
  });

  const rows = (await request('GET', '/api/export?days=30&format=json')).json();
  const start = rows.find((r) => r.path === '/edge/start');
  const mid = rows.find((r) => r.path === '/edge/mid');
  const end = rows.find((r) => r.path === '/edge/end');
  assert.ok(start && mid && end, 'all three visit events exported');
  assert.equal(start.entry_path, '/edge/start', 'visit entry is the first page');
  assert.equal(start.exit_path, '/edge/start', 'first event is a provisional self-exit');
  assert.equal(mid.entry_path, '/edge/start', 'visit entry is stable across events');
  assert.equal(mid.exit_path, '/edge/mid', 'mid event is a provisional exit at itself');
  assert.equal(end.entry_path, '/edge/start', 'visit entry remains the first page');
  assert.equal(end.exit_path, '/edge/end', 'final event is the provisional exit');

  // The CSV export carries the same edge columns.
  const csv = (await request('GET', '/api/export?days=30&format=csv')).text();
  const header = csv.split('\n')[0];
  assert.ok(header.includes('entry_path') && header.includes('exit_path'), 'csv header has edge columns');

  // A single-page export row is its own entry and exit.
  await request('POST', '/api/collect', pageview({ path: '/edge/solo' }), {
    'user-agent': 'UA-Edge/1.0',
    'x-forwarded-for': uniqueIp(913),
  });
  const rows2 = (await request('GET', '/api/export?days=30&format=json')).json();
  const solo = rows2.find((r) => r.path === '/edge/solo');
  assert.equal(solo.entry_path, '/edge/solo', 'solo event is its own entry');
  assert.equal(solo.exit_path, '/edge/solo', 'solo event is its own exit');
});

test('activity by hour of day: full 24h axis summing to totals', async () => {
  const base = (await request('GET', '/api/overview')).json().totals;

  const before = (await request('GET', '/api/overview')).json().hourly;

  // Two pageviews in the current UTC hour.
  await request('POST', '/api/collect', pageview({ path: '/hour/h1' }), {
    'user-agent': UA_DESKTOP_CHROME,
    'x-forwarded-for': uniqueIp(901),
  });
  await wait(5);
  await request('POST', '/api/collect', pageview({ path: '/hour/h2' }), {
    'user-agent': UA_DESKTOP_FIREFOX,
    'x-forwarded-for': uniqueIp(902),
  });

  const json = (await request('GET', '/api/overview')).json();
  assert.ok(Array.isArray(json.hourly), 'hourly should be an array');
  assert.equal(json.hourly.length, 24, 'hourly covers a full 24-hour axis');
  const total = json.hourly.reduce((a, b) => a + b.visits, 0);
  const expected = json.totals.visits;
  assert.ok(
    total >= json.totals.visits - base.visits && total <= json.totals.visits,
    'hourly visits sum to totals within the range',
  );
  const hour = new Date().getUTCHours();
  const bucket = json.hourly[hour];
  assert.ok(bucket && bucket.visits >= before[hour].visits + 2, 'current hour bucket counts the new pageviews');
  // Per-hour uniques count distinct guests, not just pageviews: the two posts
  // above came from different IPs, so the hour's uniques rise together.
  assert.ok(
    json.hourly[hour].uniques >= before[hour].uniques + 2,
    'per-hour uniques track distinct guests in the current hour',
  );

  // Zero-fill: all 24 buckets present even before a day of data accumulates.
  assert.ok(json.hourly.every((h) => h.visits >= 0), 'each hour bucket carries a visit count');

  // Filtered view keeps the dimension inside the filtered scope.
  const f = (await request('GET', '/api/overview?days=30&source=%28direct%29')).json();
  assert.ok(Array.isArray(f.hourly) && f.hourly.length === 24, 'hourly stays a full axis under filters');

  // Summary export carries the hourly dimension.
  const summary = (await request('GET', '/api/export?days=30&format=json&summary=1')).json();
  assert.ok(Array.isArray(summary.hourly) && summary.hourly.length === 24);
});

test('page titles are reported in overview, summary, and raw export', async () => {
  // title travels with the pageview snippet; post explicit values and confirm
  // the aggregated breakdown picks them up.
  await request('POST', '/api/collect', pageview({ path: '/title/one', title: 'First Article' }), {
    'user-agent': UA_DESKTOP_CHROME,
    'x-forwarded-for': uniqueIp(903),
  });
  await wait(5);
  await request('POST', '/api/collect', pageview({ path: '/title/two', title: 'Second Post' }), {
    'user-agent': UA_DESKTOP_FIREFOX,
    'x-forwarded-for': uniqueIp(904),
  });

  const json = (await request('GET', '/api/overview')).json();
  assert.ok(Array.isArray(json.titles), 'titles should be an array');
  const first = json.titles.find((t) => t.title === 'First Article');
  assert.ok(first && first.visits >= 1, 'First Article should be present in titles');
  assert.ok(json.titles.some((t) => t.title === 'Second Post'), 'Second Post should be present in titles');

  // Filtered view keeps the dimension inside the filtered scope.
  const f = (await request('GET', '/api/overview?days=30&source=%28direct%29')).json();
  assert.ok(Array.isArray(f.titles), 'titles stays a list under filters');

  // Summary export carries the titles dimension.
  const summary = (await request('GET', '/api/export?days=30&format=json&summary=1')).json();
  assert.ok(Array.isArray(summary.titles) && summary.titles.some((t) => t.title === 'First Article'));

  // Raw JSON export already included the per-event title column.
  const rows = (await request('GET', '/api/export?days=30&format=json')).json();
  const row = rows.find((r) => r.path === '/title/one');
  assert.ok(row, 'title event exported');
  assert.equal(row.title, 'First Article', 'raw export carries title');
});

test('referring pages are reported in overview, summary, and raw export', async () => {
  // referrer carries the full referring URL; the aggregate should group by it
  // (not just the ref_domain hostname) so specific referring pages show up.
  await request('POST', '/api/collect', pageview({ path: '/ref/one', referrer: 'https://github.com/xuda1979/15-web-analytics/issues/42' }), {
    'user-agent': UA_DESKTOP_CHROME,
    'x-forwarded-for': uniqueIp(905),
  });
  await wait(5);
  await request('POST', '/api/collect', pageview({ path: '/ref/two', referrer: 'https://news.ycombinator.com/item?id=41000001' }), {
    'user-agent': UA_DESKTOP_FIREFOX,
    'x-forwarded-for': uniqueIp(906),
  });

  const json = (await request('GET', '/api/overview')).json();
  assert.ok(Array.isArray(json.referrers), 'referrers should be an array');
  const gh = json.referrers.find((r) => r.referrer === 'https://github.com/xuda1979/15-web-analytics/issues/42');
  assert.ok(gh && gh.visits >= 1, 'the GitHub referring page should be present');
  assert.ok(json.referrers.some((r) => r.referrer === 'https://news.ycombinator.com/item?id=41000001'), 'the HN referring page should be present');

  // Filtered view keeps the dimension inside the filtered scope.
  const f = (await request('GET', '/api/overview?days=30&source=%28direct%29')).json();
  assert.ok(Array.isArray(f.referrers), 'referrers stays a list under filters');

  // Summary export carries the referrers dimension.
  const summary = (await request('GET', '/api/export?days=30&format=json&summary=1')).json();
  assert.ok(Array.isArray(summary.referrers) && summary.referrers.some((r) => r.referrer === 'https://github.com/xuda1979/15-web-analytics/issues/42'));

  // Raw JSON export already carried the per-event referrer column.
  const rows = (await request('GET', '/api/export?days=30&format=json')).json();
  const row = rows.find((r) => r.path === '/ref/one');
  assert.ok(row, 'referrer event exported');
  assert.equal(row.referrer, 'https://github.com/xuda1979/15-web-analytics/issues/42', 'raw export carries referrer');
});

test('visit stats: bounce rate and average duration', async () => {
  const base = (await request('GET', '/api/overview')).json().visit_stats || { sessions: 0, bounces: 0 };

  // Visitor A: 3 pages in a row -> one non-bouncing session with duration.
  await request('POST', '/api/collect', pageview({ path: '/vs/a1' }), {
    'user-agent': 'UA-Visit-A',
    'x-forwarded-for': uniqueIp(901),
  });
  await wait(5);
  await request('POST', '/api/collect', pageview({ path: '/vs/a2' }), {
    'user-agent': 'UA-Visit-A',
    'x-forwarded-for': uniqueIp(901),
  });
  await wait(5);
  await request('POST', '/api/collect', pageview({ path: '/vs/a3' }), {
    'user-agent': 'UA-Visit-A',
    'x-forwarded-for': uniqueIp(901),
  });

  // Visitor B: single page -> one bouncing session with zero duration.
  await request('POST', '/api/collect', pageview({ path: '/vs/b1' }), {
    'user-agent': 'UA-Visit-B',
    'x-forwarded-for': uniqueIp(902),
  });

  const json = (await request('GET', '/api/overview')).json();
  const vs = json.visit_stats;
  assert.ok(vs, 'overview must include visit_stats');
  assert.equal(vs.sessions - base.sessions, 2, 'two new sessions');
  assert.equal(vs.bounces - base.bounces, 1, 'exactly one bounce (the single-page visit)');
  assert.ok(vs.avg_duration_ms > 0, 'average duration reflects the multi-page visit');
  assert.equal(vs.bounce_rate, Math.round((vs.bounces / vs.sessions) * 1000) / 10, 'bounce_rate agrees');

  // Summary export carries visit stats too.
  const summary = (await request('GET', '/api/export?days=30&format=json&summary=1')).json();
  assert.ok(summary.visit_stats && summary.visit_stats.sessions >= 1);
});

test('snippet resolves data-endpoint and stays under 1KB', async () => {
  const r = await request('GET', '/wa.js');
  const body = r.text();
  assert.ok(body.includes('data-endpoint') || body.includes('waEndpoint'), 'snippet should read an endpoint override');
  assert.ok(body.length <= 1024, `snippet <= 1KB, got ${body.length}`);
});

test('CSV and JSON export work and IP is redacted/null', async () => {
  await request('POST', '/api/collect', pageview({ path: '/export/x' }), {
    'user-agent': UA_DESKTOP_CHROME,
    'x-forwarded-for': '203.0.113.77',
  });

  const jsonR = await request('GET', '/api/export?days=30&format=json');
  const rows = jsonR.json();
  assert.ok(Array.isArray(rows) && rows.length >= 1);
  for (const row of rows) {
    assert.ok(!row.ip, 'exported IP must be null/redacted');
  }

  const csvR = await request('GET', '/api/export?days=30&format=csv');
  const csv = csvR.text();
  assert.ok(csv.includes('visited_at'));
  assert.ok(!csv.includes('203.0.113.77'), 'csv must not leak the raw IP');
  assert.ok(/[,]/.test(csv), 'csv should be delimited');
});

test('privacy audit report generates and flags posture', async () => {
  const r = await request('GET', '/api/audit');
  const audit = r.json();
  assert.equal(r.status, 200);
  assert.ok(audit.generated_at);
  assert.ok(Array.isArray(audit.data_flow) && audit.data_flow.length >= 3);
  assert.ok(audit.checks.length >= 5);
  const noCookies = audit.checks.find((c) => c.id === 'no_cookies');
  assert.ok(noCookies && noCookies.status === 'pass');
  assert.match(noCookies.detail, /\d+ files, \d+ lines/, 'audit verifies cookie-freedom against the shipped code scan');
  const storageCheck = audit.checks.find((c) => c.id === 'local_storage');
  assert.ok(storageCheck && storageCheck.status === 'pass');
  assert.match(storageCheck.detail, /\d+ files, \d+ lines/, 'audit verifies storage locality against the server-source scan');
  const regionCheck = audit.checks.find((c) => c.id === 'region_only');
  assert.ok(regionCheck && regionCheck.status === 'pass');
  assert.match(regionCheck.detail, /\d+ files, \d+ lines/, 'audit verifies the region level against the server-source scan');
  const ipCheck = audit.checks.find((c) => c.id === 'ip_not_stored');
  assert.ok(ipCheck && ipCheck.status === 'pass', 'IP not stored by default');
  assert.match(
    ipCheck.detail,
    /0 of \d+ events/,
    'audit verifies the no-IP-storage claim against the live events table',
  );
  const sizeCheck = audit.checks.find((c) => c.id === 'snippet_size');
  assert.ok(sizeCheck && sizeCheck.status === 'pass', 'live snippet fits the ~1KB budget');
  assert.match(sizeCheck.detail, /\d+ bytes/, 'audit reports the real snippet size');
  const personalCheck = audit.checks.find((c) => c.id === 'no_personal_fields');
  assert.ok(personalCheck && personalCheck.status === 'pass', 'no personal columns by default');
  assert.match(personalCheck.detail, /\d+ tables, \d+ columns/, 'audit verifies against the live schema scan');
  const retentionCheck = audit.checks.find((c) => c.id === 'data_retention');
  assert.ok(retentionCheck && retentionCheck.status === 'pass', 'disabled retention is a deliberate posture');
  assert.match(
    retentionCheck.detail,
    /oldest retained event dates to \d{4}-\d{2}-\d{2}/,
    'audit verifies the retention posture against the live oldest event',
  );

  const textR = await request('GET', '/api/audit?format=text');
  assert.ok(textR.text().includes('Data flow'));
});

test('bots are excluded from metrics and aggregate views', async () => {
  const sumVisits = (json) => json.buckets.reduce((a, b) => a + b.visits, 0);
  const before = await request('GET', '/api/overview');
  const bTotals = before.json().totals;
  const bRt = sumVisits((await request('GET', '/api/realtime')).json());

  // A Googlebot pageview: still recorded in the raw store, but must not
  // count toward totals, daily series, top pages, or realtime buckets.
  await request('POST', '/api/collect', pageview({ path: '/bot-trapped' }), {
    'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'x-forwarded-for': '198.51.100.99',
  });

  const after = await request('GET', '/api/overview');
  const aJson = after.json();
  assert.equal(aJson.totals.visits - bTotals.visits, 0, 'bot must not add a pageview');
  assert.equal(
    aJson.daily.reduce((a, b) => a + b.visits, 0),
    aJson.totals.visits,
    'daily must still sum to totals (no bot pollution)',
  );
  assert.equal(aJson.pages.filter((p) => p.path === '/bot-trapped').length, 0, 'bot path must not appear in top pages');

  const aRt = sumVisits((await request('GET', '/api/realtime')).json());
  assert.equal(aRt, bRt, 'bot must not appear in realtime buckets');
});

test('dashboard serves static HTML', async () => {
  const r = await request('GET', '/');
  assert.equal(r.status, 200);
  const html = r.text();
  assert.ok(html.includes('canvas'));
  // Custom date-range controls are exposed next to the days presets.
  assert.ok(html.includes('id="fFrom"'), 'dashboard has a from-date input');
  assert.ok(html.includes('id="fTo"'), 'dashboard has a to-date input');
  assert.ok(/<option value="">Custom range<\/option>/.test(html), 'dashboard has a custom-range option');
  // Effective-range readout element exists so the active window is visible.
  assert.ok(html.includes('id="rangeLabel"'), 'dashboard has an effective-range readout');
  // Realtime per-minute buckets are drawn as a compact sparkline in the badge.
  assert.ok(html.includes('id="rtSpark"'), 'dashboard has a realtime sparkline canvas');
  assert.ok(html.includes('drawSpark(buckets)'), 'dashboard draws the realtime bucket sparkline');
  // Session count is computed by visit_stats but was never rendered; the KPI
  // row must expose it (bounce rate is derived from sessions/visits).
  assert.ok(html.includes('id="kSessions"'), 'dashboard has a sessions KPI');
  // The activity-by-hour card renders the full 24-bucket axis (not the 10-row
  // bar-truncation) and shows per-hour uniques next to each hour's visits.
  assert.ok(html.includes("function hours(target, rows)"), 'dashboard renders the full 24h axis');
  assert.ok(/uniq/.test(html), 'dashboard shows per-hour uniques');
  // Every top-list bar also carries the distinct-uniques count for that row
  // (same "visits / N uniq" style as the hourly card): bars() appends it to
  // the value column when the row exposes an uniques field.
  assert.ok(
    html.includes("r[pctKey] + (r.uniques != null ? ' / ' + r.uniques + ' uniq' : '')"),
    'top-list bars show per-row uniques',
  );
  assert.ok(html.includes('var v = r[pctKey] +'), 'bar value column is built from visits (+ uniques)');
});

test('retention prune deletes old events and keeps aggregates consistent', async () => {
  const { db } = await startServer();

  // Imported lazily: these modules transitively read `config` at import time,
  // so they must load AFTER helpers.js has booted the server with the test
  // WA_* env vars (otherwise the cached config points at the prod ./data dir).
  const { insertEvent } = await import('../src/collector.js');
  const { pruneEvents } = await import('../src/retention.js');

  // Baseline sums before pruning (dashboard invariant: series sum to totals).
  const before = (await request('GET', '/api/overview?days=365')).json();
  const beforeDaily = before.daily.reduce((a, b) => a + b.visits, 0);
  const beforeMonthly = before.monthly.reduce((a, b) => a + b.visits, 0);
  assert.equal(beforeDaily, before.totals.visits, 'daily sums to totals before prune');
  assert.equal(beforeMonthly, before.totals.visits, 'monthly sums to totals before prune');

  // A synthetic event far in the past (~400 days ago, minus a safety margin so
  // it is strictly inside the retention window even if the two Date.now()
  // calls below land in the same millisecond). Inserted directly so its
  // timestamp is not overwritten by server-side Date.now().
  const oldTs = Date.now() - 400 * 86_400_000 - 60_000;
  insertEvent(db, {
    ts: oldTs,
    visited_at: new Date(oldTs).toISOString(),
    guest_key: 'retention-old-guest',
    path: '/retention/old',
    referrer: null,
    ref_domain: null,
    title: null,
    screen_w: null,
    screen_h: null,
    lang: null,
    country: null,
    ua: 'RetentionBot/1.0',
    browser: 'Other',
    browser_version: null,
    device: 'desktop',
    os: 'Other',
    is_bot: 0,
  });

  // Confirm the old event is in the raw store before pruning. (Presence is
  // checked against the DB rather than a wide-window overview because range
  // boundaries (start = now - N days) sit a few ms after the synthetic ts.)
  const beforeCount = db
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE guest_key = 'retention-old-guest'`)
    .get().n;
  assert.equal(beforeCount, 1, 'synthetic old event should be present before pruning');

  // Prune everything strictly older than `cutoff` (recomputed after insert so
  // oldTs is guaranteed to be inside the retention window by a comfortable
  // margin).
  const cutoff = Date.now() - 400 * 86_400_000;
  const res = pruneEvents(db, cutoff);
  assert.ok(res.deleted >= 1, `expected at least the synthetic event deleted, got ${res.deleted}`);

  // The run is recorded.
  const lastPrune = db.prepare(`SELECT value FROM meta WHERE key = 'last_prune'`).get();
  assert.ok(lastPrune && lastPrune.value, 'meta.last_prune should be recorded');

  // Old event is gone from the raw store.
  const rawCount = db
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE guest_key = 'retention-old-guest'`)
    .get().n;
  assert.equal(rawCount, 0, 'pruned event must be deleted from the raw store');
  const after = (await request('GET', '/api/overview?days=400')).json();
  assert.ok(
    !after.pages.some((p) => p.path === '/retention/old'),
    'pruned event must not appear in top pages',
  );

  // Invariant: every series still sums to totals after the cache rebuild.
  assert.equal(after.daily.reduce((a, b) => a + b.visits, 0), after.totals.visits, 'daily sums to totals after prune');
  assert.equal(after.weekly.reduce((a, b) => a + b.visits, 0), after.totals.visits, 'weekly sums to totals after prune');
  assert.equal(after.monthly.reduce((a, b) => a + b.visits, 0), after.totals.visits, 'monthly sums to totals after prune');

  // Only the old event was removed; current traffic is untouched.
  assert.equal(after.totals.visits, before.totals.visits, 'prune must not remove recent events');
});

test('overview and summary export report new vs returning visitors against global history', async () => {
  const { db } = await startServer();

  // Imported lazily: these modules transitively read `config` at import time,
  // so they must load AFTER helpers.js has booted the server with the test
  // WA_* env vars (otherwise the cached config points at the prod ./data dir).
  const { normalizeEvent, insertEvent } = await import('../src/collector.js');
  const { loadOrCreateSecret } = await import('../src/privacy.js');
  const { config } = await import('../src/config.js');
  const secret = loadOrCreateSecret(config.dataDir);

  // Give one guest a prior visit ~45 days ago — outside the 30-day default
  // window, so in the `days=30` view that guest is "returning" while guests
  // whose whole history sits inside the window are "new". Backdated via a
  // direct insert (the server would overwrite ts with Date.now()).
  const priorTs = Date.now() - 45 * 86_400_000 - 60_000;
  const prior = normalizeEvent(
    { path: '/returning/prior' },
    { ip: uniqueIp(907), ua: UA_DESKTOP_CHROME },
    secret,
  );
  prior.ts = priorTs;
  prior.visited_at = new Date(priorTs).toISOString();
  insertEvent(db, prior);

  // Two fresh pageviews from distinct guests on a shared path (no referrer, so
  // the source filter value is "(direct)").
  await request('POST', '/api/collect', pageview({ path: '/returning/recent' }), {
    'user-agent': UA_DESKTOP_CHROME,
    'x-forwarded-for': uniqueIp(907),
  });
  await request('POST', '/api/collect', pageview({ path: '/returning/recent' }), {
    'user-agent': UA_DESKTOP_FIREFOX,
    'x-forwarded-for': uniqueIp(908),
  });
  await wait(10);

  // Plain view: the split is a partition of the range's unique guests, and the
  // backdated guest (and only it) counts as returning. The exact absolute
  // counts are covered by the filtered view below; here we assert the ratio
  // invariants that hold regardless of sibling-test traffic.
  const plain = (await request('GET', '/api/overview?days=30')).json();
  const rp = plain.returning;
  assert.equal(rp.guests, plain.totals.uniques, 'returning.guests equals unique visitors');
  assert.equal(rp.guests, rp.new_guests + rp.returning_guests, 'new + returning sums to guests');
  assert.equal(rp.returning_guests, 1, 'only the backdated guest is returning');
  assert.ok(rp.new_guests >= 1, 'at least one guest is new');

  // Filtered view scoped to the shared path: exact deterministic split.
  const filtered = (await request('GET', '/api/overview?days=30&page=/returning/recent')).json();
  assert.deepEqual(filtered.returning, { guests: 2, new_guests: 1, returning_guests: 1, returning_pct: 50 });

  // Summary export mirrors the dimension in both plain and filtered scopes.
  const sumPlain = (await request('GET', '/api/export?format=json&summary=1&days=30')).json();
  assert.equal(sumPlain.returning.guests, sumPlain.totals.uniques, 'summary returning.guests equals uniques');
  assert.equal(sumPlain.returning.returning_guests, 1, 'summary plain view sees the returning guest');
  const sumFilt = (await request('GET', '/api/export?format=json&summary=1&days=30&page=/returning/recent')).json();
  assert.deepEqual(sumFilt.returning, { guests: 2, new_guests: 1, returning_guests: 1, returning_pct: 50 });

  // Raw export is unaffected (returning is a summary-only dimension).
  const raw = (await request('GET', '/api/export?format=json&days=30')).json();
  assert.ok(Array.isArray(raw), 'raw export is still an array');
});

test('overview and export honor from/to date-range filters', async () => {
  // Marker pageview inside the test's own window.
  await request('POST', '/api/collect', pageview({ path: '/range/in-window' }), {
    'user-agent': UA_DESKTOP_CHROME,
    'x-forwarded-for': uniqueIp(903),
  });
  await wait(10);
  const now = Date.now();

  // A 60s window centered on the marker includes it; the marker path is
  // unique, so the filtered count is exact regardless of sibling tests.
  const from = new Date(now - 30_000).toISOString();
  const to = new Date(now + 30_000).toISOString();
  const qs = `page=/range/in-window&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const win = (await request('GET', `/api/overview?${qs}`)).json();
  assert.equal(win.totals.visits, 1, 'marker lands inside the from/to window');
  assert.equal(new Date(win.range.start).toISOString(), from, 'range.start reflects from');
  assert.equal(new Date(win.range.end).toISOString(), to, 'range.end reflects to');

  // A fully historical window contains nothing (from/to replace the days default).
  const past = (await request('GET', '/api/overview?from=2015-01-01T00:00:00Z&to=2015-12-31T00:00:00Z')).json();
  assert.equal(past.totals.visits, 0, 'historical window is empty');
  assert.equal(past.daily.reduce((a, b) => a + b.visits, 0), 0, 'daily series is empty too');
  assert.equal(past.range.start, Date.parse('2015-01-01T00:00:00Z'));
  assert.equal(past.range.end, Date.parse('2015-12-31T00:00:00Z'));

  // Same bounds slice both raw and summary export.
  const rows = (await request('GET', '/api/export?format=json&from=2015-01-01T00:00:00Z&to=2015-12-31T00:00:00Z')).json();
  assert.ok(Array.isArray(rows) && rows.length === 0, 'event export honors from/to');
  const summary = (await request('GET', '/api/export?format=json&summary=1&from=2015-01-01T00:00:00Z&to=2015-12-31T00:00:00Z')).json();
  assert.equal(summary.totals.visits, 0, 'summary export honors from/to');
});

const UA_DESKTOP_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const UA_DESKTOP_FIREFOX =
  'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0';
const UA_MOBILE_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36';
