// Local user-agent parsing (ua-parser-js). Everything stays on the box.

import { UAParser } from 'ua-parser-js';

// Bounded parse cache. Repeats (re-loads, re-collects) skip reparsing, while
// the cap keeps memory bounded: cache keys are visitor-controlled UA strings
// arriving on the public collect endpoint, whose cardinality must not be
// allowed to grow unbounded. Exported for the cache-bounding test.
export const PARSER_CACHE_MAX = 1000;
export const parserCache = new Map();

export function parseUa(ua) {
  const key = ua || '';
  const hit = parserCache.get(key);
  if (hit) {
    // Refresh recency so a still-active UA string is not the first evicted.
    parserCache.delete(key);
    parserCache.set(key, hit);
    return hit;
  }
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
  if (parserCache.size > PARSER_CACHE_MAX) {
    // Evict the oldest-inserted key (Map preserves insertion order).
    parserCache.delete(parserCache.keys().next().value);
  }
  return out;
}

export function isBot(ua) {
  return /bot|crawl|spider|slurp|pinterest|monitor|uptime|preview/i.test(ua || '');
}
