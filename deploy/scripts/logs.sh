#!/usr/bin/env bash
# Tail gateway / harness logs. Usage: ./logs.sh [gateway|harness|nginx|all]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOGS="$ROOT/deploy/logs"

component="${1:-all}"
case "$component" in
  gateway) tail -f "$LOGS/auth-gateway.log" ;;
  harness) tail -f "$LOGS/harness.log" ;;
  nginx)   tail -f "$LOGS/nginx-test-error.log" "$LOGS/nginx-test-access.log" ;;
  all)
    tail -f "$LOGS/auth-gateway.log" "$LOGS/harness.log" \
          "$LOGS/nginx-test-error.log" "$LOGS/nginx-test-access.log" 2>/dev/null || true
    ;;
  *) echo "usage: $0 [gateway|harness|nginx|all]" >&2; exit 1 ;;
esac