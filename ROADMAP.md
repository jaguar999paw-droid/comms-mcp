# COMMS-MCP — Full Roadmap

> Centralised, MCP-native communication service — SMS, Voice, Email, OTP, Hashing.
> Built in Node.js ES2022+. Runs on dizaster, reachable over Tailscale.

---

## Why this exists

Most projects couple directly to Twilio or SendGrid — swapping providers means touching every file that ever called `twilio.messages.create()`. COMMS-MCP inverts this: your app, AI agents, and Claude Desktop all call *tools* on one server. The server owns the providers. You own the server.

---

## MCP transport comparison

| Transport | How it works | Best for |
|---|---|---|
| **stdio** | Server is a child process; comms over stdin/stdout | Claude Desktop direct attach; single client |
| **SSE** | HTTP server; client opens persistent GET `/sse`; sends via POST `/message` | Local-network, Tailscale; moderate traffic |
| **Streamable HTTP** | Single POST `/mcp`; handles both requests and streaming | Multiple clients; stateless; our choice |
| **WebSocket** | Bidirectional persistent socket | Push events from server to client |

**COMMS-MCP uses Streamable HTTP** (MCP spec 2025-03) on port `3700`.
Every request must include `Accept: application/json, text/event-stream`.
Pass `--stdio` flag for Claude Desktop direct attachment.

---

## Channels covered

| Channel | Features |
|---|---|
| SMS | Send, delivery webhook, bulk, E.164 validation |
| Voice | Outbound call, TTS script, TeXML/TwiML URL |
| Email | Transactional, HTML, `{{template}}` vars, tags |
| OTP | Generate (argon2id hash), deliver, verify, TTL, lockout |
| Hashing | argon2id (secrets), HMAC-SHA256 (log masking) |
| Privacy | PII sanitiser on every log line, NDJSON audit trail |
| Rate limiting | Sliding window per identifier per tool |
| Webhooks | Telnyx + Resend inbound receivers |
| Health | Provider ping + rate limiter stats |

---

## Structure

```
comms-mcp/
├── src/
│   ├── index.js              # Entry — HTTP or stdio
│   ├── server.js             # CommsMcpServer class
│   ├── http.js               # Express app
│   ├── config/index.js       # Proxy config, dotenv shim
│   ├── providers/index.js    # Telnyx / Twilio / Resend factories
│   ├── services/
│   │   ├── index.js          # SMS, Voice, Email, Hashing
│   │   └── otp.js            # OTP flow (Phase 2)
│   ├── middleware/
│   │   ├── privacy.js        # PII masking, audit log, logger
│   │   └── rateLimit.js      # Sliding window + bearer auth
│   └── tools/
│       ├── index.js          # 8 core tools + dispatch
│       └── otpTools.js       # generate_otp, verify_otp (Phase 2)
├── deploy/comms-mcp.service  # systemd unit
├── scripts/test.sh           # Smoke-test suite
├── .env.example
└── package.json
```

---

## Quick start (dizaster)

```bash
git clone https://github.com/jaguar999paw-droid/comms-mcp ~/comms-mcp
cd ~/comms-mcp
npm install
cp .env.example .env && nano .env   # fill in API keys
node src/index.js                   # dev run

# Production
sudo cp deploy/comms-mcp.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now comms-mcp

# Test
MCP_API_KEY=yourkey bash scripts/test.sh
```

---

## Phases

### Phase 1 — Core (done)
- [x] Config, provider factory, graceful degradation
- [x] SMS, Voice, Email, Hashing services
- [x] 8 MCP tools with rich JSON Schema
- [x] Bearer auth, sliding-window rate limiter, PII sanitiser
- [x] Streamable HTTP + stdio dual transport
- [x] NDJSON audit log
- [x] systemd unit, smoke-test script

### Phase 2 — OTP (scaffold ready, wire Redis)
- [ ] Install ioredis: `npm i ioredis`
- [ ] Replace 3 TODO comments in `src/services/otp.js` with Redis calls
- [ ] Add OTP_TOOLS to TOOLS array in `src/tools/index.js`
- [ ] Add `REDIS_URL=redis://localhost:6379` to `.env`

### Phase 3 — Webhook signatures
- [ ] Verify Telnyx `telnyx-signature-ed25519` header
- [ ] Verify Resend `svix-signature` header
- [ ] Persist events to SQLite (same pattern as toolBOX)

### Phase 4 — Management API
- [ ] `GET /audit?n=50` — last N sanitised audit entries
- [ ] Provider circuit breaker — auto-fallback Telnyx → Twilio
- [ ] `GET /metrics` — Prometheus-compatible counters

### Phase 5 — Extend
- WhatsApp via Telnyx WhatsApp Business API (same SMS adapter)
- FCM/APNs push notifications (new adapter, same tool interface)
- AI-driven IVR: voice tool returns Claude-generated TwiML
- Number pool: buy multiple numbers, round-robin for throughput

---

## Security baseline

- Bearer token on every `/mcp` request
- Phone numbers masked `+XXX ****** XXXX` before any log line
- Email addresses masked `u***@domain.tld`
- OTP codes never logged (not in debug, not in audit)
- API keys redacted in startup config snapshot
- Rate limits: 5 SMS / 3 calls / 20 emails / 5 OTPs per window
- Provider errors sanitised before returning to MCP caller
