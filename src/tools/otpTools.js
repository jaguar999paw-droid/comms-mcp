/**
 * src/tools/otpTools.js — OTP tools (Phase 2)
 *
 * Wire into src/tools/index.js once Redis is configured:
 *   import { OTP_TOOLS } from './otpTools.js';
 *   // spread into TOOLS array: [...existingTools, ...OTP_TOOLS]
 */

import { otpService } from '../services/otp.js';

export const OTP_TOOLS = Object.freeze([
  {
    name: 'generate_otp',
    description: 'Generate a 6-digit OTP and deliver via SMS or email. Code is hashed before storage — never returned to caller.',
    inputSchema: {
      type: 'object', required: ['identifier', 'channel'],
      properties: {
        identifier: { type: 'string', description: 'E.164 phone (SMS) or email address' },
        channel:    { type: 'string', enum: ['sms', 'email'] },
      },
      additionalProperties: false,
    },
    async handler({ identifier, channel }) {
      return otpService.generate({ identifier, channel });
    },
  },
  {
    name: 'verify_otp',
    description: 'Verify a 6-digit OTP. Returns valid: true/false. Locks out after 3 failed attempts.',
    inputSchema: {
      type: 'object', required: ['identifier', 'channel', 'code'],
      properties: {
        identifier: { type: 'string' },
        channel:    { type: 'string', enum: ['sms', 'email'] },
        code:       { type: 'string', pattern: '^\\d{6}$', description: '6-digit user-submitted code' },
      },
      additionalProperties: false,
    },
    async handler({ identifier, channel, code }) {
      return { success: true, ...await otpService.verify({ identifier, channel, code }) };
    },
  },
]);
