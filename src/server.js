/**
 * src/server.js — MCP server with Streamable HTTP transport
 *
 * Transport choice: Streamable HTTP (POST /mcp)
 *  - One endpoint handles both requests and streaming responses
 *  - Stateless per-request — no dangling SSE connections
 *  - Accessible over Tailscale from any client
 *  - Falls back to stdio via --stdio flag
 *
 * Demonstrates:
 *  - Class with private fields and methods
 *  - async/await throughout
 *  - Callbacks -> Promises via promisify pattern
 *  - Object destructuring in async method bodies
 */

import { Server }                         from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport }           from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport }  from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import { TOOLS, dispatch }    from './tools/index.js';
import { logger }             from './middleware/privacy.js';
import config                 from './config/index.js';

export class CommsMcpServer {
  #server = null;
  #transport = null;

  constructor() {
    this.#server = new Server(
      { name: 'comms-mcp', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );
    this.#registerHandlers();
  }

  #registerHandlers() {
    this.#server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOLS.map(({ name, description, inputSchema }) => ({
        name, description, inputSchema,
      })),
    }));

    this.#server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      logger.plain('info', `[tool] -> ${name}`);
      return dispatch(name, args ?? {});
    });

    this.#server.onerror = (err) => {
      logger.plain('error', `[mcp] Server error: ${err.message}`);
    };
  }

  async startHTTP(app, path = '/mcp') {
    app.post(path, async (req, res) => {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => transport.close());
      await this.#server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });
    logger.plain('info', `[mcp] Streamable HTTP handler registered on ${path}`);
  }

  async startStdio() {
    const transport = new StdioServerTransport();
    await this.#server.connect(transport);
    logger.plain('info', '[mcp] Running in stdio mode');
    await new Promise((_, reject) => {
      process.stdin.on('close', () => reject(new Error('stdin closed')));
    });
  }
}
