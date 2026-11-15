import { TrueForge } from '@truefoundry/trueforge-sdk';
import { TrueForgeConfig, TurnApprovalRequest, StreamEventHandlers } from './types';

export class TrueForgeClient {
  private client: TrueForge;
  private config: TrueForgeConfig;

  constructor(config: TrueForgeConfig) {
    this.config = config;
    this.client = new TrueForge({ baseUrl: config.baseUrl });
  }

  public updateConfig(config: TrueForgeConfig): void {
    this.config = config;
    this.client = new TrueForge({ baseUrl: config.baseUrl });
  }

  public getBaseUrl(): string {
    return this.config.baseUrl;
  }

  public getModels(): string[] {
    return [...this.config.models];
  }

  public getUnderlyingClient(): TrueForge {
    return this.client;
  }

  /**
   * Register or update a remote MCP server definition in TrueForge settings.
   */
  public async registerMcpServer(params: {
    name: string;
    url: string;
    description: string;
    bearerToken?: string;
  }): Promise<void> {
    await this.client.settings.mcpServers.createOrUpdate({
      manifest: {
        name: params.name,
        type: 'remote',
        description: params.description,
        url: params.url,
        ...(params.bearerToken
          ? {
              auth: {
                type: 'header',
                headers: {
                  authorization: `Bearer ${params.bearerToken}`,
                },
              },
            }
          : {}),
      },
    });
  }

  /**
   * Create an inline-spec session pointing to the registered MCP server.
   */
  public async createSession(options: {
    modelName: string;
    mcpServerName: string;
    systemPrompt?: string;
    requireApprovalForTools?: string[];
  }): Promise<string> {
    const session = await this.client.sessions.create({
      agent: {
        spec: {
          model: { name: options.modelName },
          instructions:
            options.systemPrompt ??
            'You are Forge Agent, an expert coding assistant embedded in VS Code. Use editor MCP tools to inspect and safely modify files.',
          mcpServers: [
            {
              name: options.mcpServerName,
              enableTools: ['@all'],
              requireApprovalForTools: options.requireApprovalForTools ?? ['propose_edit', 'run_command'],
              preload: false,
            },
          ],
          config: {
            sandbox: { enabled: false },
            dynamicSubAgents: { enabled: true },
            contextManagement: {
              compaction: { enabled: true },
            },
          },
        },
      },
    });

    return session.data.id;
  }

  /**
   * Streams a turn and delivers events to handlers.
   */
  public async streamTurn(
    sessionId: string,
    userPrompt: string,
    handlers: StreamEventHandlers,
    abortSignal?: AbortSignal
  ): Promise<{ turnId: string; status: string; reason?: string }> {
    const stream = await this.client.sessions.createTurnStream(
      sessionId,
      {
        input: [
          {
            type: 'user.message',
            content: userPrompt,
          },
        ],
      },
      { abortSignal }
    );

    let turnId = '';
    let finalStatus = 'running';
    let finalReason: string | undefined;

    try {
      for await (const event of stream) {
        handlers.onEvent?.(event);

        if (event.type === 'turn.created') {
          turnId = event.turnId;
        } else if (event.type === 'model.message.delta') {
          if ((event as any).content) {
            handlers.onDelta?.((event as any).content);
          }
        } else if (event.type === 'tool.approval_required') {
          const rawCalls = (event as any).toolCalls || (event as any).tool_calls || [];
          const calls = rawCalls.map((c: any) => ({
            id: c.id,
            sourceEventId: c.sourceEventId || c.source_event_id,
          }));
          handlers.onApprovalRequired?.(calls);
        } else if (event.type === 'turn.done') {
          finalStatus = (event as any).state?.status ?? 'done';
          finalReason = (event as any).state?.reason;
          handlers.onDone?.(finalStatus, finalReason);
          break;
        }
      }
    } catch (err: any) {
      handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }

    return { turnId, status: finalStatus, reason: finalReason };
  }

  /**
   * Sends user tool approval (allow or deny).
   */
  public async sendToolApproval(
    sessionId: string,
    turnId: string,
    approval: TurnApprovalRequest
  ): Promise<void> {
    await this.client.sessions.createTurnEvents(sessionId, turnId, {
      events: [
        {
          type: 'user.tool_approval',
          toolCallId: approval.toolCallId,
          threadId: approval.threadId ?? 'main',
          approval:
            approval.status === 'allow'
              ? { status: 'allow' }
              : { status: 'deny', reason: approval.reason ?? 'User denied tool execution' },
        },
      ],
    });
  }

  /**
   * Cancels a running turn on the session.
   */
  public async cancelTurn(sessionId: string): Promise<void> {
    await this.client.sessions.cancel(sessionId);
  }
}
