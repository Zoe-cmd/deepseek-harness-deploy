/**
 * DeepSeek Harness auth gateway — main server.
 *
 * Every request reaching this gateway passes the session check before it can
 * reach the Harness. The only public entry is nginx (HTTPS) which proxies to
 * this gateway on loopback; the Harness itself stays on 127.0.0.1:3080 and is
 * never bound to a public interface.
 *
 * Routes:
 *   GET  /login            token login page
 *   POST /login            token verification -> session cookie (rate limited)
 *   GET|POST /logout       destroy session + clear cookie
 *   GET  /healthz          liveness probe (no auth)
 *   everything else        session-required reverse proxy to the Harness
 */

import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { loadConfig, loadDotenv, effectiveSecret } from './config.mjs'
import { SessionStore } from './session.mjs'
import { RateLimiter, safeEqual } from './auth.mjs'
import { proxyHttp, proxyWebSocket, securityHeaders, clientIp } from './proxy.mjs'
import { renderLogin, renderErrorPage, LOGIN_CSP } from './views.mjs'

const VERSION = '1.0.0'

/** UTC log line; secrets are never passed to this function. */
function log(event, fields = {}) {
  const parts = [`[${new Date().toISOString()}]`, event]
  for (const [key, value] of Object.entries(fields)) parts.push(`${key}=${value}`)
  process.stdout.write(`${parts.join(' ')}\n`)
}

/** Parse the request cookie header into a name->value map. */
function parseCookies(req) {
  const header = req.headers.cookie
  if (typeof header !== 'string' || header === '') return new Map()
  const out = new Map()
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    let value = part.slice(eq + 1).trim()
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    if (name !== '') out.set(name, decodeURIComponent(value))
  }
  return out
}

/** Read a request body up to a size cap. Returns a Buffer. */
function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limitBytes) {
        if (!settled) {
          settled = true
          reject(new Error('body too large'))
          req.destroy()
        }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    })
    req.on('error', (err) => {
      if (!settled) {
        settled = true
        reject(err)
      }
    })
  })
}

/** Verify the gateway's own CSRF policy on state-changing requests. */
function originAllowed(req, config) {
  const origin = req.headers.origin
  if (origin === undefined) return true // non-browser client (curl etc.)
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return false
  const hostname = hostnameOf(host)
  if (hostname === '') return false
  // Browsers in strict-privacy mode (and pages served with
  // `referrer-policy: no-referrer`) send `Origin: null` on form POSTs while
  // still sending a same-origin Referer. Fall back to the Referer hostname so
  // legitimate logins work; cross-site attackers cannot forge a matching one.
  if (origin === 'null') {
    const referer = req.headers.referer
    if (typeof referer !== 'string' || referer === '') return false
    try {
      return hostnameOf(new URL(referer).hostname) === hostname
    } catch {
      return false
    }
  }
  try {
    const originUrl = new URL(origin)
    // Compare hostnames only (not ports). nginx forwards `Host: $host` which
    // strips the port, while browsers may keep `:443` in the Origin when the
    // URL was typed with an explicit port — both represent the same origin.
    return hostnameOf(originUrl.hostname) === hostname
  } catch {
    return false
  }
}

/** Strip a leading `www.`-style prefix? No: strip IPv6 brackets/port from a hostname. */
function hostnameOf(value) {
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end > 0 ? value.slice(0, end + 1) : ''
  }
  return value.split(':')[0]
}

