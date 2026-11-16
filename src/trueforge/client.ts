import * as fs from 'node:fs';
import * as path from 'node:path';
import { TrueForge } from '@truefoundry/trueforge-sdk';
import {
  TrueForgeConfig,
  TurnApprovalRequest,
  StreamEventHandlers,
  ToolCallInfo,
  ToolResponseInfo,
  ResilientTurnResult,
} from './types';
import {
  sleep,
  calculateBackoffDelay,
  formatHumanReadableError,
} from './resilience';

export class TrueForgeClient {
  private client: TrueForge;
  private config: TrueForgeConfig;
  private currentSessionId: string | null = null;
  private currentTurnId: string | null = null;
  private activeAbortController: AbortController | null = null;
  private resilientAbortController: AbortController | null = null;
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
                let name = tc.function?.name ?? tc.toolInfo?.name ?? tc.name ?? 'unknown_tool';
                let parsedArgs = tc.function?.arguments ?? tc.arguments ?? tc.args;
                if (typeof parsedArgs === 'string') {
                  try {
                    parsedArgs = JSON.parse(parsedArgs);
                  } catch {}
                }
                if (name === 'call_tool' && (parsedArgs?.tool_name || parsedArgs?.name)) {
                  name = parsedArgs.tool_name || parsedArgs.name;
                  parsedArgs = parsedArgs.input ?? parsedArgs.arguments ?? {};
                }
                const info: ToolCallInfo = {
                  id: tc.id,
                  name,
                  arguments: parsedArgs,
                  sourceEventId: event.id,
                };
                if (tc.id) {
                  this.recentToolCalls.set(tc.id, info);
                }
                handlers.onToolCall?.(info);
                handlers.onStatusUpdate?.('calling_tool', `Agent calling: ${name}`);
              }
            } else if (typeof (event as any).content === 'string' && (event as any).content.length > 0) {
              handlers.onDelta?.((event as any).content);
            }
            break;
          }

          case 'model.message.delta': {
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
              let name = cached?.name ?? ref.name ?? ref.function?.name ?? 'gated_tool';
              let parsedArgs = cached?.arguments ?? ref.arguments ?? ref.function?.arguments ?? {};
              if (name === 'call_tool' && (parsedArgs?.tool_name || parsedArgs?.name)) {
                name = parsedArgs.tool_name || parsedArgs.name;
                parsedArgs = parsedArgs.input ?? parsedArgs.arguments ?? {};
              }
              return {
                id: ref.id,
                name,
                arguments: parsedArgs,
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
   * Executes a turn with full resilience:
   * (1) Retries transient failures with exponential backoff (max 2 retries per model).
   * (2) Automatically falls back to secondary models if primary model fails, with visible notices.
   * (3) On permanent failure, produces clean human-readable error descriptions (never stack traces).
   */
  public async streamTurnWithResilience(
    userPrompt: string,
    handlers: StreamEventHandlers,
    options?: {
      models?: string[];
      mcpServerName?: string;
      systemPrompt?: string;
      requireApprovalForTools?: string[];
      maxRetriesPerModel?: number;
      initialBackoffMs?: number;
      maxBackoffMs?: number;
    }
  ): Promise<ResilientTurnResult> {
    this.resilientAbortController = new AbortController();
    const abortSignal = this.resilientAbortController.signal;

    const candidateModels =
      options?.models && options.models.length > 0
        ? options.models
        : this.getModels().length > 0
        ? this.getModels()
        : [this.getPrimaryModel()];

    const maxRetries = options?.maxRetriesPerModel ?? 2;
    const initialBackoffMs = options?.initialBackoffMs ?? 1000;
    const maxBackoffMs = options?.maxBackoffMs ?? 8000;

    let overallAttempts = 0;
    let lastError: any = null;

    try {
      for (let modelIdx = 0; modelIdx < candidateModels.length; modelIdx++) {
        const currentModel = candidateModels[modelIdx];
        const isFallback = modelIdx > 0;

        if (abortSignal.aborted) {
          handlers.onDone?.('cancelled', 'client-cancelled');
          return {
            turnId: '',
            status: 'cancelled',
            modelUsed: currentModel,
            attempts: overallAttempts,
            reason: 'client-cancelled',
          };
        }

        if (isFallback) {
          const priorModel = candidateModels[modelIdx - 1];
          const noticeMsg = `Switching to fallback model "${currentModel}" after failures with prior model ("${priorModel}").`;
          handlers.onNotice?.(noticeMsg, 'warning');
          handlers.onStatusUpdate?.('fallback', `Switching to fallback model: ${currentModel}...`);
        }

        for (let retry = 0; retry <= maxRetries; retry++) {
          if (abortSignal.aborted) {
            handlers.onDone?.('cancelled', 'client-cancelled');
            return {
              turnId: '',
              status: 'cancelled',
              modelUsed: currentModel,
              attempts: overallAttempts,
              reason: 'client-cancelled',
            };
          }

          overallAttempts++;
          const isRetry = retry > 0;

          if (isRetry) {
            const delay = calculateBackoffDelay(retry, {
              maxRetriesPerModel: maxRetries,
              initialBackoffMs,
              maxBackoffMs,
              backoffMultiplier: 2,
            });
            const retryNotice = `Attempt ${retry} failed on model "${currentModel}". Retrying with exponential backoff in ${Math.round(delay / 1000)}s (attempt ${retry + 1} of ${1 + maxRetries})...`;
            handlers.onNotice?.(retryNotice, 'warning');
            handlers.onStatusUpdate?.('retrying', `Retrying on ${currentModel} (${Math.round(delay / 1000)}s backoff)...`);

            try {
              await sleep(delay, abortSignal);
            } catch {
              handlers.onDone?.('cancelled', 'client-cancelled');
              return {
                turnId: '',
                status: 'cancelled',
                modelUsed: currentModel,
                attempts: overallAttempts,
                reason: 'client-cancelled',
              };
            }
          }

          try {
            // Fresh session for this model if fallback, or if previous attempt failed
            this.resetSession();
            const sessionId = await this.createSession({
              modelName: currentModel,
              mcpServerName: options?.mcpServerName,
              systemPrompt: options?.systemPrompt,
              requireApprovalForTools: options?.requireApprovalForTools,
            });

            let attemptStatus = 'running';
            let attemptReason: string | undefined;
            let attemptMetrics: any;

            // Intercept onDone so we don't prematurely emit terminal 'error' to UI if retries/fallbacks remain
            const wrappedHandlers: StreamEventHandlers = {
              ...handlers,
              onDone: (status, reason, metrics) => {
                attemptStatus = status;
                attemptReason = reason;
                attemptMetrics = metrics;
              },
            };

            const turnResult = await this.streamTurn(sessionId, userPrompt, wrappedHandlers);

            if (turnResult.status === 'done' || attemptStatus === 'done') {
              if (isFallback || isRetry) {
                handlers.onNotice?.(`Turn completed successfully using model "${currentModel}".`, 'info');
              }
              handlers.onDone?.('done', attemptReason, attemptMetrics);
              return {
                turnId: turnResult.turnId,
                status: 'done',
                modelUsed: currentModel,
                attempts: overallAttempts,
                reason: attemptReason,
              };
            }

            if (turnResult.status === 'cancelled' || attemptStatus === 'cancelled') {
              handlers.onDone?.('cancelled', 'client-cancelled');
              return {
                turnId: turnResult.turnId,
                status: 'cancelled',
                modelUsed: currentModel,
                attempts: overallAttempts,
                reason: 'client-cancelled',
              };
            }

            // If turn finished with status === 'error'
            lastError = new Error(attemptReason || turnResult.reason || `Turn failed on model ${currentModel}`);
          } catch (err: any) {
            if (err.name === 'AbortError' || abortSignal.aborted) {
              handlers.onDone?.('cancelled', 'client-cancelled');
              return {
                turnId: '',
                status: 'cancelled',
                modelUsed: currentModel,
                attempts: overallAttempts,
                reason: 'client-cancelled',
              };
            }
            lastError = err;
          }
        }
      }

      // All candidate models and retries have been exhausted
      const finalModel = candidateModels[candidateModels.length - 1];
      const cleanError = formatHumanReadableError(lastError, {
        model: finalModel,
        baseUrl: this.getBaseUrl(),
        attempts: overallAttempts,
      });

      handlers.onError?.(new Error(cleanError));
      handlers.onStatusUpdate?.('error', cleanError);

      return {
        turnId: '',
        status: 'error',
        modelUsed: finalModel,
        attempts: overallAttempts,
        reason: cleanError,
      };
    } finally {
      this.resilientAbortController = null;
    }
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
    if (this.resilientAbortController) {
      this.resilientAbortController.abort();
    }
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
