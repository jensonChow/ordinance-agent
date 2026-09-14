#!/usr/bin/env bash
# Run the reverse-proxy configuration for real, on this machine, without root and without touching the system
# Apache config. It starts httpd on :8080 against local-check.conf, checks both upstreams through it, checks that
# the /api/chat token stream still arrives incrementally, and stops httpd again.
#
#   deploy/apache/local-check.sh
#
# Needs, first:
#   * the app on :3100          MODEL_PROVIDER=mock npm run dev -- -p 3100
#   * the citation service :8000  (cd services/citation-py && .venv/bin/gunicorn -w 2 -b 127.0.0.1:8000 app:app)
#
# Why it exists: deploy/apache/basic-law.conf was committed as documentation and never executed, which made the
# claim "this is how it is deployed behind Apache" unverified. The one setting that genuinely matters —
# flushpackets=on, without which the streamed answer arrives only when the tool loop ends — cannot be checked by
# reading the file.
set -euo pipefail
cd "$(dirname "$0")/../.."

HTTPD=${HTTPD:-/usr/sbin/httpd}
MODULES=${APACHE_MODULES:-/usr/libexec/apache2}
RUN=$(mktemp -d "${TMPDIR:-/tmp}/basic-law-apache.XXXXXX")
mkdir -p "$RUN/htdocs"
PORT=${APACHE_PORT:-8080}
APP_PORT=${APP_PORT:-3100}
APP=http://127.0.0.1:$APP_PORT
PROXY=http://127.0.0.1:$PORT

fail() { echo "FAIL: $*" >&2; exit 1; }
cleanup() {
  [ -f "$RUN/httpd.pid" ] && kill "$(cat "$RUN/httpd.pid")" 2>/dev/null || true
  sleep 0.5
  echo "--- httpd error log ---"; tail -5 "$RUN/error.log" 2>/dev/null || true
  rm -rf "$RUN"
}
trap cleanup EXIT

# The config is copied next to the pid/log files rather than read out of the repository: on macOS the system httpd
# runs under a sandbox profile that cannot read every volume, and it fails with "Operation not permitted" on a
# config that this shell reads without trouble. Copying it is also closer to the real thing — a deployed vhost
# lives in the server's own configuration directory, not in a checkout.
cp deploy/apache/local-check.conf "$RUN/httpd.conf"
CONF="$RUN/httpd.conf"

echo "httpd:   $($HTTPD -v | head -1)"
echo "modules: $MODULES"
echo "run dir: $RUN"

curl -fsS -o /dev/null "$APP" || fail "the app is not answering on $APP — start it first"

echo
echo "== configtest =="
APACHE_RUN="$RUN" APACHE_MODULES="$MODULES" APACHE_PORT="$PORT" APP_PORT="$APP_PORT" $HTTPD -f "$CONF" -t

echo "== start =="
APACHE_RUN="$RUN" APACHE_MODULES="$MODULES" APACHE_PORT="$PORT" APP_PORT="$APP_PORT" $HTTPD -f "$CONF" -k start
for _ in $(seq 20); do curl -fsS -o /dev/null "$PROXY" 2>/dev/null && break; sleep 0.25; done
curl -fsS -o /dev/null "$PROXY" || fail "httpd did not come up on :$PORT"
echo "up on :$PORT (pid $(cat "$RUN/httpd.pid"))"

echo
echo "== the Next.js upstream through the proxy =="
for path in / /eval /article/27; do
  code=$(curl -fsS -o "$RUN/body" -w '%{http_code}' "$PROXY$path")
  grep -q "Basic Law Study Agent" "$RUN/body" || fail "$path came back without the app's own markup"
  echo "  $path -> $code, app markup present"
done

echo
echo "== the MCP endpoint through the proxy =="
tools=$(curl -fsS -X POST "$PROXY/api/mcp" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | tr -d '\n' | grep -o '"name":"[a-z_]*"' | wc -l | tr -d ' ')
[ "$tools" -ge 7 ] || fail "tools/list returned $tools tools through the proxy"
echo "  tools/list -> $tools tools"

echo
echo "== the Python upstream through the proxy (prefix is rewritten away) =="
if curl -fsS -o /dev/null "http://127.0.0.1:8000/healthz" 2>/dev/null; then
  curl -fsS "$PROXY/citations/healthz" | grep -q '"ok"' || fail "/citations/healthz did not reach gunicorn"
  echo "  /citations/healthz -> ok"
  count=$(curl -fsS -X POST "$PROXY/citations/parse" -H 'content-type: application/json' \
    -d '{"text":"see arts 45 to 47 and art 24(2)"}' | grep -o '"count":[0-9]*' | cut -d: -f2)
  [ "$count" = "4" ] || fail "/citations/parse returned count=$count through the proxy, expected 4"
  echo "  /citations/parse -> count=$count"
else
  echo "  SKIPPED: nothing on :8000 (start gunicorn to include this upstream)"
fi

echo
echo "== the streamed answer is still streamed =="
echo "-- straight at the app, as a baseline --"
node scripts/stream-timing.mjs "$APP" || fail "the app itself did not stream — nothing to conclude about the proxy"
echo "-- through the proxy --"
node scripts/stream-timing.mjs "$PROXY" || fail "the proxy buffered /api/chat — check flushpackets=on"

echo
echo "APACHE CHECK OK"
