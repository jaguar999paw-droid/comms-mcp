/**
 * src/http.js — Express app wrapping the MCP server
 */

import express              from 'express';
import { authMiddleware }   from './middleware/rateLimit.js';
import { sanitise, logger } from './middleware/privacy.js';
import { allHealthChecks }  from './providers/index.js';
import config               from './config/index.js';

export const buildApp = (mcpServer) => {
  const app = express();

  app.use(express.json({ limit: '1mb' }));

  app.use((req, _res, next) => {
    logger.debug`${req.method} ${req.path}`;
    next();
  });

  // Public — no auth
  app.get('/health', async (_req, res) => {
    res.json({ service: 'comms-mcp', status: 'ok', uptime: process.uptime(), ts: new Date().toISOString() });
  });

  app.get('/status', async (_req, res) => {
    const providers = await allHealthChecks();
    res.json({ providers });
  });

  // MCP endpoint — bearer auth required
  app.use('/mcp', authMiddleware);
  mcpServer.startHTTP(app, '/mcp');

  // Webhook receivers (Phase 3: add signature verification here)
  app.post('/webhooks/telnyx', (req, res) => {
    const { event_type } = req.body ?? {};
    logger.plain('info', `[webhook/telnyx] ${event_type ?? 'unknown'}`);
    res.sendStatus(200);
  });

  app.post('/webhooks/resend', (req, res) => {
    const { type } = req.body ?? {};
    logger.plain('info', `[webhook/resend] ${type ?? 'unknown'}`);
    res.sendStatus(200);
  });

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    logger.plain('error', `[http] ${sanitise(err.message)}`);
    res.status(err.status ?? 500).json({ error: sanitise(err.message ?? 'Internal error') });
  });

  return app;
};

export const startServer = (app, port) =>
  new Promise((resolve, reject) => {
    const srv = app.listen(port, '0.0.0.0', () => resolve(srv));
    srv.once('error', reject);
  });
