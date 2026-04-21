/**
 * src/tools/index.js — MCP tool registry + dispatch
 *
 * Demonstrates:
 *  - Object.freeze for immutable registry
 *  - Map for O(1) handler lookup
 *  - Spread in schema fragment reuse
 *  - Error normalisation — sanitise before returning to caller
 */

import { smsService, voiceService, emailService, hashingService } from '../services/index.js';
import { allHealthChecks } from '../providers/index.js';
import { sanitise }        from '../middleware/privacy.js';
import { rateLimiter }     from '../middleware/rateLimit.js';

// Shared schema fragments
const PHONE_PROP = { type: 'string', pattern: '^\\+[1-9]\\d{6,14}$', description: 'E.164 number e.g. +254712345678' };
const EMAIL_PROP = { type: 'string', format: 'email', description: 'Email address' };

const TOOLS = Object.freeze([

  {
    name: 'send_sms',
    description: 'Send an SMS via the configured provider (Telnyx primary, Twilio fallback). Returns provider, messageId, status.',
    inputSchema: {
      type: 'object', required: ['to', 'text'],
      properties: {
        to:         { ...PHONE_PROP, description: 'Recipient E.164 number' },
        text:       { type: 'string', maxLength: 1600, description: 'Message body (Unicode OK)' },
        webhookUrl: { type: 'string', format: 'uri', description: 'Delivery status webhook' },
      },
      additionalProperties: false,
    },
    async handler({ to, text, webhookUrl }) {
      return { success: true, ...await smsService.send({ to, text, webhookUrl }) };
    },
  },

  {
    name: 'make_call',
    description: 'Initiate an outbound call. Provide a plain-text script (TTS) or a TeXML/TwiML URL.',
    inputSchema: {
      type: 'object', required: ['to'],
      properties: {
        to:       { ...PHONE_PROP, description: 'Number to call' },
        script:   { type: 'string', maxLength: 2000, description: 'Text to speak (Polly TTS)' },
        texmlUrl: { type: 'string', format: 'uri',   description: 'TeXML/TwiML response URL' },
        timeout:  { type: 'integer', minimum: 5, maximum: 120, default: 30, description: 'Ring timeout seconds' },
      },
      additionalProperties: false,
    },
    async handler({ to, script, texmlUrl, timeout }) {
      return { success: true, ...await voiceService.call({ to, script, texmlUrl, timeout }) };
    },
  },

  {
    name: 'send_email',
    description: 'Send transactional email via Resend. Supports text, HTML, and {{variable}} templates.',
    inputSchema: {
      type: 'object', required: ['to', 'subject'],
      properties: {
        to:       { oneOf: [EMAIL_PROP, { type: 'array', items: EMAIL_PROP, maxItems: 50 }] },
        subject:  { type: 'string', maxLength: 255 },
        text:     { type: 'string', description: 'Plain-text body' },
        html:     { type: 'string', description: 'HTML body' },
        replyTo:  { ...EMAIL_PROP, description: 'Reply-to address' },
        template: { type: 'string', description: 'Template with {{var}} placeholders' },
        vars:     { type: 'object', additionalProperties: { type: 'string' }, description: 'Template variables' },
        tags:     { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name','value'] } },
      },
      additionalProperties: false,
    },
    async handler({ to, subject, text, html, replyTo, template, vars, tags }) {
      const body = template ? emailService.renderTemplate(template, vars ?? {}) : html;
      return { success: true, ...await emailService.send({ to, subject, text, html: body, replyTo, tags }) };
    },
  },

  {
    name: 'hash_value',
    description: 'Hash a value with argon2id (secrets/OTPs) or HMAC-SHA256 (deterministic masking).',
    inputSchema: {
      type: 'object', required: ['value'],
      properties: {
        value:     { type: 'string' },
        algorithm: { type: 'string', enum: ['argon2id', 'hmac-sha256'], default: 'argon2id' },
      },
      additionalProperties: false,
    },
    async handler({ value, algorithm = 'argon2id' }) {
      const hash = algorithm === 'hmac-sha256'
        ? await hashingService.hmac(value)
        : await hashingService.hash(value);
      return { success: true, algorithm, hash };
    },
  },

  {
    name: 'verify_hash',
    description: 'Verify plaintext against an argon2id hash. Constant-time comparison.',
    inputSchema: {
      type: 'object', required: ['hash', 'value'],
      properties: {
        hash:  { type: 'string', description: 'argon2id hash from hash_value' },
        value: { type: 'string', description: 'Plaintext to verify' },
      },
      additionalProperties: false,
    },
    async handler({ hash, value }) {
      return { success: true, valid: await hashingService.verify(hash, value) };
    },
  },

  {
    name: 'sanitise_pii',
    description: 'Mask PII (phones, emails, API keys) in a string or object before logging or storage.',
    inputSchema: {
      type: 'object', required: ['data'],
      properties: { data: { description: 'String or object with potential PII' } },
    },
    async handler({ data }) {
      return { success: true, sanitised: sanitise(data) };
    },
  },

  {
    name: 'health_check',
    description: 'Check all provider health (Telnyx, Twilio, Resend) and rate limiter stats.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler() {
      const [providers, rl] = await Promise.all([allHealthChecks(), Promise.resolve(rateLimiter.stats())]);
      return { success: true, uptime: process.uptime(), memory: process.memoryUsage().rss, providers, rateLimiter: rl };
    },
  },

  {
    name: 'reset_rate_limit',
    description: 'Reset the rate limit for an identifier. Use after manual verification.',
    inputSchema: {
      type: 'object', required: ['identifier'],
      properties: { identifier: { type: 'string', description: 'Phone, email, or custom key' } },
    },
    async handler({ identifier }) {
      rateLimiter.reset(identifier);
      return { success: true, message: `Rate limit cleared for ${sanitise(identifier)}` };
    },
  },

]);

// O(1) handler lookup
const handlerMap = new Map(TOOLS.map(t => [t.name, t.handler]));

export const dispatch = async (toolName, args = {}) => {
  const handler = handlerMap.get(toolName);
  if (!handler) throw new Error(`Unknown tool: ${toolName}`);

  try {
    const result = await handler(args);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const safe = { success: false, error: sanitise(err.message ?? 'Unknown error'), code: err.code ?? 'TOOL_ERROR', ...(err.retryIn && { retryIn: err.retryIn }) };
    return { content: [{ type: 'text', text: JSON.stringify(safe, null, 2) }], isError: true };
  }
};

export { TOOLS };
export default TOOLS;
