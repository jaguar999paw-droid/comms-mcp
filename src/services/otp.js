/**
 * src/services/otp.js — OTP flow with Redis persistence (Phase 2 complete)
 *
 * Drop-in upgrade from the in-memory scaffold.
 * Requires:  npm i ioredis
 * Env:       REDIS_URL=redis://localhost:6379
 *
 * Demonstrates:
 *  - Class with private fields (#cfg, #generator, #redis)
 *  - async generator for cryptographically-secure code production
 *  - Lazy Redis connection (only opens on first call)
 *  - Promise.race for connection timeout guard
 *  - Optional chaining + nullish coalescing throughout
 *  - Closure-based store abstraction (swappable backend)
 */

import { hashingService, smsService, emailService } from './index.js';
import { rateLimiter }                              from '../middleware/rateLimit.js';
import { audit, sanitise, logger }                  from '../middleware/privacy.js';

// ── Async generator — yields cryptographically-secure OTP codes ───────────────
async function* otpGenerator(length = 6) {
  const { randomInt } = await import('crypto');
  while (true) {
    yield Array.from({ length }, () => randomInt(0, 10)).join('');
  }
}

// ── Redis store — lazily connected ────────────────────────────────────────────
// Wraps ioredis behind the same async interface the in-memory store used,
// so OtpService never knows which backend it's talking to.
const makeRedisStore = () => {
  let _redis = null;

  // Lazy connect — only opens socket on first actual call
  const redis = async () => {
    if (_redis) return _redis;
    const { default: Redis } = await import('ioredis');
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379';

    // Promise.race: if Redis doesn't respond in 3s, fail fast
    _redis = await Promise.race([
      new Promise((resolve, reject) => {
        const r = new Redis(url, { lazyConnect: true, enableReadyCheck: true });
        r.once('ready', () => resolve(r));
        r.once('error', reject);
        r.connect().catch(reject);
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('[otp] Redis connect timeout after 3s')), 3000)
      ),
    ]);

    logger.plain('info', '[otp] Redis connected');
    return _redis;
  };

  return {
    async set(key, { hash, expiresAt, attempts = 0 }) {
      const ttl = Math.ceil((expiresAt - Date.now()) / 1000);
      if (ttl <= 0) return; // already expired before we even stored it
      const r = await redis();
      await r.setex(key, ttl, JSON.stringify({ hash, expiresAt, attempts }));
    },

    async get(key) {
      const r   = await redis();
      const raw = await r.get(key);
      return raw ? JSON.parse(raw) : null;
    },

    async del(key) {
      const r = await redis();
      await r.del(key);
    },

    // Atomic increment using a Lua script — avoids read-modify-write race
    async incrAttempts(key) {
      const r = await redis();
      // Lua: get, increment attempts, re-set with same TTL, return new count
      const script = `
        local raw = redis.call('GET', KEYS[1])
        if not raw then return 0 end
        local data = cjson.decode(raw)
        local ttl  = redis.call('TTL', KEYS[1])
        if ttl <= 0 then return 0 end
        data.attempts = (data.attempts or 0) + 1
        redis.call('SETEX', KEYS[1], ttl, cjson.encode(data))
        return data.attempts
      `;
      return r.eval(script, 1, key);
    },
  };
};

// ── Fallback in-memory store (used if Redis is unavailable) ───────────────────
const makeMemoryStore = () => {
  const _m = new Map();
  return {
    async set(key, v)    { _m.set(key, v); },
    async get(key)       { return _m.get(key) ?? null; },
    async del(key)       { _m.delete(key); },
    async incrAttempts(key) {
      const e = _m.get(key);
      if (!e) return 0;
      e.attempts = (e.attempts ?? 0) + 1;
      return e.attempts;
    },
  };
};

// ── OTP Service ───────────────────────────────────────────────────────────────
class OtpService {
  #generator = null;
  #store     = null;  // resolved lazily on first call
  #cfg       = { ttlSeconds: 300, maxAttempts: 3, codeLength: 6 };

  constructor(cfg = {}) {
    this.#cfg = { ...this.#cfg, ...cfg };
  }

