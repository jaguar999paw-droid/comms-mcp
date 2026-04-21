/**
 * src/services/index.js — SMS, Voice, Email, Hashing services
 *
 * Demonstrates:
 *  - Curried higher-order functions (withRateLimit)
 *  - async/await with try/catch audit pattern
 *  - IIFE for lazy singleton (hashingService)
 *  - Template literal TeXML builder
 *  - Object spread for result normalisation
 */

import { smsProvider, voiceProvider, emailProvider } from '../providers/index.js';
import { rateLimiter, TOOL_LIMITS }                  from '../middleware/rateLimit.js';
import { sanitise, audit, logger }                   from '../middleware/privacy.js';

// Curried rate-limit guard — withRateLimit('send_sms')(identifier, fn)
const withRateLimit = (toolName) => async (identifier, fn) => {
  const opts = TOOL_LIMITS[toolName] ?? {};
  const { allowed, remaining, resetAt } = rateLimiter.check(`${toolName}:${identifier}`, opts);

  if (!allowed) {
    const retryIn = Math.ceil((resetAt - Date.now()) / 1000);
    throw Object.assign(new Error(`Rate limit exceeded. Retry in ${retryIn}s`), { code: 'RATE_LIMITED', retryIn });
  }

  logger.debug`[rate] ${toolName} ok for ${identifier}, ${remaining} remaining`;
  return fn();
};

// ── SMS ───────────────────────────────────────────────────────────────────────
export const smsService = {
  async send({ to, text, webhookUrl }) {
    const ev = audit('send_sms', { to, text: text.slice(0, 20) + '...' });
    try {
      const result = await withRateLimit('send_sms')(to, () =>
        smsProvider.sendSMS({ to, text, webhookUrl })
      );
      ev.complete({ success: true, result });
      return result;
    } catch (err) {
      ev.complete({ success: false, error: err });
      throw err;
    }
  },
};

// ── Voice ─────────────────────────────────────────────────────────────────────
const buildTeXML = (text) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Say voice="Polly.Joanna">${
    text.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))
  }</Say>\n</Response>`;

export const voiceService = {
  async call({ to, script, texmlUrl, timeout = 30 }) {
    const ev = audit('make_call', { to, hasScript: !!script });

    const resolvedUrl = texmlUrl ?? (script
      ? `data:text/xml;charset=utf-8,${encodeURIComponent(buildTeXML(script))}`
      : null
    );
    if (!resolvedUrl) throw new Error('Provide either script or texmlUrl');

    try {
      const result = await withRateLimit('make_call')(to, () =>
        voiceProvider.makeCall({ to, texmlUrl: resolvedUrl, twimlUrl: resolvedUrl, timeout })
      );
      ev.complete({ success: true, result });
      return result;
    } catch (err) {
      ev.complete({ success: false, error: err });
      throw err;
    }
  },
};

// ── Email ─────────────────────────────────────────────────────────────────────
export const emailService = {
  async send({ to, subject, text, html, replyTo, tags }) {
    if (!text && !html) throw new Error('Provide either text or html body');
    const ev = audit('send_email', { to, subject });
    try {
      const result = await withRateLimit('send_email')(to, () =>
        emailProvider.sendEmail({ to, subject, text, html, replyTo, tags })
      );
      ev.complete({ success: true });
      return result;
    } catch (err) {
      ev.complete({ success: false, error: err });
      throw err;
    }
  },
  renderTemplate: (template, vars = {}) =>
    template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? ''),
};

// ── Hashing — IIFE for lazy argon2 import ─────────────────────────────────────
export const hashingService = (() => {
  let _argon2 = null;
  const getArgon2 = async () => { if (!_argon2) _argon2 = await import('argon2'); return _argon2; };

  return {
    async hash(value) {
      const a = await getArgon2();
      return a.hash(value, { type: a.argon2id });
    },
    async verify(hash, value) {
      const a = await getArgon2();
      return a.verify(hash, value);
    },
    async hmac(value, secret = process.env.MCP_API_KEY ?? 'default-hmac-key') {
      const { createHmac } = await import('crypto');
      return createHmac('sha256', secret).update(value).digest('hex');
    },
  };
})();
