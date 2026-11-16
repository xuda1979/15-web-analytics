// Local user-agent parsing (ua-parser-js). Everything stays on the box.

import { UAParser } from 'ua-parser-js';

const parserCache = new Map();

export function parseUa(ua) {
  const key = ua || '';
  if (parserCache.has(key)) return parserCache.get(key);
  const parser = new UAParser(key);
  const res = parser.getResult();
  const out = {
    browser: res.browser?.name || 'Unknown',
    browserVersion: res.browser?.major || res.browser?.version || '',
    os: res.os?.name || 'Unknown',
    device: res.device?.type || 'desktop',
    deviceModel: res.device?.model || '',
  };
  parserCache.set(key, out);
  return out;
}

export function isBot(ua) {
  return /bot|crawl|spider|slurp|pinterest|monitor|uptime|preview/i.test(ua || '');
}
