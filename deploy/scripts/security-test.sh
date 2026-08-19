#!/usr/bin/env bash
# DeepSeek Harness auth gateway — full functional + security test matrix.
# Runs against the production chain (system nginx :443 -> gateway -> harness).
set -uo pipefail

BASE="${1:-https://127.0.0.1}"          # production nginx entry
GATEWAY="${2:-http://127.0.0.1:3081}"  # auth gateway (direct, for rate-limit test)
TOKEN="${HARNESS_ACCESS_TOKEN:-}"
TS_IP="198.51.100.7"   # isolated test client IP (simulated remote user)

# Always bypass the local proxy so tests hit nginx directly.
curl_np() { curl -sk --noproxy '*' "$@"; }

# Reset gateway state (sessions + rate limiter) and ensure the stack is up.
pkill -f "auth-gateway/server.mjs" 2>/dev/null || true
sleep 1
"$(dirname "$0")/start.sh" --no-nginx >/dev/null 2>&1 || true
sleep 2

JAR="$(mktemp)"; rm -f "$JAR"
PASS=0; FAIL=0

ok()   { PASS=$((PASS+1)); echo "  PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL  $1   <- got: $2 (want: $3)"; }

check() { # name got want
  if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1" "$2" "$3"; fi
}

if [[ -z "$TOKEN" ]]; then
  echo "HARNESS_ACCESS_TOKEN not set — loading from deploy/.env"
  TOKEN=$(grep HARNESS_ACCESS_TOKEN /root/test/test/deploy/.env | cut -d= -f2)
fi

echo "== 1. Unauthenticated homepage =="
G=$(curl_np -s -o /dev/null -w "%{http_code} %{redirect_url}" "$BASE/")
check "unauth GET / -> redirect to login" "$G" "302 $BASE/login?next=%2F"

echo "== 2. Unauthenticated API =="
G=$(curl_np -s -o /dev/null -w "%{http_code}" "$BASE/api/session.list")
check "unauth GET /api -> 401" "$G" "401"

echo "== 3. Correct token login =="
rm -f "$JAR"
G=$(curl_np -s -o /dev/null -w "%{http_code}" -c "$JAR" -X POST "$BASE/login" -H "X-Forwarded-For: $TS_IP" -d "token=$TOKEN")
check "login -> 302" "$G" "302"
COOKIE_LINE=$(grep dsh_session "$JAR" | tr '\t' '|')
if [[ "$COOKIE_LINE" == *HttpOnly* && "$COOKIE_LINE" == *"|/|TRUE|"* ]]; then
  ok "cookie is HttpOnly + Secure + Path=/"
else
  bad "cookie flags" "$COOKIE_LINE" "HttpOnly Secure Path=/"
fi
SID=$(grep dsh_session "$JAR" | awk '{print $7}')
[[ -n "$SID" ]] && ok "cookie value present" || bad "cookie value" "" "non-empty"
if curl_np -s -c /dev/null -X POST "$BASE/login" -H "X-Forwarded-For: $TS_IP" -d "token=$TOKEN" | grep -q "$TOKEN"; then
  bad "token not echoed in login response" "token present" "absent"
else
  ok "token not echoed to browser"
fi

echo "== 4. Wrong token =="
G=$(curl_np -s -o /dev/null -w "%{http_code}" -X POST "$BASE/login" -H "X-Forwarded-For: $TS_IP" -d "token=WRONG-TOKEN")
check "wrong token -> 401" "$G" "401"

echo "== 5. Deleted cookie =="
G=$(curl_np -s -o /dev/null -w "%{http_code}" "$BASE/api/session.list")
check "no cookie -> 401" "$G" "401"

echo "== 6. Tampered cookie =="
G=$(curl_np -s -o /dev/null -w "%{http_code}" "$BASE/api/session.list" -H "Cookie: dsh_session=deadbeefdeadbeef")
check "invalid cookie -> 401" "$G" "401"

echo "== 7. Valid session accesses everything =="
G=$(curl_np -s -b "$JAR" -o /dev/null -w "%{http_code}" "$BASE/")
check "homepage authed -> 200" "$G" "200"
G=$(curl_np -s -b "$JAR" -o /dev/null -w "%{http_code}" "$BASE/assets/index-C-1AiF3k.js")
check "static asset -> 200" "$G" "200"
G=$(curl_np -s -b "$JAR" -X POST "$BASE/api/session.list" -H "Content-Type: application/json" \
    -d '{"type":"client-request","rpcId":"t1","method":"session.list","payload":{}}' -o /dev/null -w "%{http_code}")
check "API session.list -> 200" "$G" "200"
G=$(curl_np -s -b "$JAR" -X POST "$BASE/api/settings.describe" -H "Content-Type: application/json" \
    -d '{"type":"client-request","rpcId":"t2","method":"settings.describe","payload":{}}' -o /dev/null -w "%{http_code}")
check "privileged settings.describe via proxy -> 200" "$G" "200"
G=$(curl_np -s -b "$JAR" -o /dev/null -w "%{http_code}" "$BASE/api/events.host")
check "WS path plain GET -> 426 upgrade required" "$G" "426"

echo "== 8. Refresh / repeated navigation =="
G=$(curl_np -s -b "$JAR" -o /dev/null -w "%{http_code}" "$BASE/")
check "refresh keeps session -> 200" "$G" "200"

