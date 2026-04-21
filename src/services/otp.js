/**
 * src/services/otp.js — OTP flow (Phase 2 scaffold)
 *
 * Wired and ready — swap the in-memory store for Redis
 * by replacing the three TODO comments in `store`.
 *
 * Demonstrates:
 *  - Class with private fields (#)
 *  - async generator for cryptographically-secure code generation
 *  - Closure over in-memory store (drop-in Redis replacement)
 *  - Optional chaining + nullish coalescing throughout
 */

import { hashingService, smsService, emailService } from './index.js';
import { rateLimiter }                              from '../middleware/rateLimit.js';
import { audit, sanitise }                          from '../middleware/privacy.js';

// Cryptographically secure OTP generator — async generator
async function* otpGenerator(length = 6) {
  const { randomInt } = await import('crypto');
  while (true) {
    yield Array.from({ length }, () => randomInt(0, 10)).join('');
  }
}

// In-memory store — REPLACE with Redis in production
// Redis shape: SETEX otp:{channel}:{id} <ttl_secs> <json>
const _store = new Map();
const store = {
  async set(key, { hash, expiresAt, attempts = 0 }) {
    // TODO: await redis.setex(key, Math.ceil((expiresAt - Date.now()) / 1000), JSON.stringify({ hash, expiresAt, attempts }));
    _store.set(key, { hash, expiresAt, attempts });
  },
  async get(key) {
    // TODO: const raw = await redis.get(key); return raw ? JSON.parse(raw) : null;
    return _store.get(key) ?? null;
  },
  async del(key) {
    // TODO: await redis.del(key);
    _store.delete(key);
  },
  async incrAttempts(key) {
    const entry = await this.get(key);
    if (!entry) return 0;
    entry.attempts += 1;
    await this.set(key, entry);
    return entry.attempts;
  },
};

class OtpService {
  #generator = null;
  #cfg = { ttlSeconds: 300, maxAttempts: 3, codeLength: 6 };

  constructor(cfg = {}) { this.#cfg = { ...this.#cfg, ...cfg }; }

  async #nextCode() {
    if (!this.#generator) this.#generator = otpGenerator(this.#cfg.codeLength);
    return (await this.#generator.next()).value;
  }

  #key = (channel, id) => `otp:${channel}:${id}`;

  async generate({ identifier, channel = 'sms' }) {
    const ev = audit('generate_otp', { channel, identifier });

    const { allowed, resetAt } = rateLimiter.check(`otp:gen:${identifier}`, { limit: 5, window: 300_000 });
    if (!allowed) throw Object.assign(
      new Error(`Too many OTP requests. Retry in ${Math.ceil((resetAt - Date.now()) / 1000)}s`),
      { code: 'RATE_LIMITED' }
    );

    try {
      const code      = await this.#nextCode();
      const hash      = await hashingService.hash(code);
      const expiresAt = Date.now() + this.#cfg.ttlSeconds * 1000;

      await store.set(this.#key(channel, identifier), { hash, expiresAt, attempts: 0 });

      // Deliver plaintext code — NEVER log it
      if (channel === 'sms') {
        await smsService.send({
          to:   identifier,
          text: `Your code: ${code}. Expires in ${this.#cfg.ttlSeconds / 60}min. Do not share.`,
        });
      } else if (channel === 'email') {
        await emailService.send({
          to:      identifier,
          subject: 'Your verification code',
          text:    `Your code: ${code}\n\nExpires in ${this.#cfg.ttlSeconds / 60} minutes.`,
          html:    `<p>Your code: <strong>${code}</strong><br>Expires in ${this.#cfg.ttlSeconds / 60} minutes.</p>`,
        });
      } else {
        throw new Error(`Unknown channel: ${channel}`);
      }

      ev.complete({ success: true });
      return { sent: true, channel, destination: sanitise(identifier), expiresIn: this.#cfg.ttlSeconds };
    } catch (err) {
      ev.complete({ success: false, error: err });
      throw err;
    }
  }

  async verify({ identifier, channel = 'sms', code }) {
    const ev  = audit('verify_otp', { channel, identifier });
    const key = this.#key(channel, identifier);

    try {
      const entry = await store.get(key);

      if (!entry) { ev.complete({ success: false }); return { valid: false, reason: 'expired_or_not_found' }; }
      if (Date.now() > entry.expiresAt) { await store.del(key); ev.complete({ success: false }); return { valid: false, reason: 'expired' }; }

      const attempts = await store.incrAttempts(key);
      if (attempts > this.#cfg.maxAttempts) {
        await store.del(key);
        ev.complete({ success: false });
        return { valid: false, reason: 'too_many_attempts' };
      }

      const valid = await hashingService.verify(entry.hash, code);

      if (valid) {
        await store.del(key);
        rateLimiter.reset(`otp:gen:${identifier}`);
      }

      ev.complete({ success: valid });
      return { valid, ...(valid ? {} : { attemptsRemaining: this.#cfg.maxAttempts - attempts }) };
    } catch (err) {
      ev.complete({ success: false, error: err });
      throw err;
    }
  }
}

export const otpService = new OtpService();
export { OtpService };
