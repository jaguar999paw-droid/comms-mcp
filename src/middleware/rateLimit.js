/**
 * src/middleware/rateLimit.js
 *
 * Demonstrates:
 *  - IIFE for singleton rate-limiter state (closure over a Map)
 *  - Computed property names in TOOL_LIMITS
 *  - Class with static factory methods (AuthError)
 *  - Bearer token auth middleware
 */

import config from '../config/index.js';
import { logger } from './privacy.js';

// Sliding window rate limiter — IIFE keeps store private
export const rateLimiter = (() => {
  const store      = new Map();
  const windowMs   = config.num('RATE_LIMIT_WINDOW_MS', 600_000);
  const maxPerWindow = config.num('RATE_LIMIT_MAX_PER_ID', 5);

  return {
    check(identifier, { limit = maxPerWindow, window = windowMs } = {}) {
      const key    = String(identifier);
      const now    = Date.now();
      const prev   = (store.get(key) ?? []).filter(ts => ts > now - window);

      if (prev.length >= limit) {
        const resetAt = prev[0] + window;
        return { allowed: false, remaining: 0, resetAt };
      }

      prev.push(now);
      store.set(key, prev);
      return { allowed: true, remaining: limit - prev.length, resetAt: now + window };
    },

    reset(identifier) { store.delete(String(identifier)); },

    stats() {
      return { trackedIdentifiers: store.size, windowMs, maxPerWindow };
    },
  };
})();

// Per-tool limits — computed property names
export const TOOL_LIMITS = {
  ['send_sms']:     { limit: 5,  window: 600_000 },
  ['make_call']:    { limit: 3,  window: 600_000 },
  ['send_email']:   { limit: 20, window: 600_000 },
  ['generate_otp']: { limit: 5,  window: 300_000 },
  ['verify_otp']:   { limit: 5,  window: 300_000 },
};

// Auth
class AuthError extends Error {
  constructor(message, code = 'UNAUTHORISED') {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.http = 401;
  }
  static missing() { return new AuthError('Missing Authorization header'); }
  static invalid() { return new AuthError('Invalid API key'); }
}

const _key = (() => {
  const k = config.str('MCP_API_KEY');
  if (!k || k === 'change-me-to-a-strong-secret')
    logger.warn`MCP_API_KEY is not set or is the default — server is unsecured`;
  return k;
})();

export const verifyBearer = (authHeader) => {
  if (!authHeader) throw AuthError.missing();
  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !token) throw AuthError.missing();
  if (token !== _key) throw AuthError.invalid();
};

export const authMiddleware = (req, res, next) => {
  try {
    verifyBearer(req.headers.authorization);
    next();
  } catch (err) {
    res.status(err.http ?? 401).json({ error: err.message });
  }
};
