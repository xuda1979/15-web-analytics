// Fixed-window rate limiter for the collect endpoint.
//
// Public collect endpoints get hammered (or worse, abused) in the wild, and an
// unbounded POST body pump + row insert is the easiest thing to point a script
// at. Limits are keyed by the client IP with a fixed window:
//   - window start = floor(now / windowMs) * windowMs
//   - at most `limit` requests per window; 429 sets Retry-After (seconds)
//
// The count map is capped so a swarm of spoofed X-Forwarded-For values cannot
// grow memory without bound:
//   - tick() evicts previous-window entries once the map is at the cap, and
//   - the Map doubles as an LRU (every access re-inserts the key at the tail),
//     so a same-window flood of distinct keys evicts the least-recently-touched
//     key and the map can never exceed maxEntries even before a window rolls.

export class RateLimiter {
  constructor({ windowMs = 60_000, limit = 60, maxEntries = 10_000 } = {}) {
    this.windowMs = windowMs;
    this.limit = limit;
    this.maxEntries = maxEntries;
    this.counts = new Map(); // key -> { winStart, count }; iteration order = recency
  }

  keyFor(now = Date.now()) {
    return Math.floor(now / this.windowMs) * this.windowMs;
  }

  tick(now = Date.now()) {
    if (this.counts.size < this.maxEntries) return;
    const cutoff = this.keyFor(now) - this.windowMs;
    for (const [key, entry] of this.counts) {
      if (entry.winStart < cutoff) this.counts.delete(key);
    }
  }

  // Mark a key as just-touched by moving it to the map tail (O(1)); the head is
  // then the least-recently-used key and can be evicted in O(1) at the cap.
  _touch(key, entry) {
    this.counts.delete(key);
    this.counts.set(key, entry);
  }

  // Returns 0 when the request is allowed, otherwise ms until the caller may
  // retry (used for Retry-After).
  check(key, now = Date.now()) {
    this.tick(now);
    const k = this.keyFor(now);
    const entry = this.counts.get(key);
    if (!entry || entry.winStart !== k) {
      if (this.counts.size >= this.maxEntries) {
        // Same-window flood hit the cap: drop the least-recently-touched key.
        this.counts.delete(this.counts.keys().next().value);
      }
      this.counts.set(key, { winStart: k, count: 1 });
      return 0;
    }
    const retry = entry.count >= this.limit ? this.windowMs - (now % this.windowMs) : 0;
    if (retry === 0) entry.count += 1;
    this._touch(key, entry);
    return retry;
  }
}
