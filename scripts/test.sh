#!/usr/bin/env bash
# scripts/test.sh — smoke-test COMMS-MCP over HTTP
#
# Usage:
#   chmod +x scripts/test.sh
#   MCP_API_KEY=yourkey ./scripts/test.sh
#   MCP_API_KEY=yourkey HOST=http://100.118.209.46:3700 ./scripts/test.sh
#
# IMPORTANT: Streamable HTTP transport requires both Accept types on every call.

HOST="${HOST:-http://localhost:3700}"
KEY="${MCP_API_KEY:-change-me}"
AUTH="Authorization: Bearer $KEY"
ACCEPT="Accept: application/json, text/event-stream"

hr()  { echo ""; echo "── $1 ──────────────────────────────────────────"; }
mcp() {
  curl -s -X POST "$HOST/mcp" \
    -H "Content-Type: application/json" \
    -H "$ACCEPT" \
    -H "$AUTH" \
    -d "$1" | python3 -c "
import sys, json
d = sys.stdin.read()
try:
  r = json.loads(d)
  res = r.get('result') or r.get('error') or r
  if isinstance(res, dict) and 'content' in res:
    for c in res['content']: print(c.get('text',''))
  else:
    print(json.dumps(res, indent=2))
except Exception as e:
  print(d)
"
}

echo "Testing $HOST"

hr "1. Health (public)"
curl -s "$HOST/health"

hr "2. Provider status (public)"
curl -s "$HOST/status"

hr "3. tools/list"
mcp '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

hr "4. sanitise_pii"
mcp '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"sanitise_pii","arguments":{"data":"Call +254712345678 or kamau@example.com, KEY=ABC12345678"}}}'

hr "5. hash_value (hmac-sha256)"
mcp '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"hash_value","arguments":{"value":"mySecret","algorithm":"hmac-sha256"}}}'

hr "6. hash_value (argon2id)"
mcp '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"hash_value","arguments":{"value":"mySecret","algorithm":"argon2id"}}}'

hr "7. verify_hash"
HASH=$(mcp '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"hash_value","arguments":{"value":"test123","algorithm":"argon2id"}}}' | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('hash',''))" 2>/dev/null || echo "")
echo "hash: $HASH"

hr "8. health_check tool"
mcp '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"health_check","arguments":{}}}'

hr "9. rate_limit (send 6 SMS to same number — 6th should be blocked)"
for i in 1 2 3 4 5 6; do
  echo -n "  attempt $i: "
  mcp "{\"jsonrpc\":\"2.0\",\"id\":$((10+i)),\"method\":\"tools/call\",\"params\":{\"name\":\"send_sms\",\"arguments\":{\"to\":\"+254712345678\",\"text\":\"test $i\"}}}" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('error') or d.get('status') or d.get('code','?'))" 2>/dev/null
done

hr "10. Auth rejection"
curl -s -X POST "$HOST/mcp" \
  -H "Content-Type: application/json" \
  -H "$ACCEPT" \
  -H "Authorization: Bearer wrongkey" \
  -d '{"jsonrpc":"2.0","id":99,"method":"tools/list","params":{}}'

echo ""
echo "── Done ──────────────────────────────────────────────────"
