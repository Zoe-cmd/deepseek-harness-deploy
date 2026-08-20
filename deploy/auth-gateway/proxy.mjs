/**
 * Reverse proxy from the auth gateway to DeepSeek Harness (HTTP + WebSocket).
 *
 * Header policy (the security core of the deployment):
 *  - `Host` is rewritten to `HARNESS_HOST:HARNESS_PORT` (loopback). The
 *    Harness browser-trust fence accepts loopback requests unconditionally, so
 *    from its point of view the gateway is a trusted loopback client and every
 *    API method (including the privileged settings/credentials plane) keeps
 *    working. No `--trusted-host` flag is needed.
 *  - Browser `Origin`, `Cookie` and `Authorization` are stripped: the session
 *    cookie belongs to the gateway, and a client-supplied Authorization header
 *    must never reach the upstream.
 *  - Hop-by-hop headers (Connection, Upgrade, Keep-Alive, Transfer-Encoding,
 *    Proxy-*, TE) are removed; node re-adds what it manages itself.
 *  - `X-Forwarded-*` from nginx are passed through unchanged.
 */

import http from 'node:http'
import { createHash } from 'node:crypto'

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection',
])

/** Headers that must never reach the upstream harness. */
const STRIP = new Set([
  'origin', 'cookie', 'authorization', 'proxy-authorization',
])

/** Lowercased header value list. */
function list(value) {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

/** Choose the header value to forward (join repeated headers with ", "). */
function join(value) {
  if (value === undefined) return undefined
  return Array.isArray(value) ? value.join(', ') : value
}

/**
 * Build the upstream header object from the client request.
 * @param {http.IncomingMessage} req - client request.
 * @param {string} upstreamAuthority - `host:port` for the Harness.
 * @returns {object} headers for the upstream request.
 */
export function upstreamHeaders(req, upstreamAuthority) {
  const out = { host: upstreamAuthority }
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    const lower = name.toLowerCase()
    if (lower === 'host') continue // rewritten above; a client-supplied Host must never reach the harness
    if (HOP_BY_HOP.has(lower) || STRIP.has(lower)) continue
    out[lower] = join(value)
  }
  return out
}

/** Security headers applied to every gateway-served response. */
export function securityHeaders(headers = {}) {
  return {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'content-security-policy': [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' ws: wss:",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; '),
    ...headers,
  }
}

/** Stringify response headers for the raw 101 upgrade reply. */
function flattenHeaders(upgradeRes) {
  const lines = [`HTTP/${upgradeRes.httpVersion} 101 Switching Protocols`]
  for (const [name, value] of Object.entries(upgradeRes.headers)) {
    if (name === 'connection' || name === 'upgrade') continue
    lines.push(`${name}: ${join(value)}`)
  }
  return `${lines.join('\r\n')}\r\n\r\n`
}

/**
 * Proxy a normal HTTP request to the harness. Streams the body both ways and
 * pipes the upstream response back to the client with security headers.
 * @param {http.IncomingMessage} clientReq
 * @param {http.ServerResponse} clientRes
 * @param {object} config - gateway config (harnessHost/harnessPort).
 * @param {(status: number) => void} onStatus - log hook.
 */
export function proxyHttp(clientReq, clientRes, config, onStatus) {
  const authority = `${config.harnessHost}:${config.harnessPort}`
  const headers = upstreamHeaders(clientReq, authority)

  const upstreamReq = http.request({
    host: config.harnessHost,
    port: config.harnessPort,
    method: clientReq.method,
    path: clientReq.url,
    headers,
    agent: false,
  }, (upstreamRes) => {
    onStatus?.(upstreamRes.statusCode ?? 502)
    clientRes.writeHead(upstreamRes.statusCode ?? 502, securityHeaders(upstreamRes.headers))
    upstreamRes.pipe(clientRes)
  })

  upstreamReq.on('error', (err) => {
    onStatus?.(502)
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, securityHeaders({ 'content-type': 'text/plain; charset=utf-8' }))
      clientRes.end('Bad Gateway: DeepSeek Harness is unreachable')
    } else {
      clientRes.destroy()
    }
    // Never log secrets; only the error message (contains no credentials).
    process.stderr.write(`[proxy] upstream error: ${err.code ?? err.message}\n`)
  })

  clientReq.on('error', () => upstreamReq.destroy())
  clientReq.pipe(upstreamReq)
}

/**
 * Proxy a WebSocket upgrade to the harness after the gateway has validated the
 * session cookie. Bidirectional pipes are established once the upstream
 * answers 101.
 * @param {http.IncomingMessage} clientReq - original upgrade request.
 * @param {import('node:net').Socket} clientSocket
 * @param {Buffer} head - first bytes after the upgrade headers.
 * @param {object} config - gateway config.
 */
export function proxyWebSocket(clientReq, clientSocket, head, config) {
  const authority = `${config.harnessHost}:${config.harnessPort}`
  const headers = upstreamHeaders(clientReq, authority)
  // Preserve the browser's WebSocket handshake fields.
  for (const name of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions', 'user-agent']) {
    const value = join(clientReq.headers[name])
    if (value !== undefined) headers[name] = value
  }
  headers.connection = 'Upgrade'
  headers.upgrade = 'websocket'

  const upstreamReq = http.request({
    host: config.harnessHost,
    port: config.harnessPort,
    method: 'GET',
    path: clientReq.url,
    headers,
    agent: false,
  })

  upstreamReq.on('upgrade', (upgradeRes, upstreamSocket, upstreamHead) => {
    if (!clientSocket.writable) {
      upstreamSocket.destroy()
      return
    }
    const raw = flattenHeaders(upgradeRes)
    const headBytes = Buffer.from(raw)
    clientSocket.write(headBytes)
    if (upstreamHead?.length) upstreamSocket.unshift(upstreamHead)
    clientSocket.pipe(upstreamSocket)
    upstreamSocket.pipe(clientSocket)
    clientSocket.on('error', () => upstreamSocket.destroy())
    upstreamSocket.on('error', () => clientSocket.destroy())
  })

  upstreamReq.on('error', (err) => {
    process.stderr.write(`[proxy] ws upstream error: ${err.code ?? err.message}\n`)
    try {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n')
    } catch {
      /* socket already gone */
    }
    clientSocket.destroy()
  })

  if (head?.length) {
    // The client may have sent frames already; forward them after the upgrade.
    upstreamReq.on('socket', (socket) => {
      socket.on('connect', () => socket.write(head))
    })
  }
  upstreamReq.end()
}

/** Client IP for rate limiting / logs, honoring nginx X-Forwarded-For. */
export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for']
    if (typeof forwarded === 'string' && forwarded.trim() !== '') {
      const first = forwarded.split(',')[0].trim()
      if (first !== '') return first
    }
  }
  return req.socket?.remoteAddress ?? 'unknown'
}