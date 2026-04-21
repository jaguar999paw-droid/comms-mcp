/**
 * src/http.js — Express app (Phase 3: webhook signature verification added)
 *
 * Telnyx signs webhooks with Ed25519 via the `telnyx-signature-ed25519` header.
 * Resend signs with HMAC-SHA256 via the Svix `svix-signature` header.
 * Both are verified before the payload is trusted.
 *
 * Demonstrates:
 *  - Raw body capture for signature verification (must come before json())
 *  - Node.js crypto.createVerify for Ed25519
 *  - Constant-time comparison with crypto.timingSafeEqual
 *  - Promise-based server listen
 */

import express              from 'express';
import { createVerify, createHmac, timingSafeEqual } from 'crypto';
import { authMiddleware }   from './middleware/rateLimit.js';
import { sanitise, logger } from './middleware/privacy.js';
import { allHealthChecks }  from './providers/index.js';
import config               from './config/index.js';

// ── Signature verifiers ───────────────────────────────────────────────────────

/**
 * verifyTelnyxSignature(rawBody, headers)
 * Telnyx sends: telnyx-signature-ed25519, telnyx-timestamp
 * Public key is in TELNYX_WEBHOOK_PUBLIC_KEY env var (from Telnyx portal).
 */
const verifyTelnyxSignature = (rawBody, headers) => {
  const pubKey    = process.env.TELNYX_WEBHOOK_PUBLIC_KEY;
  const signature = headers['telnyx-signature-ed25519'];
  const timestamp = headers['telnyx-timestamp'];

  if (!pubKey || !signature || !timestamp) return false;

  try {
    // Signed payload = timestamp + '|' + rawBody
    const payload = `${timestamp}|${rawBody}`;
    const verify  = createVerify('Ed25519');
    verify.update(payload);
    return verify.verify(
      `-----BEGIN PUBLIC KEY-----\n${pubKey}\n-----END PUBLIC KEY-----`,
      Buffer.from(signature, 'base64')
    );
  } catch {
    return false;
  }
};

/**
 * verifyResendSignature(rawBody, headers)
 * Resend uses Svix: svix-id, svix-timestamp, svix-signature
 * Secret is RESEND_WEBHOOK_SECRET from Resend dashboard.
 */
const verifyResendSignature = (rawBody, headers) => {
  const secret    = process.env.RESEND_WEBHOOK_SECRET;
  const svixId    = headers['svix-id'];
  const svixTs    = headers['svix-timestamp'];
  const svixSig   = headers['svix-signature'];

  if (!secret || !svixId || !svixTs || !svixSig) return false;

  try {
    const toSign  = `${svixId}.${svixTs}.${rawBody}`;
    // Svix secret is base64-encoded; strip the "whsec_" prefix if present
    const keyB64  = secret.startsWith('whsec_') ? secret.slice(6) : secret;
    const keyBuf  = Buffer.from(keyB64, 'base64');
    const mac     = createHmac('sha256', keyBuf).update(toSign).digest('base64');

    // svix-signature may contain multiple space-separated "v1,<sig>" entries
    const expected = Buffer.from(`v1,${mac}`);
    return svixSig.split(' ').some(s => {
      try {
        const candidate = Buffer.from(s);
        return candidate.length === expected.length && timingSafeEqual(candidate, expected);
      } catch { return false; }
    });
  } catch {
    return false;
  }
};

// ── App builder ───────────────────────────────────────────────────────────────
export const buildApp = (mcpServer) => {
  const app = express();

  // Capture raw body for webhook signature verification BEFORE json() parses it
  app.use((req, _res, next) => {
    if (req.path.startsWith('/webhooks/')) {
      let raw = '';
      req.on('data', chunk => raw += chunk);
      req.on('end',  () => { req.rawBody = raw; next(); });
    } else {
      next();
    }
  });

  app.use(express.json({ limit: '1mb' }));

  app.use((req, _res, next) => {
    logger.debug`${req.method} ${req.path}`;
    next();
  });

  // ── Public endpoints ────────────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({ service: 'comms-mcp', status: 'ok', uptime: process.uptime(), ts: new Date().toISOString() });
  });

  app.get('/status', async (_req, res) => {
    const providers = await allHealthChecks();
    res.json({ providers });
  });

  // ── MCP endpoint — bearer auth ──────────────────────────────────────────────
  app.use('/mcp', authMiddleware);
  mcpServer.startHTTP(app, '/mcp');

  // ── Telnyx webhook ──────────────────────────────────────────────────────────
  app.post('/webhooks/telnyx', (req, res) => {
    const rawBody = req.rawBody ?? JSON.stringify(req.body);

    if (process.env.TELNYX_WEBHOOK_PUBLIC_KEY) {
      const valid = verifyTelnyxSignature(rawBody, req.headers);
      if (!valid) {
        logger.warn`[webhook/telnyx] signature verification FAILED`;
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    const { event_type, data } = req.body ?? {};
    logger.plain('info', `[webhook/telnyx] ${event_type ?? 'unknown'}`);

    // Phase 3 TODO: persist to SQLite
    // await db.run('INSERT INTO webhook_events VALUES (?,?,?,?)', [id, 'telnyx', event_type, rawBody]);

    res.sendStatus(200);
  });

  // ── Resend webhook ──────────────────────────────────────────────────────────
  app.post('/webhooks/resend', (req, res) => {
    const rawBody = req.rawBody ?? JSON.stringify(req.body);

    if (process.env.RESEND_WEBHOOK_SECRET) {
      const valid = verifyResendSignature(rawBody, req.headers);
      if (!valid) {
        logger.warn`[webhook/resend] signature verification FAILED`;
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    const { type } = req.body ?? {};
    logger.plain('info', `[webhook/resend] ${type ?? 'unknown'}`);

    res.sendStatus(200);
  });

  // ── 404 ─────────────────────────────────────────────────────────────────────
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    logger.plain('error', `[http] ${sanitise(err.message)}`);
    res.status(err.status ?? 500).json({ error: sanitise(err.message ?? 'Internal error') });
  });

  return app;
};

export const startServer = (app, port) =>
  new Promise((resolve, reject) => {
    const srv = app.listen(port, '0.0.0.0', () => resolve(srv));
    srv.once('error', reject);
  });