echo "== 9. Logout =="
JAR2="$(mktemp)"; rm -f "$JAR2"
curl_np -s -c "$JAR2" -o /dev/null -X POST "$BASE/login" -H "X-Forwarded-For: $TS_IP" -d "token=$TOKEN"
LOGOUT_HDR=$(curl_np -s -b "$JAR2" -D - -o /dev/null "$BASE/logout" -H "X-Forwarded-For: $TS_IP")
if [[ "$LOGOUT_HDR" == *"302"* ]]; then ok "logout -> 302"; else bad "logout status" "$LOGOUT_HDR" "302"; fi
if echo "$LOGOUT_HDR" | grep -qi 'set-cookie:.*Max-Age=0'; then
  ok "cookie cleared (Max-Age=0)"
else
  bad "cookie cleared" "$(echo "$LOGOUT_HDR" | grep -i set-cookie)" "Max-Age=0"
fi
G=$(curl_np -s -b "$JAR2" -o /dev/null -w "%{http_code} %{redirect_url}" "$BASE/")
check "after logout -> back to login" "$G" "302 $BASE/login?next=%2F"

echo "== 10. Harness internal port not publicly reachable =="
IP=$(ip -4 addr show eth0 2>/dev/null | grep -oP 'inet \K[\d.]+' || echo 127.0.0.1)
G=$(curl_np -s --connect-timeout 3 -o /dev/null -w "%{http_code}" "http://$IP:3080/" 2>/dev/null)
check "publicIP:3080 connection refused (no bypass)" "$G" "000"
G=$(curl_np -s --connect-timeout 3 -o /dev/null -w "%{http_code}" "http://$IP:3081/healthz" 2>/dev/null)
check "publicIP:3081 gateway refused (loopback only)" "$G" "000"
LOCAL_BIND=$(ss -tln | grep -E ":3080|:3081" | awk '{print $4}')
if echo "$LOCAL_BIND" | grep -q "^127.0.0.1:308[01]$" \
   && ! echo "$LOCAL_BIND" | grep -qE "^0.0.0.0|^\*:"; then
  ok "3080/3081 bound to 127.0.0.1 only"
else
  bad "loopback bind" "$LOCAL_BIND" "127.0.0.1:3080 + 127.0.0.1:3081"
fi

echo "== 11. WebSocket (authed = 101, unauth = rejected) =="
SID3=$(grep dsh_session "$JAR" | awk '{print $7}')
G=$(curl_np -s --max-time 3 -o /dev/null -w "%{http_code}" \
   -H "Connection: Upgrade" -H "Upgrade: websocket" \
   -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" -H "Sec-WebSocket-Version: 13" \
   -H "Cookie: dsh_session=$SID3" "$BASE/api/events.mux")
check "authed WS upgrade -> 101" "$G" "101"
G=$(curl_np -s --max-time 3 -o /dev/null -w "%{http_code}" \
   -H "Connection: Upgrade" -H "Upgrade: websocket" \
   -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" -H "Sec-WebSocket-Version: 13" \
   -H "Cookie: dsh_session=invalid" "$BASE/api/events.mux")
check "unauth WS upgrade rejected -> 401" "$G" "401"

echo "== 12. Login brute-force rate limit =="
CLEAN_IP="10.9.9.9"
for i in $(seq 1 11); do
  curl_np -s -o /dev/null -X POST "$GATEWAY/login" -d "token=BRUTE-$i" -H "X-Forwarded-For: $CLEAN_IP"
done
G=$(curl_np -s -o /dev/null -w "%{http_code}" -X POST "$GATEWAY/login" -d "token=BRUTE-12" -H "X-Forwarded-For: $CLEAN_IP")
check "11th failure from one IP -> 429" "$G" "429"

echo "== 13. Security headers on proxied responses =="
HDRS=$(curl_np -s -b "$JAR" -D - -o /dev/null "$BASE/")
echo "$HDRS" | grep -qi "x-content-type-options: nosniff"        && ok "nosniff" || bad "nosniff" "" "present"
echo "$HDRS" | grep -qi "x-frame-options: DENY"                  && ok "x-frame-options" || bad "x-frame-options" "" "present"
echo "$HDRS" | grep -qi "content-security-policy"                && ok "CSP present" || bad "CSP" "" "present"
echo "$HDRS" | grep -qi "referrer-policy: no-referrer"           && ok "referrer-policy" || bad "referrer-policy" "" "present"

echo "== 14. Login page security headers (strict CSP) =="
LHDRS=$(curl_np -s -D - -o /dev/null "$BASE/login")
echo "$LHDRS" | grep -qi "script-src 'self';"                    && ok "login CSP: no unsafe-inline scripts" || bad "login CSP" "" "strict"
echo "$LHDRS" | grep -qi "cache-control: no-store"               && ok "login no-store" || bad "login no-store" "" "present"

echo "== 15. SSE endpoint passthrough =="
G=$(curl_np -s -b "$JAR" --max-time 3 -o /dev/null -w "%{http_code}" "$BASE/plugins/events")
case "$G" in
  200|404) ok "SSE endpoint reachable (200 stream or 404 idle, got $G)" ;;
  *) bad "SSE endpoint" "$G" "200/404" ;;
esac

echo
echo "=========================================="
echo "  PASS=$PASS  FAIL=$FAIL"
echo "=========================================="
rm -f "$JAR" "$JAR2"
[[ $FAIL -eq 0 ]]