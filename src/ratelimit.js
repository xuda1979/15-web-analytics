// Fixed-window rate limiter for the collect endpoint.
//
// Public collect endpoints get hammered (or worse, abused) in the wild, and an
// unbounded POST body pump + row insert is the easiest thing to point a script
// at. Limits are keyed by the client IP with a fixed window:
//   - window start = floor(now / windowMs) * windowMs
//   - at most `limit` requests per window; 429 sets Retry-After (seconds)
//
// The count map is capped (old windows evicted on tick) so a swarm of spoofed
// X-Forwarded-For values cannot grow memory without bound.

export class RateLimiter {
  constructor({ windowMs = 60_000, limit = 60, maxEntries = 10_000 } = {}) {
    this.windowMs = windowMs;
    this.limit = limit;
    this.maxEntries = maxEntries;
    this.counts = new Map(); // key -> { winStart, count }
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

  // Returns 0 when the request is allowed, otherwise ms until the caller may
  // retry (used for Retry-After).
  check(key, now = Date.now()) {
    this.tick(now);
    const k = this.keyFor(now);
    const entry = this.counts.get(key);
    if (!entry || entry.winStart !== k) {
      this.counts.set(key, { winStart: k, count: 1 });
      return 0;
    }
    if (entry.count >= this.limit) {
      return this.windowMs - (now % this.windowMs);
    }
    entry.count += 1;
    return 0;
  }
}
