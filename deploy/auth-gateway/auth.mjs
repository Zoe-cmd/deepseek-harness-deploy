/**
 * Login credential checking and brute-force rate limiting.
 *
 * The access token is compared in constant time (via SHA-256 pre-hash +
 * timingSafeEqual) so response timing does not leak token length or prefix.
 * The real token is never logged, echoed, or sent back to the browser.
 */

import { createHash, timingSafeEqual } from 'node:crypto'

/** Constant-time string comparison (safe against length leaks). */
export function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest()
  const hb = createHash('sha256').update(String(b)).digest()
  return timingSafeEqual(ha, hb)
}

/**
 * Sliding-window per-IP login limiter. Buckets keyed by client ip; each bucket
 * records the attempt window and the failure count.
 */
export class RateLimiter {
  /**
   * @param {object} options
   * @param {number} options.max - failures allowed per window.
   * @param {number} options.windowMs - window length in ms.
   * @param {number} options.banMs - how long the block lasts after exceeding max.
   */
  constructor({ max, windowMs, banMs }) {
    this.max = max
    this.windowMs = windowMs
    this.banMs = banMs
    this.buckets = new Map()
    this._sweepTimer = setInterval(() => this.sweep(), 30000)
    this._sweepTimer.unref?.()
  }

  /**
   * Check whether a login attempt from `ip` is currently allowed.
   * @returns {object} `{ allowed, retryAfterSeconds }`
   */
  check(ip) {
    const now = Date.now()
    const bucket = this.buckets.get(ip)
    if (bucket === undefined) return { allowed: true }
    if (bucket.until > now) {
      return { allowed: false, retryAfterSeconds: Math.ceil((bucket.until - now) / 1000) }
    }
    if (bucket.started + this.windowMs <= now) {
      this.buckets.delete(ip)
      return { allowed: true }
    }
    return { allowed: bucket.failures < this.max }
  }

  /** Record a failed login attempt from `ip`. */
  recordFailure(ip) {
    const now = Date.now()
    let bucket = this.buckets.get(ip)
    if (bucket === undefined || bucket.started + this.windowMs <= now) {
      bucket = { failures: 0, started: now, until: 0 }
      this.buckets.set(ip, bucket)
    }
    bucket.failures += 1
    if (bucket.failures >= this.max) {
      bucket.until = now + this.banMs
    }
  }

  /** Drop stale buckets. */
  sweep() {
    const now = Date.now()
    for (const [ip, bucket] of this.buckets) {
      if (bucket.until < now && bucket.started + this.windowMs * 2 < now) {
        this.buckets.delete(ip)
      }
    }
  }

  close() {
    clearInterval(this._sweepTimer)
    this.buckets.clear()
  }
}