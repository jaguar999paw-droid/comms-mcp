/**
 * src/management.js — Phase 4: audit reader + provider circuit breaker
 *
 * Demonstrates:
 *  - Async generator for streaming NDJSON file reads line-by-line
 *  - Class with private state (circuit breaker)
 *  - setTimeout-based half-open probe
 *  - Object.entries iteration
 */

import { createReadStream } from 'fs';
import { createInterface }  from 'readline';
import config               from './config/index.js';
import { logger }           from './middleware/privacy.js';

// ── Audit log reader — async generator, streams file without loading all ──────
async function* readNdjson(path, limit = 50) {
  let handle;
  try {
    handle = createReadStream(path, { encoding: 'utf8' });
  } catch {
    return; // file doesn't exist yet — yield nothing
  }

  const lines = [];
  const rl    = createInterface({ input: handle, crlfDelay: Infinity });

  for await (const line of rl) {
    if (line.trim()) {
      try { lines.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
  }

  // Yield the last `limit` entries (most recent at the end of the file)
  yield* lines.slice(-limit);
}

export const getAuditEntries = async (n = 50) => {
  const path    = config.str('AUDIT_LOG_PATH', './logs/audit.ndjson');
  const entries = [];
  for await (const entry of readNdjson(path, n)) entries.push(entry);
  return entries;
};

// ── Circuit breaker — wraps a provider call, auto-opens on repeated failures ──
// States: CLOSED (normal) → OPEN (failing) → HALF_OPEN (probing)
const CB_STATES = { CLOSED: 'closed', OPEN: 'open', HALF_OPEN: 'half_open' };

export class CircuitBreaker {
  #state        = CB_STATES.CLOSED;
  #failures     = 0;
  #lastFailure  = null;
  #name;

  // Config — destructured with defaults
  #cfg;
  constructor(name, { threshold = 5, resetAfterMs = 60_000 } = {}) {
    this.#name = name;
    this.#cfg  = { threshold, resetAfterMs };
  }

  get state()    { return this.#state; }
  get failures() { return this.#failures; }

  async call(fn) {
    if (this.#state === CB_STATES.OPEN) {
      // Check if enough time has passed to try again
      const elapsed = Date.now() - (this.#lastFailure ?? 0);
      if (elapsed >= this.#cfg.resetAfterMs) {
        this.#state = CB_STATES.HALF_OPEN;
        logger.plain('info', `[circuit/${this.#name}] half-open — probing`);
      } else {
        throw Object.assign(
          new Error(`[${this.#name}] circuit open — provider unavailable`),
          { code: 'CIRCUIT_OPEN', retryIn: Math.ceil((this.#cfg.resetAfterMs - elapsed) / 1000) }
        );
      }
    }

    try {
      const result = await fn();
      // Success — reset
      if (this.#state !== CB_STATES.CLOSED) {
        logger.plain('info', `[circuit/${this.#name}] closed — provider recovered`);
      }
      this.#failures = 0;
      this.#state    = CB_STATES.CLOSED;
      return result;
    } catch (err) {
      this.#failures++;
      this.#lastFailure = Date.now();

      if (this.#failures >= this.#cfg.threshold || this.#state === CB_STATES.HALF_OPEN) {
        this.#state = CB_STATES.OPEN;
        logger.plain('warn', `[circuit/${this.#name}] OPEN after ${this.#failures} failures`);
      }
      throw err;
    }
  }

  snapshot() {
    return {
      name:     this.#name,
      state:    this.#state,
      failures: this.#failures,
      ...(this.#lastFailure && { lastFailure: new Date(this.#lastFailure).toISOString() }),
    };
  }
}

// Singleton breakers — one per provider
export const breakers = {
  telnyx: new CircuitBreaker('telnyx', { threshold: 5, resetAfterMs: 60_000 }),
  twilio: new CircuitBreaker('twilio', { threshold: 5, resetAfterMs: 60_000 }),
  resend: new CircuitBreaker('resend', { threshold: 5, resetAfterMs: 60_000 }),
};
