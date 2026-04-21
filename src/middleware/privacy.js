/**
 * src/middleware/privacy.js
 *
 * Demonstrates:
 *  - Closures (mask function factory)
 *  - WeakMap for private audit state
 *  - Generator function for monotonic audit IDs
 *  - Symbol for internal marker
 *  - Tagged template literals for log sanitisation
 */

import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import config from '../config/index.js';

export const SANITISED = Symbol('sanitised');

function* auditIdGen(prefix = 'EVT') {
  let n = 0;
  while (true) yield `${prefix}-${Date.now()}-${(++n).toString().padStart(4, '0')}`;
}
const nextId = auditIdGen('COMMS');

// PII masking — each is a closure over its regex
const makeMasker = (pattern, replacer) =>
  (str) => String(str ?? '').replace(pattern, replacer);

export const maskPhone = makeMasker(
  /(\+?\d{1,4})[\s.-]?(\d{1,4})[\s.-]?\d{3,4}[\s.-]?\d{3,4}/g,
  (_, country, prefix) => `${country} ${prefix}** **** ****`
);

export const maskEmail = makeMasker(
  /([a-zA-Z0-9._%+-]{1,2})[a-zA-Z0-9._%+-]*@([a-zA-Z0-9.-]+)/g,
  (_, start, domain) => `${start}***@${domain}`
);

export const maskApiKey = makeMasker(
  /(KEY|TOKEN|SID|Bearer)\s*[:\s]?\s*([A-Za-z0-9_\-]{6})[A-Za-z0-9_\-]*/gi,
  (_, type, first6) => `${type} ${first6}***`
);

const maskers = [maskPhone, maskEmail, maskApiKey];

export const sanitise = (value) => {
  if (typeof value !== 'string') {
    if (Array.isArray(value)) return value.map(sanitise);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitise(v)]));
    return value;
  }
  return maskers.reduce((acc, fn) => fn(acc), value);
};

// Audit logger — WeakMap keeps per-event metadata private (GC-friendly)
const _meta = new WeakMap();

class AuditEvent {
  constructor(tool, input) {
    _meta.set(this, { tool, input: sanitise(input), ts: new Date().toISOString() });
    this.id = nextId.next().value;
  }

  complete({ success, result, error } = {}) {
    const meta = _meta.get(this);
    const entry = {
      id:      this.id,
      ts:      meta.ts,
      tool:    meta.tool,
      input:   meta.input,
      success,
      result:  success ? '[ok]' : undefined,
      error:   error ? sanitise(String(error)) : undefined,
      elapsed: Date.now() - new Date(meta.ts).getTime(),
    };
    const path = config.str('AUDIT_LOG_PATH');
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify(entry) + '\n');
    } catch { /* non-fatal */ }
    return entry;
  }
}

export const audit = (tool, input) => new AuditEvent(tool, input);

// Tagged-template logger — sanitises inline values at call time
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[config.str('LOG_LEVEL', 'info')] ?? 1;

const log = (level) => (strings, ...values) => {
  if ((LEVELS[level] ?? 1) < currentLevel) return;
  const msg = strings.reduce((acc, str, i) => acc + str + sanitise(String(values[i] ?? '')), '');
  console[level === 'debug' ? 'log' : level](`[${level.toUpperCase()}] ${msg}`);
};

export const logger = {
  debug: log('debug'),
  info:  log('info'),
  warn:  log('warn'),
  error: log('error'),
  plain: (level, msg) => log(level)`${msg}`,
};
