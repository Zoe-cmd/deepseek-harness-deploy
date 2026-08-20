/**
 * Server-side session store for the DSH auth gateway.
 *
 * Sessions are random 256-bit ids handed to the browser in an HttpOnly cookie.
 * The store keeps only the HMAC-SHA256 of the id (keyed by SESSION_SECRET), so
 * a leaked store file does not expose usable session ids and the raw cookie
 * value is never logged. Records carry an absolute max lifetime and optional
 * sliding expiry.
 */

import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** One stored session record. `key` is HMAC(sessionId, secret). */
class SessionRecord {
  constructor(key, fingerprint, now, ttlMs, maxMs) {
    this.key = key
    this.fingerprint = fingerprint
    this.createdAt = now
    this.expiresAt = now + ttlMs
    this.maxExpiresAt = now + maxMs
  }

  get expired() {
    return Date.now() >= Math.min(this.expiresAt, this.maxExpiresAt)
  }
}

export class SessionStore {
  /**
   * @param {object} options
   * @param {string} options.secret - HMAC key for stored session ids.
   * @param {number} options.ttlMs - session lifetime in ms.
   * @param {number} options.maxLifetimeMs - absolute max lifetime in ms.
   * @param {boolean} options.sliding - refresh the ttl on activity.
   * @param {boolean} options.bindIp - additionally pin sessions to the client ip.
   */
  constructor({ secret, ttlMs, maxLifetimeMs, sliding, bindIp }) {
    this.secret = secret
    this.ttlMs = ttlMs
    this.maxLifetimeMs = maxLifetimeMs
    this.sliding = sliding
    this.bindIp = bindIp
    this.records = new Map()
    this._sweepTimer = setInterval(() => this.sweep(), 60000)
    this._sweepTimer.unref?.()
  }

  /** HMAC key for a session id — never store the raw id. */
  keyOf(sessionId) {
    return createHmac('sha256', this.secret).update(sessionId).digest('base64url')
  }

  /** Opaque fingerprint: client ip (+ user agent hash when binding). */
  fingerprintOf(ip, ua) {
    if (!this.bindIp) return ip ? `ip:${ip}` : 'ip:'
    const uaHash = ua ? createHash('sha256').update(ua).digest('hex').slice(0, 16) : '?'
    return `ip:${ip}|ua:${uaHash}`
  }

  /** Create a session; returns the raw id to set in the cookie. */
  create(ip, ua) {
    const sessionId = randomBytes(32).toString('base64url')
    const key = this.keyOf(sessionId)
    const now = Date.now()
    this.records.set(key, new SessionRecord(
      key,
      this.fingerprintOf(ip, ua),
      now,
      this.ttlMs,
      this.maxLifetimeMs,
    ))
    return sessionId
  }

  /**
   * Validate a raw cookie value.
   * @returns {object} `{ ok, expired, fingerprint }`
   */
  validate(sessionId, ip, ua) {
    if (typeof sessionId !== 'string' || sessionId === '') return { ok: false }
    const key = this.keyOf(sessionId)
    const record = this.records.get(key)
    if (record === undefined) return { ok: false }
    if (record.expired) {
      this.records.delete(key)
      return { ok: false, expired: true }
    }
    if (this.bindIp && record.fingerprint !== this.fingerprintOf(ip, ua)) {
      // Fingerprint changed (roaming / theft): destroy the session.
      this.records.delete(key)
      return { ok: false }
    }
    if (this.sliding) {
      record.expiresAt = Date.now() + this.ttlMs
    }
    return { ok: true, expired: false, fingerprint: record.fingerprint }
  }

  /** Destroy a session; returns true when it existed. */
  destroy(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return false
    return this.records.delete(this.keyOf(sessionId))
  }

  /** Drop expired records. */
  sweep() {
    const now = Date.now()
    for (const [key, record] of this.records) {
      if (now >= Math.min(record.expiresAt, record.maxExpiresAt)) this.records.delete(key)
    }
  }

  get size() {
    return this.records.size
  }

  /** Constant-time comparison helper (kept here for symmetric usage). */
  static safeEqual(a, b) {
    const ha = createHash('sha256').update(String(a)).digest()
    const hb = createHash('sha256').update(String(b)).digest()
    return timingSafeEqual(ha, hb)
  }

  close() {
    clearInterval(this._sweepTimer)
    this.records.clear()
  }
}