#!/usr/bin/env bash
# Show running status of every stack component + a quick health probe.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN="$ROOT/deploy/run"

status_of() {
  local name="$1"
  local pidfile="$2"
  if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "  $name: RUNNING (pid $(cat "$pidfile"))"
    return 0
  fi
  echo "  $name: STOPPED"
  return 1
}

echo "Components:"
status_of "harness"      "$RUN/harness.pid"      || true
status_of "auth-gateway" "$RUN/auth-gateway.pid" || true
if [[ -f "$RUN/nginx-test.pid" ]] && kill -0 "$(cat "$RUN/nginx-test.pid")" 2>/dev/null; then
  echo "  nginx-test: RUNNING (pid $(cat "$RUN/nginx-test.pid"))"
else
  echo "  nginx-test: STOPPED"
fi

echo
echo "Health probes:"
echo "  gateway /healthz: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3081/healthz || echo unreachable)"
echo "  harness direct   : $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3080/ || echo unreachable)"