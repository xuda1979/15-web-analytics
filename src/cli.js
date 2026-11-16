// CLI helpers: simulate demo visits (seed), generate a privacy audit.

import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { config, ensureDataDir } from './config.js';
import { openDb } from './store.js';
import { loadOrCreateSecret } from './privacy.js';
import { insertEvent, normalizeEvent, refreshEntryExit } from './collector.js';
import { generateAudit } from './audit.js';

const UA_POOL = {
  desktop_chrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  desktop_ff:
    'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0',
  mobile_safari_iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  mobile_android_chrome:
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36',
  bot_google:
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
};

const PATHS = ['/', '/pricing', '/docs', '/blog', '/blog/cookies', '/features', '/about', '/contact'];

export function seed(db, { days = 60, visitors = 12, verbose = false } = {}) {
  const secret = loadOrCreateSecret(config.dataDir);
  const start = Date.now() - days * 24 * 3600 * 1000;
  const refs = ['https://google.com/search', 'https://github.com/', '', 'https://news.ycombinator.com/', 'https://twitter.com/'];
  const uaKeys = Object.keys(UA_POOL).filter((k) => !k.startsWith('bot_'));
  let n = 0;
  const step = 7 * 24 * 3600 * 1000 / (visitors * 6); // ~7 visits per visitor per week

  for (let v = 0; v < visitors; v++) {
    const ua = UA_POOL[uaKeys[v % uaKeys.length]];
    const ip = `192.168.${v % 8}.${20 + v}`;
    const cur = new Date(start + Math.floor(Math.random() * 6) * 3600e3);
    const pageviews = 4 + (v % 4);
    for (let p = 0; p < pageviews; p++) {
      const ts = Math.max(start, cur.getTime() + p * (45 + (v % 8) * 10) * 1000);
      const path = PATHS[(v + p) % PATHS.length];
      const payload = {
        path,
        referrer: p === 0 ? refs[v % refs.length] : '',
        title: path.replace(/^\//, '') || 'Home',
        sw: v % 2 ? 1440 : 390,
        sh: v % 2 ? 900 : 844,
        lang: v % 3 ? 'zh-CN' : 'en-US',
      };
      const event = normalizeEvent(payload, { ip, ua }, secret);
      insertEvent(db, event);
      n++;
      const nextBase = ts + (60 + Math.random() * 240) * 1000;
      cur.setTime(Math.min(nextBase, Date.now() - 5 * 60 * 1000));
    }
  }
  // Add a couple of bot events (should be ignored by metrics).
  for (let i = 0; i < 2; i++) {
    const event = normalizeEvent({ path: '/' }, { ip: '198.51.100.9', ua: UA_POOL.bot_google }, secret);
    insertEvent(db, { ...event, is_bot: 1 });
  }
  refreshEntryExit(db, start);
  if (verbose) console.log(`seeded ${n} real events + 2 bots over ${days} days`);
  return n;
}

function main() {
  const [, , cmd, ...rest] = process.argv;
  ensureDataDir();
  const db = openDb();
  try {
    if (cmd === 'seed') {
      seed(db, { verbose: true });
    } else if (cmd === 'collect') {
      collectOnce(db, rest);
    } else if (cmd === 'audit') {
      const report = generateAudit(db);
      highlight(report);
    } else {
      console.log('usage: node src/cli.js <seed|collect|audit>');
    }
  } finally {
    db.close();
  }
}

// One-shot HTTP pageview collect: POSTs and records the parsed response.
// Useful for scripted/curl-style column fill without writing a browser.
function collectOnce(db, args) {
  const secret = loadOrCreateSecret(config.dataDir);
  const options = collectArgs(args);
  const ip = options['ip'] || '127.0.0.1';
  const ua = options['ua'] || 'cli/1.0';
  const event = normalizeEvent(
    {
      path: options['path'] || '/',
      referrer: options['referrer'] || '',
      title: options['title'] || '',
      sw: int(pattern(args, /^--sw=(\d+)/), 0),
      sh: int(pattern(args, /^--sh=(\d+)/), 0),
      lang: options['lang'] || '',
    },
    { ip, ua },
    secret,
  );
  const { id, isUnique } = insertEvent(db, event);
  console.log(`collect: id=${id} path=${event.path} unique=${isUnique}`);
}

function int(v, fallback) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function collectArgs(args) {
  const opts = {};
  for (const a of args) {
    const m = a.match(/^--([a-z-]+)=(.*)$/);
    if (m) opts[m[1]] = m[2];
  }
  return opts;
}

function pattern(args, re) {
  for (const a of args) {
    const m = a.match(re);
    if (m) return m[1];
  }
  return null;
}

function highlight(report) {
  console.log('Privacy audit report:');
  for (const check of report.checks) {
    console.log(`  [${check.status.toUpperCase()}] ${check.label}`);
  }
  console.log(
    `events=${report.stats.events} real=${report.stats.real_events} guests=${report.stats.guests} ip_rows=${report.stats.ip_rows}`,
  );
  console.log(`db=${report.stats.db_path} (${report.stats.bytes_readable})`);
  console.log('Use /api/audit?format=text for the full plain-text report.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
