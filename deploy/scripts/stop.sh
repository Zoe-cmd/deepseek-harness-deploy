#!/usr/bin/env bash
# Stop the DeepSeek Harness + auth gateway + test nginx stack.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN="$ROOT/deploy/run"

stop_pid() {
  local name="$1"
  local pidfile="$2"
  if [[ -f "$pidfile" ]]; then
    local pid
    pid="$(cat "$pidfile")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      echo "$name: stopped (pid $pid)"
    else
      echo "$name: not running (stale pidfile)"
    fi
    rm -f "$pidfile"
  else
    echo "$name: not running"
  fi
}

# Test nginx (dedicated instance).
if [[ -f "$RUN/nginx-test.pid" ]]; then
  nginx -s stop -c "$ROOT/deploy/nginx/nginx-gateway-test.conf" 2>/dev/null \
    && echo "nginx-test: stopped" || echo "nginx-test: not running"
  rm -f "$RUN/nginx-test.pid"
fi

stop_pid "auth-gateway" "$RUN/auth-gateway.pid"
stop_pid "harness" "$RUN/harness.pid"
echo "Stack stopped."