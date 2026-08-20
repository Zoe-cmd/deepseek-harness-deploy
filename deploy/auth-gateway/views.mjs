/**
 * HTML views served by the auth gateway: the token login page and a minimal
 * error page. The login form posts to `/login`; no token is embedded in any
 * HTML or JavaScript here — the token is only ever compared server-side.
 */

/** Escape HTML so no interpolated value can inject markup. */
export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Strict CSP for the login page (no inline scripts allowed). */
export const LOGIN_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ')

/**
 * Render the login page.
 * @param {object} opts
 * @param {string} [opts.error] - failure message (already safe, escaped here).
 * @param {string} [opts.next] - path to return to after login.
 */
export function renderLogin({ error, next }) {
  const errorBlock = error
    ? `<div class="error" role="alert">${escapeHtml(error)}</div>`
    : ''
  const nextInput = next
    ? `<input type="hidden" name="next" value="${escapeHtml(next)}" />`
    : ''
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="${LOGIN_CSP}" />
<title>DeepSeek Harness · 登录</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    background: radial-gradient(1200px 600px at 70% -10%, #1a3a5c 0%, #0b1220 45%, #060912 100%);
    color: #e6edf7;
  }
  .card {
    width: min(92vw, 420px); padding: 40px 36px; border-radius: 16px;
    background: rgba(13, 20, 35, 0.85); border: 1px solid #22304a;
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5); backdrop-filter: blur(8px);
  }
  .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
  .brand svg { width: 34px; height: 34px; flex: none; }
  h1 { font-size: 20px; margin: 0; font-weight: 600; letter-spacing: 0.2px; }
  .sub { color: #8fa3c4; font-size: 13px; margin: 6px 0 26px; }
  label { display: block; font-size: 13px; color: #b9c7dd; margin-bottom: 8px; }
  input[type="password"] {
    width: 100%; padding: 12px 14px; border-radius: 10px; font-size: 15px;
    border: 1px solid #2c3c5a; background: #0a1120; color: #e6edf7; outline: none;
  }
  input[type="password"]:focus { border-color: #4c8dff; box-shadow: 0 0 0 3px rgba(76, 141, 255, 0.18); }
  button {
    width: 100%; margin-top: 18px; padding: 12px; border-radius: 10px; border: none;
    background: linear-gradient(135deg, #4c8dff, #7a5cff); color: #fff; font-size: 15px; font-weight: 600;
    cursor: pointer; transition: filter 0.15s ease;
  }
  button:hover { filter: brightness(1.08); }
  button:active { filter: brightness(0.95); }
  .error {
    margin-top: 16px; padding: 10px 12px; border-radius: 8px; font-size: 13px;
    background: rgba(255, 82, 82, 0.12); border: 1px solid rgba(255, 82, 82, 0.35); color: #ff9c9c;
  }
  .hint { margin-top: 18px; font-size: 12px; color: #5f7294; text-align: center; }
</style>
</head>
<body>
  <form class="card" method="post" action="/login">
    <div class="brand">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 2 2 7v10l10 5 10-5V7L12 2Z" stroke="#4c8dff" stroke-width="1.6" stroke-linejoin="round"/>
        <path d="M12 22V12" stroke="#4c8dff" stroke-width="1.6" stroke-linecap="round"/>
      </svg>
      <h1>DeepSeek Harness</h1>
    </div>
    <p class="sub">授权访问 · Authorized access only</p>
    <label for="token">Access Token</label>
    <input id="token" name="token" type="password" autocomplete="current-password"
           placeholder="••••••••••••••••" required autofocus />
    ${nextInput}
    <button type="submit">登录</button>
    ${errorBlock}
    <p class="hint">Access Token 由服务器验证，不会存储在本页面中。</p>
  </form>
</body>
</html>`
}

/** Minimal gateway error page (used when the upstream harness is down). */
export function renderErrorPage(title, detail) {
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8" /><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;background:#0b1220;color:#e6edf7;display:grid;place-items:center;min-height:100vh;margin:0}
.card{text-align:center}.card h1{color:#ff9c9c}.card p{color:#8fa3c4}</style></head>
<body><div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></div></body></html>`
}