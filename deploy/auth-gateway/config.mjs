/**
 * Configuration loader for the DSH auth gateway.
 *
 * Values are read from environment variables, with an optional `.env` file
 * (KEY=VALUE, `#` comments, quoted values) at the deployment root.
 *
 * Security contract: no secret (access token / session secret / session id)
 * is ever printed here or anywhere in this gateway.
 */

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const GATEWAY_DIR = dirname(fileURLToPath(import.meta.url))
export const DEPLOY_ROOT = resolve(GATEWAY_DIR, '..')

/** Parse a simple `KEY=VALUE` dotenv file (no expansion, no interpolation). */
export function parseDotenv(content) {
  const out = {}
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

/** Load `.env` from the deployment root, if present. Real `.env` is git-ignored. */
export function loadDotenv() {
  const candidates = [
    resolve(DEPLOY_ROOT, '.env'),
    process.env.DSH_AUTH_ENV_FILE,
  ].filter(Boolean)
  for (const file of candidates) {
    if (file && existsSync(file)) {
      const parsed = parseDotenv(readFileSync(file, 'utf8'))
      for (const [key, value] of Object.entries(parsed)) {
        if (process.env[key] === undefined) process.env[key] = value
      }
      return file
    }
  }
  return null
}

/** Read a non-empty string env value with a default. */
function str(name, fallback) {
  const value = process.env[name]
  return value !== undefined && value !== '' ? value : fallback
}

/** Read an integer env value with a default. */
function int(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`invalid ${name}: ${JSON.stringify(raw)} (expected a non-negative integer)`)
  }
  return parsed
}

/** Read a boolean env value with a default. */
function bool(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  if (/^(1|true|yes|on)$/i.test(raw)) return true
  if (/^(0|false|no|off)$/i.test(raw)) return false
  throw new Error(`invalid ${name}: ${JSON.stringify(raw)} (expected true/false)`)
}

/** Runtime configuration for the gateway. All values come from environment variables. */
export function loadConfig() {
  const config = {
    // Access token that unlocks the Harness. Required; the gateway refuses to
    // start without it so a misconfigured deployment cannot silently allow
    // anyone in.
    accessToken: str('HARNESS_ACCESS_TOKEN', ''),
    // Key that HMACs stored session ids. Optional: a random key is generated
    // at startup when absent, which keeps sessions secure but makes them not
    // survive a restart.
    sessionSecret: str('SESSION_SECRET', ''),

    // Session lifetime in seconds (default 24h). SESSION_MAX_LIFETIME_SECONDS
    // caps total life even with sliding refresh (default 7d).
    sessionExpireSeconds: int('SESSION_EXPIRE_SECONDS', 86400),
    sessionMaxLifetimeSeconds: int('SESSION_MAX_LIFETIME_SECONDS', 604800),
    sessionSliding: bool('SESSION_SLIDING', true),
    sessionCookieName: str('SESSION_COOKIE_NAME', 'dsh_session'),
    // Hardening: bind a session to the client IP. Enable only when users do
    // not roam across IPs (e.g. VPN / fixed office IPs).
    sessionBindIp: bool('SESSION_BIND_IP', false),

    // Listen address of the gateway itself. Must stay on loopback; nginx is
    // the only public face.
    authHost: str('AUTH_HOST', '127.0.0.1'),
    authPort: int('AUTH_PORT', 3081),

    // Upstream DeepSeek Harness (also loopback-only).
    harnessHost: str('HARNESS_HOST', '127.0.0.1'),
    harnessPort: int('HARNESS_PORT', 3080),

    // The browser-facing scheme the gateway sees (used for Secure cookies and
    // redirect targets). Always true behind TLS nginx; set to false only for
    // plain-HTTP development.
    cookieSecure: bool('COOKIE_SECURE', true),

    // Login brute-force protection. Same IP may fail RATE_LIMIT_MAX times per
    // RATE_LIMIT_WINDOW_MS, then is refused with 429.
    rateLimitMax: int('RATE_LIMIT_MAX', 10),
    rateLimitWindowMs: int('RATE_LIMIT_WINDOW_MS', 900000),
    rateLimitBanMs: int('RATE_LIMIT_BAN_MS', 900000),

    // Trust the first X-Forwarded-For entry as the client IP. Safe because the
    // gateway only listens on loopback and nginx overwrites the header.
    trustProxy: bool('TRUST_PROXY', true),
  }

  if (config.sessionExpireSeconds < 5) {
    throw new Error('SESSION_EXPIRE_SECONDS must be at least 5')
  }
  if (config.sessionMaxLifetimeSeconds < config.sessionExpireSeconds) {
    throw new Error('SESSION_MAX_LIFETIME_SECONDS must be >= SESSION_EXPIRE_SECONDS')
  }
  if (config.rateLimitWindowMs < 1000 || config.rateLimitBanMs < 1000) {
    throw new Error('rate-limit windows must be at least 1000 ms')
  }
  return config
}

/** The effective session secret: configured value, or a fresh random one. */
export function effectiveSecret(config) {
  if (config.sessionSecret) return config.sessionSecret
  return process.env.DSH_EPHEMERAL_SECRET ?? randomSecret()
}

/** Generate a 32-byte base64url secret. */
export function randomSecret() {
  return randomBytes(32).toString('base64url')
}