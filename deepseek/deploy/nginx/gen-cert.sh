#!/usr/bin/env bash
# Generate a self-signed TLS certificate for the auth gateway nginx site.
# For production, replace these with a real certificate (Let's Encrypt / CA).
set -euo pipefail

CERT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/certs"
mkdir -p "$CERT_DIR"

CERT_FILE="${CERT_DIR}/harness.crt"
KEY_FILE="${CERT_DIR}/harness.key"

if [[ -f "$CERT_FILE" && -f "$KEY_FILE" ]]; then
  echo "Certificate already exists: $CERT_FILE"
  exit 0
fi

# Optional public IP(s) to include in the SAN, comma-separated, e.g. "<公网IP>"
PUBLIC_IP="${PUBLIC_IP:-}"

SAN="DNS:${SERVER_NAME:-dsh.local},DNS:localhost,IP:127.0.0.1"
if [[ -n "$PUBLIC_IP" ]]; then
  IFS=',' read -r -a IPS <<< "$PUBLIC_IP"
  for ip in "${IPS[@]}"; do
    SAN="${SAN},IP:${ip}"
  done
fi

openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
  -keyout "$KEY_FILE" -out "$CERT_FILE" \
  -subj "/CN=${SERVER_NAME:-dsh.local}" \
  -addext "subjectAltName=${SAN}"

chmod 600 "$KEY_FILE"
echo "Generated: $CERT_FILE"
echo "          $KEY_FILE"