  // Lazy generator — iterator instance created on first call, then reused
  async #nextCode() {
    if (!this.#generator) this.#generator = otpGenerator(this.#cfg.codeLength);
    return (await this.#generator.next()).value;
  }

  // Lazy store — tries Redis, falls back to memory if unavailable
  async #getStore() {
    if (this.#store) return this.#store;
    if (!process.env.REDIS_URL) {
      logger.warn`[otp] REDIS_URL not set — using in-memory store (not suitable for production)`;
      this.#store = makeMemoryStore();
      return this.#store;
    }
    try {
      const s = makeRedisStore();
      // Warm up connection now so the first generate() call isn't delayed
      await s.get('__ping__').catch(() => null);
      this.#store = s;
    } catch (err) {
      logger.warn`[otp] Redis unavailable (${err.message}) — falling back to memory store`;
      this.#store = makeMemoryStore();
    }
    return this.#store;
  }

  #key = (channel, id) => `otp:${channel}:${id}`;

  /**
   * generate({ identifier, channel })
   *   channel    : 'sms' | 'email'
   *   identifier : E.164 phone number or email address
   *
   * Returns { sent, channel, destination (masked), expiresIn }
   * The plaintext code is NEVER returned or logged.
   */
  async generate({ identifier, channel = 'sms' }) {
    const ev = audit('generate_otp', { channel, identifier });

    // Per-identifier rate limit (5 requests per 5 minutes)
    const { allowed, resetAt } = rateLimiter.check(
      `otp:gen:${identifier}`,
      { limit: 5, window: 300_000 }
    );
    if (!allowed) {
      const retryIn = Math.ceil((resetAt - Date.now()) / 1000);
      throw Object.assign(
        new Error(`Too many OTP requests. Retry in ${retryIn}s`),
        { code: 'RATE_LIMITED', retryIn }
      );
    }

    try {
      const store     = await this.#getStore();
      const code      = await this.#nextCode();
      const hash      = await hashingService.hash(code);
      const expiresAt = Date.now() + this.#cfg.ttlSeconds * 1000;

      await store.set(this.#key(channel, identifier), { hash, expiresAt, attempts: 0 });

      // Deliver plaintext code via the appropriate channel — NEVER log it
      if (channel === 'sms') {
        await smsService.send({
          to:   identifier,
          text: `Your code: ${code}. Expires in ${this.#cfg.ttlSeconds / 60}min. Do not share.`,
        });
      } else if (channel === 'email') {
        await emailService.send({
          to:      identifier,
          subject: 'Your verification code',
          text:    `Your code: ${code}\n\nExpires in ${this.#cfg.ttlSeconds / 60} minutes. Do not share.`,
          html:    `<p style="font-size:32px;letter-spacing:6px;font-weight:bold">${code}</p>
                    <p>Expires in ${this.#cfg.ttlSeconds / 60} minutes. Do not share this code.</p>`,
        });
      } else {
        throw new Error(`Unknown channel: ${channel}`);
      }

      ev.complete({ success: true });
      // Code is out of scope after this return — hash is all that survives
      return {
        sent:        true,
        channel,
        destination: sanitise(identifier),  // masked before leaving this module
        expiresIn:   this.#cfg.ttlSeconds,
      };
    } catch (err) {
      ev.complete({ success: false, error: err });
      throw err;
    }
  }

  /**
   * verify({ identifier, channel, code })
   * Returns { valid: boolean, reason?: string, attemptsRemaining?: number }
   */
  async verify({ identifier, channel = 'sms', code }) {
    const ev    = audit('verify_otp', { channel, identifier });
    const store = await this.#getStore();
    const key   = this.#key(channel, identifier);

    try {
      const entry = await store.get(key);

      if (!entry) {
        ev.complete({ success: false });
        return { valid: false, reason: 'expired_or_not_found' };
      }

      if (Date.now() > entry.expiresAt) {
        await store.del(key);
        ev.complete({ success: false });
        return { valid: false, reason: 'expired' };
      }

      const attempts = await store.incrAttempts(key);
      if (attempts > this.#cfg.maxAttempts) {
        await store.del(key);
        ev.complete({ success: false });
        return { valid: false, reason: 'too_many_attempts' };
      }

      // Constant-time argon2 comparison — immune to timing attacks
      const valid = await hashingService.verify(entry.hash, code);

      if (valid) {
        await store.del(key);                              // one-time use
        rateLimiter.reset(`otp:gen:${identifier}`);       // unlock identifier
      }

      ev.complete({ success: valid });
      return {
        valid,
        ...(valid ? {} : { attemptsRemaining: this.#cfg.maxAttempts - attempts }),
      };
    } catch (err) {
      ev.complete({ success: false, error: err });
      throw err;
    }
  }
}

export const otpService = new OtpService();
export { OtpService };