/** Build a Set-Cookie header value for the session id. */
function sessionCookieValue(config, sessionId, maxAgeSeconds) {
  const attrs = [
    `${config.sessionCookieName}=${sessionId}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    config.cookieSecure ? 'Secure' : null,
    `Max-Age=${maxAgeSeconds}`,
  ].filter(Boolean)
  return attrs.join('; ')
}

/** Sanitize the post-login redirect target to a same-origin path. */
function safeNext(raw) {
  if (typeof raw !== 'string' || raw === '') return '/'
  if (raw.startsWith('//')) return '/'
  if (!raw.startsWith('/')) return '/'
  return raw
}

export function createGateway(config) {
  const secret = effectiveSecret(config)
  const sessions = new SessionStore({
    secret,
    ttlMs: config.sessionExpireSeconds * 1000,
    maxLifetimeMs: config.sessionMaxLifetimeSeconds * 1000,
    sliding: config.sessionSliding,
    bindIp: config.sessionBindIp,
  })
  const limiter = new RateLimiter({
    max: config.rateLimitMax,
    windowMs: config.rateLimitWindowMs,
    banMs: config.rateLimitBanMs,
  })

  if (!config.accessToken) {
    log('FATAL', { reason: 'HARNESS_ACCESS_TOKEN is required; refusing to start' })
    process.exit(1)
  }
  if (!config.sessionSecret) {
    log('WARN', { reason: 'SESSION_SECRET not set; sessions will not survive a restart' })
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      log('ERROR', { path: req.url, message: err.message })
      if (!res.headersSent) {
        res.writeHead(500, securityHeaders({ 'content-type': 'text/plain; charset=utf-8' }))
        res.end('Internal Server Error')
      } else {
        res.destroy()
      }
    })
  })

  const proxyStatus = (req, status) => {
    log('PROXY', { status, method: req.method, path: req.url, ip: clientIp(req, config.trustProxy) })
  }

  async function handleRequest(req, res) {
    const url = new URL(req.url, 'http://internal')
    const pathname = url.pathname

    // --- health probe (unauthenticated) -----------------------------------
    if (pathname === '/healthz') {
      res.writeHead(200, securityHeaders({ 'content-type': 'application/json' }))
      res.end(JSON.stringify({ status: 'ok', version: VERSION }))
      return
    }

    // --- login page ---------------------------------------------------------
    if (pathname === '/login' && (req.method === 'GET' || req.method === 'HEAD')) {
      const cookies = parseCookies(req)
      const sid = cookies.get(config.sessionCookieName)
      if (sid && sessions.validate(sid, clientIp(req, config.trustProxy), req.headers['user-agent']).ok) {
        res.writeHead(302, { location: safeNext(url.searchParams.get('next')) })
        res.end()
        return
      }
      const body = renderLogin({
        error: url.searchParams.get('error') ?? undefined,
        next: safeNext(url.searchParams.get('next')),
      })
      res.writeHead(req.method === 'HEAD' ? 200 : 200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'referrer-policy': 'strict-origin-when-cross-origin',
        'cross-origin-opener-policy': 'same-origin',
        'content-security-policy': LOGIN_CSP,
      })
      res.end(req.method === 'HEAD' ? undefined : body)
      return
    }

    // --- login submission -----------------------------------------------------
    if (pathname === '/login' && req.method === 'POST') {
      if (!originAllowed(req, config)) {
        log('LOGIN_CSRF_REJECTED', {
          ip: clientIp(req, config.trustProxy),
          origin: String(req.headers.origin ?? '(none)'),
          host: String(req.headers.host ?? '(none)'),
        })
        res.writeHead(403, securityHeaders({ 'content-type': 'application/json' }))
        res.end(JSON.stringify({ error: 'forbidden' }))
        return
      }
      const ip = clientIp(req, config.trustProxy)
      const limit = limiter.check(ip)
      if (!limit.allowed) {
        log('RATE_LIMIT', { ip })
        res.writeHead(429, securityHeaders({
          'content-type': 'application/json',
          'retry-after': String(limit.retryAfterSeconds),
        }))
        res.end(JSON.stringify({ error: 'too many attempts', retryAfter: limit.retryAfterSeconds }))
        return
      }

      const contentType = String(req.headers['content-type'] ?? '')
      let token = ''
      let next = '/'
      if (contentType.includes('application/json')) {
        const raw = (await readBody(req, 64 * 1024)).toString('utf8')
        try {
          const body = JSON.parse(raw)
          token = typeof body.token === 'string' ? body.token : ''
          next = typeof body.next === 'string' ? body.next : '/'
        } catch {
          token = ''
        }
      } else {
        const raw = (await readBody(req, 64 * 1024)).toString('utf8')
        const params = new URLSearchParams(raw)
        token = params.get('token') ?? ''
        next = params.get('next') ?? '/'
      }
      next = safeNext(next)

      if (token === '') {
        limiter.recordFailure(ip)
        log('LOGIN_FAIL', { ip, reason: 'empty' })
        res.writeHead(401, securityHeaders({ 'content-type': 'application/json' }))
        res.end(JSON.stringify({ error: 'invalid token' }))
        return
      }

      if (safeEqual(token, config.accessToken)) {
        const sessionId = sessions.create(ip, req.headers['user-agent'])
        log('LOGIN_OK', { ip })
        res.writeHead(302, {
          location: next,
          'set-cookie': sessionCookieValue(config, sessionId, config.sessionExpireSeconds),
          ...securityHeaders({ 'cache-control': 'no-store' }),
        })
        res.end()
        return
      }

      limiter.recordFailure(ip)
      log('LOGIN_FAIL', { ip, reason: 'bad token' })
      const wantsJson = contentType.includes('application/json')
      if (wantsJson) {
        res.writeHead(401, securityHeaders({ 'content-type': 'application/json', 'cache-control': 'no-store' }))
        res.end(JSON.stringify({ error: 'invalid token' }))
      } else {
        const body = renderLogin({ error: 'Token 无效，请重试。', next })
        res.writeHead(401, securityHeaders({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }))
        res.end(body)
      }
      return
    }

    // --- logout ----------------------------------------------------------------
    if (pathname === '/logout' && (req.method === 'GET' || req.method === 'POST')) {
      if (req.method === 'POST' && !originAllowed(req, config)) {
        res.writeHead(403, securityHeaders({ 'content-type': 'application/json' }))
        res.end(JSON.stringify({ error: 'forbidden' }))
        return
      }
      const cookies = parseCookies(req)
      const sid = cookies.get(config.sessionCookieName)
      if (sid) sessions.destroy(sid)
      log('LOGOUT', { ip: clientIp(req, config.trustProxy) })
      res.writeHead(302, {
        location: '/login',
        'set-cookie': sessionCookieValue(config, '', 0),
        ...securityHeaders({ 'cache-control': 'no-store' }),
      })
      res.end()
      return
    }

    // --- everything else: session-required reverse proxy ------------------------
    const cookies = parseCookies(req)
    const sid = cookies.get(config.sessionCookieName)
    const validated = sid
      ? sessions.validate(sid, clientIp(req, config.trustProxy), req.headers['user-agent'])
      : { ok: false }

    if (!validated.ok) {
      const accept = String(req.headers.accept ?? '')
      const wantsHtml = accept.includes('text/html')
      const wantsJson = accept.includes('application/json') && !wantsHtml
      const isApi = pathname.startsWith('/api') || pathname.startsWith('/plugins')
      log('UNAUTH', { path: pathname, ip: clientIp(req, config.trustProxy), api: isApi })
      if (isApi || wantsJson) {
        res.writeHead(401, securityHeaders({ 'content-type': 'application/json', 'cache-control': 'no-store' }))
        res.end(JSON.stringify({ error: 'unauthenticated' }))
      } else {
        // Top-level navigation (browser or curl): send the browser to login.
        res.writeHead(302, { location: `/login?next=${encodeURIComponent(pathname)}`, ...securityHeaders({ 'cache-control': 'no-store' }) })
        res.end()
      }
      return
    }

    // Session is valid — proxy to the Harness (HTTP or upgrade).
    if (req.method === 'GET' && req.headers.upgrade?.toLowerCase() === 'websocket') {
      // WebSocket upgrades reach this handler only when no 'upgrade' event
      // fired (unlikely with node); handled by server 'upgrade' below.
      proxyHttp(req, res, config, (s) => proxyStatus(req, s))
      return
    }
    proxyHttp(req, res, config, (s) => proxyStatus(req, s))
  }

  // WebSocket upgrades: validate the session first, then proxy to the Harness.
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://internal')
    const cookies = parseCookies(req)
    const sid = cookies.get(config.sessionCookieName)
    const validated = sid
      ? sessions.validate(sid, clientIp(req, config.trustProxy), req.headers['user-agent'])
      : { ok: false }
    if (!validated.ok) {
      log('WS_UNAUTH', { path: url.pathname })
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      socket.destroy()
      return
    }
    log('WS_CONNECT', { path: url.pathname })
    proxyWebSocket(req, socket, head, config)
  })

  const shutdown = () => {
    log('SHUTDOWN')
    server.close(() => {
      sessions.close()
      limiter.close()
      process.exit(0)
    })
    // Force-exit lingering sockets after a grace period.
    setTimeout(() => process.exit(0), 3000).unref()
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  return { server, sessions, limiter }
}

// --- entry point -------------------------------------------------------------

loadDotenv()
const config = loadConfig()

if (!config.accessToken) {
  process.stderr.write('FATAL: HARNESS_ACCESS_TOKEN is required. Set it in the .env file or environment.\n')
  process.exit(1)
}

const { server } = createGateway(config)
server.listen(config.authPort, config.authHost, () => {
  log('LISTEN', { host: config.authHost, port: config.authPort, harness: `${config.harnessHost}:${config.harnessPort}` })
})