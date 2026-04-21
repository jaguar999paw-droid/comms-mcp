#!/usr/bin/env node
/**
 * src/index.js — Entry point
 *
 * Demonstrates:
 *  - Top-level await (ES2022 modules)
 *  - process.argv parsing without a library
 *  - Graceful shutdown with async cleanup
 *  - Unhandled rejection / uncaught exception guards
 */

import config                from './config/index.js';
import { CommsMcpServer }    from './server.js';
import { buildApp, startServer } from './http.js';
import { logger }            from './middleware/privacy.js';

// ── Parse CLI flags ───────────────────────────────────────────────────────────
// Destructuring with rest — collect everything after 'node' and the script path
const [, , ...flags] = process.argv;
const useStdio = flags.includes('--stdio');

// ── Validate config early ─────────────────────────────────────────────────────
config.validate();
logger.plain('info', '[comms-mcp] Starting...');

if (config.bool('LOG_LEVEL') || process.env.LOG_LEVEL === 'debug') {
  logger.plain('debug', '[config] ' + JSON.stringify(config.snapshot(), null, 2));
}

// ── Boot ──────────────────────────────────────────────────────────────────────
const mcpServer = new CommsMcpServer();

if (useStdio) {
  // ── stdio mode — for Claude Desktop direct attachment ─────────────────────
  logger.plain('info', '[comms-mcp] stdio mode — add to claude_desktop_config.json');
  await mcpServer.startStdio();

} else {
  // ── HTTP mode — persistent service on dizaster ────────────────────────────
  const port = config.num('MCP_PORT', 3700);
  const app  = buildApp(mcpServer);
  const srv  = await startServer(app, port);

  logger.plain('info', `[comms-mcp] Listening on http://0.0.0.0:${port}`);
  logger.plain('info', `[comms-mcp] MCP endpoint: POST http://0.0.0.0:${port}/mcp`);
  logger.plain('info', `[comms-mcp] Health:        GET  http://0.0.0.0:${port}/health`);
  logger.plain('info', `[comms-mcp] Via Tailscale: http://100.118.209.46:${port}/mcp`);
  logger.plain('info', `[comms-mcp] Auth: Authorization: Bearer <MCP_API_KEY>`);

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = async (signal) => {
    logger.plain('info', `[comms-mcp] ${signal} received — shutting down`);
    await new Promise(resolve => srv.close(resolve));
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

// ── Safety nets ───────────────────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  logger.plain('error', `[comms-mcp] Unhandled rejection: ${String(reason)}`);
});

process.on('uncaughtException', (err) => {
  logger.plain('error', `[comms-mcp] Uncaught exception: ${err.message}`);
  process.exit(1);
});
