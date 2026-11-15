import * as fs from 'node:fs';
import * as path from 'node:path';
import { TrueForge } from '@truefoundry/trueforge-sdk';
import {
  TrueForgeConfig,
  TurnApprovalRequest,
  StreamEventHandlers,
  ToolCallInfo,
  ToolResponseInfo,
} from './types';

export class TrueForgeClient {
  private client: TrueForge;
  private config: TrueForgeConfig;
  private currentSessionId: string | null = null;
  private currentTurnId: string | null = null;
  private activeAbortController: AbortController | null = null;
  private recentToolCalls = new Map<string, ToolCallInfo>();

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

  public getPrimaryModel(): string {
    return this.config.models[0] ?? 'google-gemini/gemini-3-1-flash-lite';
  }

  public getModels(): string[] {
    return [...this.config.models];
  }

  public getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  public getCurrentTurnId(): string | null {
    return this.currentTurnId;
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
   * Helper to load agent configuration from agent/agent.config.json.
   */
  private loadAgentConfigFile(): any {
    try {
      const candidates = [
        path.resolve(process.cwd(), 'agent', 'agent.config.json'),
        path.resolve(__dirname, '..', 'agent', 'agent.config.json'),
        path.resolve(__dirname, '..', '..', 'agent', 'agent.config.json'),
      ];
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          return JSON.parse(fs.readFileSync(p, 'utf-8'));
        }
      }
    } catch {}
    return null;
  }

  /**
   * Create an inline-spec session pointing to the registered MCP server.
   */
  public async createSession(options?: {
    modelName?: string;
    mcpServerName?: string;
    systemPrompt?: string;
    requireApprovalForTools?: string[];
  }): Promise<string> {
    const agentConfig = this.loadAgentConfigFile();
    const model = options?.modelName ?? this.getPrimaryModel() ?? agentConfig?.model?.name ?? 'google-gemini/gemini-3-1-flash-lite';
    const mcpServer = options?.mcpServerName ?? 'vscode-ide';
    const instructions =
      options?.systemPrompt ??
      agentConfig?.instructions ??
      'You are Forge Agent, an expert coding assistant embedded in VS Code. Use editor MCP tools to inspect and safely modify files.';

    const requireApprovalForTools =
      options?.requireApprovalForTools ??
      agentConfig?.mcp_servers?.[0]?.require_approval_for_tools ??
      ['propose_edit', 'run_command'];

    const session = await this.client.sessions.create({
      agent: {
        spec: {
          model: { name: model },
          instructions,
          mcpServers: [
            {
              name: mcpServer,
              enableTools: ['@all'],
              requireApprovalForTools,
              preload: false,
            },
          ],
          config: agentConfig?.config ?? {
            sandbox: { enabled: false },
            dynamicSubAgents: { enabled: true },
            contextManagement: {
              compaction: { enabled: true },
            },
          },
        },
      },
    });

    this.currentSessionId = session.data.id;
    return this.currentSessionId;
  }

  /**
   * Ensures an active session exists, creating one if needed.
   */
  public async getOrCreateSession(options?: {
    modelName?: string;
    mcpServerName?: string;
    systemPrompt?: string;
  }): Promise<string> {
    if (this.currentSessionId) {
      return this.currentSessionId;
    }
    return this.createSession(options);
  }

  /**
   * Reset session so a fresh one is created on the next turn.
   */
  public resetSession(): void {
    this.currentSessionId = null;
    this.currentTurnId = null;
    this.recentToolCalls.clear();
  }

  /**
   * Streams a turn asynchronously, forwarding all streamed events (tokens, tool calls, tool results, errors).
   * Fully non-blocking for the Extension Host.
   */
  public async streamTurn(
    sessionId: string,
    userPrompt: string,
    handlers: StreamEventHandlers
  ): Promise<{ turnId: string; status: string; reason?: string }> {
    this.activeAbortController = new AbortController();
    this.currentSessionId = sessionId;

    let turnId = '';
    let finalStatus = 'running';
    let finalReason: string | undefined;

    handlers.onStatusUpdate?.('starting', 'Initiating turn...');

    try {
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
        { abortSignal: this.activeAbortController.signal }
      );

      for await (const event of stream) {
        handlers.onEvent?.(event);

        switch (event.type) {
          case 'turn.created': {
            turnId = event.turnId;
            this.currentTurnId = turnId;
            handlers.onTurnCreated?.(turnId);
            handlers.onStatusUpdate?.('running', `Turn ${turnId.slice(-6)} active`);
            break;
          }

          case 'model.message': {
            const rawCalls = (event as any).toolCalls || (event as any).tool_calls;
            if (Array.isArray(rawCalls)) {
              for (const tc of rawCalls) {
                let name = tc.function?.name ?? tc.toolInfo?.name ?? 'unknown_tool';
                let parsedArgs = tc.function?.arguments;
                if (typeof parsedArgs === 'string') {
                  try {
                    parsedArgs = JSON.parse(parsedArgs);
                  } catch {}
                }
                if (name === 'call_tool' && parsedArgs?.tool_name) {
                  name = parsedArgs.tool_name;
                  parsedArgs = parsedArgs.arguments ?? {};
                }
                const info: ToolCallInfo = {
                  id: tc.id,
                  name,
                  arguments: parsedArgs,
                  sourceEventId: event.id,
                };
                this.recentToolCalls.set(tc.id, info);
                handlers.onToolCall?.(info);
                handlers.onStatusUpdate?.('calling_tool', `Agent calling: ${name}`);
              }
            } else if (typeof (event as any).content === 'string' && (event as any).content.length > 0) {
              handlers.onDelta?.((event as any).content);
            }
            break;
          }

          case 'model.message.delta': {
            const deltaCalls = (event as any).toolCalls || (event as any).tool_calls;
            if (Array.isArray(deltaCalls)) {
              for (const tc of deltaCalls) {
                let name = tc.function?.name ?? tc.toolInfo?.name ?? 'unknown_tool';
                let parsedArgs = tc.function?.arguments;
                if (typeof parsedArgs === 'string') {
                  try {
                    parsedArgs = JSON.parse(parsedArgs);
                  } catch {}
                }
                if (name === 'call_tool' && parsedArgs?.tool_name) {
                  name = parsedArgs.tool_name;
                  parsedArgs = parsedArgs.arguments ?? {};
                }
                const info: ToolCallInfo = {
                  id: tc.id,
                  name,
                  arguments: parsedArgs,
                  sourceEventId: event.id,
                };
                this.recentToolCalls.set(tc.id, info);
                handlers.onToolCall?.(info);
                handlers.onStatusUpdate?.('calling_tool', `Agent calling: ${name}`);
              }
            }
            const deltaContent = (event as any).content;
            if (typeof deltaContent === 'string' && deltaContent.length > 0) {
              handlers.onDelta?.(deltaContent);
              handlers.onStatusUpdate?.('streaming', 'Streaming response...');
            }
            break;
          }

          case 'tool.response': {
            const respInfo: ToolResponseInfo = {
              toolCallId: (event as any).toolCallId || (event as any).tool_call_id,
              content: (event as any).content ?? '',
            };
            handlers.onToolResponse?.(respInfo);
            handlers.onStatusUpdate?.('tool_completed', 'Tool execution finished');
            break;
          }

          case 'tool.approval_required': {
            const rawRefs = (event as any).toolCalls || (event as any).tool_calls || [];
            const enriched: ToolCallInfo[] = rawRefs.map((ref: any) => {
              const cached = this.recentToolCalls.get(ref.id);
              return {
                id: ref.id,
                name: cached?.name ?? 'gated_tool',
                arguments: cached?.arguments ?? {},
                sourceEventId: ref.sourceEventId || ref.source_event_id,
              };
            });
            handlers.onApprovalRequired?.(enriched);
            handlers.onStatusUpdate?.('paused', 'Approval required for tool execution');
            break;
          }

          case 'turn.update': {
            const updateStatus = (event as any).state?.status ?? 'running';
            handlers.onStatusUpdate?.(updateStatus, 'Turn updating');
            break;
          }

          case 'turn.done': {
            finalStatus = (event as any).state?.status ?? 'done';
            finalReason = (event as any).state?.reason;
            const metrics = (event as any).state?.metrics;
            handlers.onDone?.(finalStatus, finalReason, metrics);
            handlers.onStatusUpdate?.(
              finalStatus,
              finalStatus === 'cancelled'
                ? 'Turn cancelled'
                : finalStatus === 'error'
                ? `Turn error: ${finalReason || 'unknown'}`
                : 'Turn completed'
            );
            break;
          }
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError' || this.activeAbortController?.signal.aborted) {
        finalStatus = 'cancelled';
        finalReason = 'client-cancelled';
        handlers.onStatusUpdate?.('cancelled', 'Turn cancelled by client');
        handlers.onDone?.(finalStatus, finalReason);
      } else {
        handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
        handlers.onStatusUpdate?.('error', err.message || 'Execution error');
        throw err;
      }
    } finally {
      this.activeAbortController = null;
    }

    return { turnId, status: finalStatus, reason: finalReason };
  }

  /**
   * Approves or denies a gated tool execution.
   */
  public async sendToolApproval(
    sessionId: string,
    turnId: string,
    approvalOrId: TurnApprovalRequest | string,
    decision?: 'allow' | 'deny',
    reason?: string
  ): Promise<void> {
    const approval: TurnApprovalRequest =
      typeof approvalOrId === 'string'
        ? { toolCallId: approvalOrId, status: decision ?? 'allow', reason }
        : approvalOrId;

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
   * Immediately cancels a running turn on the session.
   */
  public async cancelTurn(sessionId?: string): Promise<void> {
    const targetSessionId = sessionId ?? this.currentSessionId;
    if (this.activeAbortController) {
      this.activeAbortController.abort();
    }
    if (targetSessionId) {
      try {
        await this.client.sessions.cancel(targetSessionId);
      } catch (err) {
        console.warn(`[TrueForgeClient] Cancel session warning for ${targetSessionId}:`, err);
      }
    }
  }
}
