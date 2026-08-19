#!/usr/bin/env bash
# Restart the stack (harness + auth gateway + nginx).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
"$ROOT/deploy/scripts/stop.sh"
"$ROOT/deploy/scripts/start.sh" "${1:---nginx-test}"