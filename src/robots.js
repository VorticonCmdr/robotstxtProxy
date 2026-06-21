// RobotsCache: fetches a target origin's robots.txt, caches it (TTL + size-bounded),
// and decides whether a given URL is allowed for a given user-agent.
//
// Status policy (per the agreed fail-mode):
//   2xx  -> parse the body and apply the rules
//   4xx  -> "allow all"  (missing/forbidden robots.txt = no restrictions, per the spec)
//   5xx / network error / timeout -> "block all"
import { RobotsMatcher } from 'google-robotstxt-parser';

export class RobotsCache {
  /**
   * @param {object} opts
   * @param {object} opts.config  resolved config (cacheTtlMs, cacheMax, robotsTimeoutMs, robotsUa)
   * @param {object} [opts.logger]
   * @param {Function} [opts.fetchImpl]  fetch-compatible function (injectable for tests)
   */
  constructor({ config, logger, fetchImpl } = {}) {
    this.config = config;
    this.logger = logger;
    this.fetch = fetchImpl || globalThis.fetch;
    /** @type {Map<string, {policy: string, body: string, expires: number}>} */
    this.cache = new Map();
    /** @type {Map<string, Promise>} in-flight fetches, deduped by origin */
    this.pending = new Map();
  }

  /**
   * @param {string} targetUrl  the full URL the client wants to reach
   * @param {string|null} requestUa  the client's User-Agent (used unless ROBOTS_UA is set)
   * @returns {Promise<{allowed: boolean, reason: string, line: number}>}
   */
  async decide(targetUrl, requestUa) {
    const url = new URL(targetUrl);
    const origin = url.origin;
    const ua = this.config.robotsUa || requestUa || '*';

    const entry = await this._getEntry(origin);

    if (entry.policy === 'allow') {
      return { allowed: true, reason: 'robots-absent', line: 0 };
    }
    if (entry.policy === 'block') {
      return { allowed: false, reason: 'robots-unavailable', line: 0 };
    }

    // policy === 'parse'
    const matcher = new RobotsMatcher();
    const allowed = matcher.oneAgentAllowedByRobots(entry.body, ua, targetUrl);
    return {
      allowed,
      reason: allowed ? 'robots-allow' : 'robots-disallow',
      line: matcher.matchingLine(),
    };
  }

  async _getEntry(origin) {
    const cached = this.cache.get(origin);
    if (cached && cached.expires > this._now()) return cached;

    if (this.pending.has(origin)) return this.pending.get(origin);

    const p = this._fetchEntry(origin).finally(() => this.pending.delete(origin));
    this.pending.set(origin, p);
    return p;
  }

  async _fetchEntry(origin) {
    const robotsUrl = `${origin}/robots.txt`;
    let entry;
    let ttlMs = this.config.cacheTtlMs;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.robotsTimeoutMs);
      let res;
      try {
        res = await this.fetch(robotsUrl, {
          signal: controller.signal,
          redirect: 'follow',
          headers: { 'user-agent': 'robotstxt-proxy' },
        });
      } finally {
        clearTimeout(timer);
      }

      // Respect Cache-Control: max-age from the robots.txt response, capped at config ceiling.
      const cc = (res.headers?.get?.('cache-control') || '').toLowerCase();
      const maxAgeMatch = /max-age\s*=\s*(\d+)/.exec(cc);
      if (maxAgeMatch) {
        ttlMs = Math.min(parseInt(maxAgeMatch[1], 10) * 1000, this.config.cacheTtlMs);
      }

      if (res.ok) {
        const body = await res.text();
        entry = { policy: 'parse', body };
      } else if (res.status >= 400 && res.status < 500) {
        entry = { policy: 'allow', body: '' };
      } else {
        entry = { policy: 'block', body: '' };
      }
      this.logger?.debug('robots fetched', { origin, status: res.status, policy: entry.policy });
    } catch (err) {
      // Network error, timeout/abort, DNS failure, etc. -> fail closed.
      entry = { policy: 'block', body: '' };
      this.logger?.warn('robots fetch failed', { origin, error: err.message });
    }

    entry.expires = this._now() + ttlMs;
    entry.ttlMs = ttlMs;
    entry.isOverride = false;
    this._set(origin, entry);
    return entry;
  }

  /** Returns a snapshot of all cache entries for the dashboard UI. */
  getAll() {
    const now = this._now();
    return [...this.cache.entries()].map(([origin, e]) => ({
      origin,
      policy: e.policy,
      expiresAt: e.expires,
      ttlMs: e.ttlMs ?? this.config.cacheTtlMs,
      isOverride: e.isOverride ?? false,
      remainingMs: Math.max(0, e.expires - now),
      body: e.body ?? '',
    }));
  }

  /** Removes an origin from the cache; the next request will re-fetch. */
  remove(origin) {
    this.cache.delete(origin);
  }

  /** Manually pins a robots.txt body for an origin without a network fetch. */
  override(origin, body) {
    const entry = {
      policy: 'parse',
      body,
      expires: this._now() + this.config.cacheTtlMs,
      ttlMs: this.config.cacheTtlMs,
      isOverride: true,
    };
    if (this.cache.has(origin)) this.cache.delete(origin);
    this.cache.set(origin, entry);
    while (this.cache.size > this.config.cacheMax) {
      this.cache.delete(this.cache.keys().next().value);
    }
  }

  _set(origin, entry) {
    // Refresh insertion order so eviction is least-recently-set.
    if (this.cache.has(origin)) this.cache.delete(origin);
    this.cache.set(origin, entry);
    while (this.cache.size > this.config.cacheMax) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
  }

  _now() {
    return Date.now();
  }
}
