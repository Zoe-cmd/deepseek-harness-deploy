#!/usr/bin/env bash
# Start the DeepSeek Harness + auth gateway + (test) nginx stack.
#
#   ./start.sh [--nginx-test] [--no-nginx] [--production-nginx]
#
#   --nginx-test          start the standalone test nginx on 8080/8443 (default when
#                         a dedicated test nginx is not already running)
#   --production-nginx    reload the system nginx after installing the prod site
#   --no-nginx            start only harness + auth gateway
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN="$ROOT/deploy/run"
LOGS="$ROOT/deploy/logs"
ENV_FILE="$ROOT/deploy/.env"

mkdir -p "$RUN" "$LOGS"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found. Copy deploy/.env.example to deploy/.env and fill it in." >&2
  exit 1
fi

source_env() {
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
}

is_up() {
  local pidfile="$1"
  [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null
}

# ---- 1. DeepSeek Harness (loopback only) ----------------------------------
HARNESS_PID="$RUN/harness.pid"
if is_up "$HARNESS_PID"; then
  echo "harness: already running (pid $(cat "$HARNESS_PID"))"
else
  echo "harness: starting (127.0.0.1:3080)..."
  cd "$ROOT"
  nohup node node_modules/@deepseek-ai/dsh/lib/bin.js web \
    > "$LOGS/harness.log" 2>&1 &
  echo $! > "$HARNESS_PID"
  sleep 3
  if ! is_up "$HARNESS_PID"; then
    echo "harness: FAILED to start — see $LOGS/harness.log" >&2
    exit 1
  fi
  echo "harness: started (pid $(cat "$HARNESS_PID"))"
fi

# ---- 2. Auth gateway (loopback only) --------------------------------------
AUTH_PID="$RUN/auth-gateway.pid"
if is_up "$AUTH_PID"; then
  echo "auth-gateway: already running (pid $(cat "$AUTH_PID"))"
else
  echo "auth-gateway: starting (127.0.0.1:3081)..."
  nohup node "$ROOT/deploy/auth-gateway/server.mjs" \
    > "$LOGS/auth-gateway.log" 2>&1 &
  echo $! > "$AUTH_PID"
  sleep 1
  if ! is_up "$AUTH_PID"; then
    echo "auth-gateway: FAILED to start — see $LOGS/auth-gateway.log" >&2
    exit 1
  fi
  echo "auth-gateway: started (pid $(cat "$AUTH_PID"))"
fi

# ---- 3. nginx --------------------------------------------------------------
MODE="${1:---nginx-test}"
case "$MODE" in
  --no-nginx)
    echo "nginx: skipped (--no-nginx)"
    ;;
  --nginx-test)
    NGINX_PID="$RUN/nginx-test.pid"
    if is_up "$NGINX_PID"; then
      echo "nginx-test: already running (pid $(cat "$NGINX_PID"))"
    else
      echo "nginx-test: starting (http :8080, https :8443)..."
      nginx -p "$ROOT/deploy" -c "$ROOT/deploy/nginx/nginx-gateway-test.conf" || { echo "nginx-test: FAILED" >&2; exit 1; }
      echo "nginx-test: started (pid $(cat "$NGINX_PID"))"
    fi
    ;;
  --production-nginx)
    echo "nginx: reloading system nginx (production site)..."
    if ! nginx -t -c /etc/nginx/nginx.conf 2>/dev/null; then
      echo "nginx: config test failed — aborting reload" >&2
      exit 1
    fi
    nginx -s reload
    echo "nginx: reloaded"
    ;;
  *)
    echo "unknown mode: $MODE" >&2
    exit 1
    ;;
esac

echo
echo "All components up. Public entry:"
echo "  https://<server>:8443   (test nginx, self-signed)  or  https://<server>  (production)"
echo "Logs: $LOGS"