/**
 * src/config/index.js
 *
 * Config management with:
 *  - ES2022 private class fields (#)
 *  - Proxy for unknown-key traps with method binding fix
 *  - Lazy validation
 *  - Nullish coalescing (??) and optional chaining (?.)
 *  - Tiny dotenv shim (zero dependencies)
 */

import { readFileSync, existsSync } from 'fs';

const loadDotenv = (path = '.env') => {
  if (!existsSync(path)) return;
  readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.trim() && !line.startsWith('#'))
    .forEach(line => {
      const eq = line.indexOf('=');
      if (eq === -1) return;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      process.env[key] ??= val;
    });
};

loadDotenv();

class Config {
  #validated = false;
  #warnings  = [];
  #required  = ['MCP_API_KEY'];
  #defaults  = {
    MCP_PORT:              '3700',
    LOG_LEVEL:             'info',
    SMS_PROVIDER:          'telnyx',
    VOICE_PROVIDER:        'telnyx',
    RATE_LIMIT_WINDOW_MS:  '600000',
    RATE_LIMIT_MAX_PER_ID: '5',
    EMAIL_FROM_NAME:       'COMMS-MCP',
    AUDIT_LOG_PATH:        './logs/audit.ndjson',
  };

  get(key) {
    return process.env[key] ?? this.#defaults[key] ?? undefined;
  }

  num  = (key, fallback = 0)     => parseInt(this.get(key) ?? fallback, 10);
  bool = (key, fallback = false) => (this.get(key) ?? String(fallback)) === 'true';
  str  = (key, fallback = '')    => this.get(key) ?? fallback;

  validate() {
    if (this.#validated) return this;

    const missing = this.#required.filter(k => !this.get(k));
    if (missing.length) throw new Error(`[config] Missing required env vars: ${missing.join(', ')}`);

    const optional = [
      ['TELNYX_API_KEY',     'SMS/Voice via Telnyx will not work'],
      ['RESEND_API_KEY',     'Email via Resend will not work'],
      ['TELNYX_FROM_NUMBER', 'SMS/Voice needs a from-number'],
    ];
    optional.forEach(([key, msg]) => {
      if (!this.get(key)) this.#warnings.push(`[config] Missing ${key}: ${msg}`);
    });
    this.#warnings.forEach(w => console.warn(w));
    this.#validated = true;
    return this;
  }

  snapshot() {
    const redact = k => /KEY|TOKEN|SID|SECRET|PASSWORD/i.test(k) ? '***' : this.get(k);
    return Object.fromEntries(
      [...Object.keys(this.#defaults), ...this.#required].map(k => [k, redact(k)])
    );
  }
}

const instance = new Config();

// Proxy: binds methods to target so private fields stay accessible
export const config = new Proxy(instance, {
  get(target, prop) {
    const val = Reflect.get(target, prop, target);
    if (typeof val === 'function') return val.bind(target);
    if (val === undefined && typeof prop === 'string') return target.get(prop);
    return val;
  },
});

export default config;
