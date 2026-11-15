import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getEditorTools, executeEditorTool } from './tools';
import { DiffReviewEngine } from '../review/diffReview';

export interface McpServerInfo {
  port: number;
  url: string;
  token: string;
}

export class LocalMcpServer {
  private httpServer: http.Server | null = null;
  private token: string;
  private port: number = 0;
  private reviewEngine: DiffReviewEngine;
  private activeSessions = new Map<string, { server: Server; transport: SSEServerTransport }>();

  constructor(reviewEngine: DiffReviewEngine) {
    this.reviewEngine = reviewEngine;
    this.token = randomUUID();
  }

  public getToken(): string {
    return this.token;
  }

  public getPort(): number {
    return this.port;
  }

  public getUrl(): string {
    return `http://127.0.0.1:${this.port}/sse`;
  }

  public isListening(): boolean {
    return this.httpServer !== null && this.httpServer.listening;
  }

  public getInfo(): McpServerInfo | null {
    if (!this.isListening()) {
      return null;
    }
    return {
      port: this.port,
      url: this.getUrl(),
      token: this.token,
    };
  }

  private createMcpProtocolInstance(): Server {
    const server = new Server(
      { name: 'vscode-ide', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: getEditorTools(),
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;
      const args = request.params.arguments ?? {};
      const toolCallId = (request.params as any)?._meta?.call_id ?? randomUUID();

      const result = await executeEditorTool(
        toolName,
        args,
        toolCallId,
        this.reviewEngine
      );

      return {
        content: result.content,
        isError: result.isError,
      };
    });

    return server;
  }

  /**
   * Starts the local MCP server on desiredPort, falling back to an ephemeral port if busy.
   */
  public async start(desiredPort: number = 8795): Promise<McpServerInfo> {
    if (this.isListening()) {
      return this.getInfo()!;
    }

    const tryListen = (port: number): Promise<number> => {
      return new Promise((resolve, reject) => {
        const srv = http.createServer(async (req, res) => {
          // Handle CORS preflight
          if (req.method === 'OPTIONS') {
            res.writeHead(204, {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
              'Access-Control-Allow-Headers': 'Authorization, Content-Type',
            });
            res.end();
            return;
          }

          // Verify Bearer Auth Header
          const authHeader = req.headers.authorization;
          if (authHeader !== `Bearer ${this.token}`) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized: Invalid or missing bearer token' }));
            return;
          }

          const url = new URL(req.url ?? '/', 'http://127.0.0.1');

          if (url.pathname === '/sse') {
            const transport = new SSEServerTransport('/message', res);
            const protocol = this.createMcpProtocolInstance();
            await protocol.connect(transport);
            this.activeSessions.set(transport.sessionId, { server: protocol, transport });

            transport.onclose = () => {
              this.activeSessions.delete(transport.sessionId);
            };
          } else if (url.pathname === '/message') {
            const sessionId = url.searchParams.get('sessionId');
            const session =
              (sessionId ? this.activeSessions.get(sessionId) : null) ||
              Array.from(this.activeSessions.values()).pop();

            if (session) {
              await session.transport.handlePostMessage(req, res);
            } else {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'No active SSE connection found' }));
            }
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
          }
        });

        srv.once('error', (err: any) => {
          srv.close();
          reject(err);
        });

        srv.listen(port, '127.0.0.1', () => {
          this.httpServer = srv;
          const actualPort = (srv.address() as any).port;
          resolve(actualPort);
        });
      });
    };

    try {
      this.port = await tryListen(desiredPort);
    } catch (err: any) {
      if (err.code === 'EADDRINUSE') {
        console.warn(`[LocalMcpServer] Port ${desiredPort} in use; falling back to ephemeral port...`);
        this.port = await tryListen(0);
      } else {
        throw err;
      }
    }

    return {
      port: this.port,
      url: this.getUrl(),
      token: this.token,
    };
  }

  public async stop(): Promise<void> {
    for (const session of this.activeSessions.values()) {
      await session.transport.close().catch(() => {});
    }
    this.activeSessions.clear();

    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer?.close(() => resolve());
      });
      this.httpServer = null;
    }
  }
}
