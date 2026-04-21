/**
 * src/providers/index.js
 *
 * Provider factory — demonstrates:
 *  - Closure-based factory pattern (no classes needed)
 *  - Graceful degradation for unconfigured providers
 *  - Lazy dynamic import (loads SDK only on first actual call)
 *  - Object destructuring with rename + defaults
 *  - Promise.allSettled for parallel health checks
 *  - Optional chaining on deeply nested API responses
 */

import config from '../config/index.js';
import { logger, sanitise } from '../middleware/privacy.js';

// Degraded stub returned when a provider has no credentials
const degraded = (name) => {
  const unavailable = () =>
    Promise.reject(new Error(`[${name}] not configured — set credentials in .env`));
  return {
    name,
    sendSMS:   unavailable,
    makeCall:  unavailable,
    sendEmail: unavailable,
    health:    async () => ({ provider: name, status: 'unconfigured' }),
  };
};

// ── Telnyx ─────────────────────────────────────────────────────────────────────
const makeTelnyxProvider = ({ apiKey, fromNumber }) => {
  if (!apiKey) return degraded('telnyx');

  let _client = null;
  const client = async () => {
    if (_client) return _client;
    const { default: Telnyx } = await import('telnyx');
    _client = new Telnyx(apiKey);
    return _client;
  };

  const sendSMS = async ({ to, text, webhookUrl }) => {
    const telnyx = await client();
    const { data } = await telnyx.messages.create({
      from: fromNumber, to, text,
      ...(webhookUrl && { webhook_url: webhookUrl }),
    });
    return {
      provider:  'telnyx',
      messageId: data.id,
      status:    data.status,
      to:        data.to?.[0]?.phone_number ?? to,
      sentAt:    data.sent_at ?? new Date().toISOString(),
    };
  };

  const makeCall = async ({ to, texmlUrl, timeout = 30 }) => {
    const telnyx = await client();
    const { data } = await telnyx.calls.create({
      connection_id: config.str('TELNYX_CONNECTION_ID', ''),
      to, from: fromNumber, timeout_secs: timeout,
      ...(texmlUrl && { webhook_url: texmlUrl }),
    });
    return { provider: 'telnyx', callId: data.call_control_id, callLegId: data.call_leg_id, status: 'initiated' };
  };

  const health = async () => {
    try {
      const telnyx = await client();
      await telnyx.messages.list({ page: { size: 1 } });
      return { provider: 'telnyx', status: 'ok' };
    } catch (err) {
      return { provider: 'telnyx', status: 'error', error: sanitise(err.message) };
    }
  };

  return { name: 'telnyx', sendSMS, makeCall, health };
};

// ── Twilio (fallback) ──────────────────────────────────────────────────────────
const makeTwilioProvider = ({ accountSid, authToken, fromNumber }) => {
  if (!accountSid || !authToken) return degraded('twilio');

  let _client = null;
  const client = async () => {
    if (_client) return _client;
    const { default: twilio } = await import('twilio');
    _client = twilio(accountSid, authToken);
    return _client;
  };

  const sendSMS = async ({ to, text }) => {
    const tw  = await client();
    const msg = await tw.messages.create({ body: text, from: fromNumber, to });
    return { provider: 'twilio', messageId: msg.sid, status: msg.status, to: msg.to, sentAt: msg.dateCreated?.toISOString() ?? new Date().toISOString() };
  };

  const makeCall = async ({ to, texmlUrl, twimlUrl, timeout = 30 }) => {
    const tw   = await client();
    const call = await tw.calls.create({ url: twimlUrl ?? texmlUrl, to, from: fromNumber, timeout });
    return { provider: 'twilio', callId: call.sid, status: call.status };
  };

  const health = async () => {
    try {
      const tw = await client();
      await tw.api.accounts(accountSid).fetch();
      return { provider: 'twilio', status: 'ok' };
    } catch (err) {
      return { provider: 'twilio', status: 'error', error: sanitise(err.message) };
    }
  };

  return { name: 'twilio', sendSMS, makeCall, health };
};

// ── Resend ─────────────────────────────────────────────────────────────────────
const makeResendProvider = ({ apiKey, from, fromName }) => {
  if (!apiKey) return degraded('resend');

  let _resend = null;
  const resend = async () => {
    if (_resend) return _resend;
    const { Resend } = await import('resend');
    _resend = new Resend(apiKey);
    return _resend;
  };

  const sendEmail = async ({ to, subject, text, html, replyTo, tags = [], ...extra }) => {
    const rs = await resend();
    const { data, error } = await rs.emails.send({
      from:    `${fromName} <${from}>`,
      to:      Array.isArray(to) ? to : [to],
      subject,
      ...(text    && { text }),
      ...(html    && { html }),
      ...(replyTo && { reply_to: replyTo }),
      ...(tags.length && { tags }),
      ...extra,
    });
    if (error) throw new Error(error.message ?? 'Resend error');
    return { provider: 'resend', messageId: data.id, status: 'sent', to, sentAt: new Date().toISOString() };
  };

  const health = async () => {
    try {
      const rs = await resend();
      await rs.domains.list();
      return { provider: 'resend', status: 'ok' };
    } catch (err) {
      return { provider: 'resend', status: 'error', error: sanitise(err.message) };
    }
  };

  return { name: 'resend', sendEmail, health };
};

// ── Registry ───────────────────────────────────────────────────────────────────
const {
  TELNYX_API_KEY:     telnyxKey     = '',
  TELNYX_FROM_NUMBER: telnyxFrom    = '',
  TWILIO_ACCOUNT_SID: twilioSid     = '',
  TWILIO_AUTH_TOKEN:  twilioToken   = '',
  TWILIO_FROM_NUMBER: twilioFrom    = '',
  RESEND_API_KEY:     resendKey     = '',
  EMAIL_FROM:         emailFrom     = '',
  EMAIL_FROM_NAME:    emailName     = 'COMMS-MCP',
  SMS_PROVIDER:       smsProvName   = 'telnyx',
  VOICE_PROVIDER:     voiceProvName = 'telnyx',
} = process.env;

const providers = {
  telnyx: makeTelnyxProvider({ apiKey: telnyxKey, fromNumber: telnyxFrom }),
  twilio: makeTwilioProvider({ accountSid: twilioSid, authToken: twilioToken, fromNumber: twilioFrom }),
  resend: makeResendProvider({ apiKey: resendKey, from: emailFrom, fromName: emailName }),
};

export const smsProvider   = providers[smsProvName]   ?? providers.telnyx;
export const voiceProvider = providers[voiceProvName] ?? providers.telnyx;
export const emailProvider = providers.resend;

export const allHealthChecks = async () => {
  const checks = await Promise.allSettled([
    providers.telnyx.health(),
    providers.twilio.health(),
    providers.resend.health(),
  ]);
  return checks.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : { provider: ['telnyx','twilio','resend'][i], status: 'error', error: sanitise(r.reason?.message) }
  );
};

logger.plain('info', `[providers] SMS=${smsProvider.name}  VOICE=${voiceProvider.name}  EMAIL=${emailProvider.name}`);
