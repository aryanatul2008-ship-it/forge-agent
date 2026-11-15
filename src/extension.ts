import * as vscode from 'vscode';
import { TrueForgeClient } from './trueforge/client';
import { LocalMcpServer } from './mcp/server';
import { DiffReviewEngine } from './review/diffReview';
import { AgentPanelProvider } from './webview/agentPanel';

export async function activate(context: vscode.ExtensionContext) {
  console.log('[Forge Agent] Activating extension...');

  // 1. Initialize Review Engine
  const reviewEngine = new DiffReviewEngine();

  // 2. Initialize and Register Webview View Provider
  const panelProvider = new AgentPanelProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AgentPanelProvider.viewType, panelProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // 3. Read Configuration
  const config = vscode.workspace.getConfiguration('forgeAgent');
  const trueforgeUrl = config.get<string>('trueforgeUrl', 'http://localhost:8790');
  const mcpPort = config.get<number>('mcpPort', 8795);
  const models = config.get<string[]>('models', [
    'google-gemini/gemini-3-1-flash-lite',
    'google-gemini/gemini-3-5-flash-lite',
  ]);

  // 4. Initialize TrueForge Client
  const tfClient = new TrueForgeClient({
    baseUrl: trueforgeUrl,
    models,
  });

  // Listen to configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('forgeAgent')) {
        const updatedConfig = vscode.workspace.getConfiguration('forgeAgent');
        const newUrl = updatedConfig.get<string>('trueforgeUrl', 'http://localhost:8790');
        const newModels = updatedConfig.get<string[]>('models', [
          'google-gemini/gemini-3-1-flash-lite',
          'google-gemini/gemini-3-5-flash-lite',
        ]);
        tfClient.updateConfig({ baseUrl: newUrl, models: newModels });
      }
    })
  );

  // 5. Initialize Local MCP Server
  const mcpServer = new LocalMcpServer(reviewEngine);

  // Start MCP server in background (async, non-blocking)
  mcpServer
    .start(mcpPort)
    .then(async (info) => {
      console.log(`[Forge Agent] Local MCP Server running on port ${info.port}`);
      try {
        await tfClient.registerMcpServer({
          name: 'vscode-ide',
          url: info.url,
          description: 'VS Code Editor capabilities (files, search, diff review, commands)',
          bearerToken: info.token,
        });
        console.log('[Forge Agent] Registered "vscode-ide" MCP server in TrueForge settings');
      } catch (err: any) {
        console.warn(
          '[Forge Agent] Could not auto-register MCP server in TrueForge settings:',
          err?.message || err
        );
      }
    })
    .catch((err) => {
      console.error('[Forge Agent] Failed to start local MCP server:', err);
    });

  // 6. Connect Webview Events to TrueForge Client
  panelProvider.onPromptSubmitted(async (userPrompt: string) => {
    try {
      panelProvider.postMessage({ type: 'status', status: 'running', details: 'Connecting to agent...' });

      // Ensure session exists
      const sessionId = await tfClient.getOrCreateSession({
        mcpServerName: 'vscode-ide',
        modelName: tfClient.getPrimaryModel(),
      });

      // Stream the turn asynchronously (never blocking the extension host)
      await tfClient.streamTurn(sessionId, userPrompt, {
        onTurnCreated: (turnId) => {
          panelProvider.postMessage({ type: 'assistantStart', turnId });
        },
        onDelta: (content) => {
          panelProvider.postMessage({ type: 'token', content });
        },
        onToolCall: (call) => {
          panelProvider.postMessage({
            type: 'toolCall',
            id: call.id,
            name: call.name,
            arguments: call.arguments,
          });
        },
        onToolResponse: (resp) => {
          panelProvider.postMessage({
            type: 'toolResponse',
            toolCallId: resp.toolCallId,
            content: resp.content,
          });
        },
        onApprovalRequired: (calls) => {
          for (const call of calls) {
            panelProvider.postMessage({
              type: 'toolApprovalRequired',
              toolCallId: call.id,
              name: call.name,
              arguments: call.arguments,
            });
          }
        },
        onStatusUpdate: (status, details) => {
          panelProvider.postMessage({ type: 'status', status, details });
        },
        onDone: (status, reason, metrics) => {
          panelProvider.postMessage({ type: 'turnDone', status, reason, metrics });
        },
        onError: (err) => {
          panelProvider.postMessage({ type: 'error', message: err.message });
        },
      });
    } catch (err: any) {
      panelProvider.postMessage({
        type: 'error',
        message: err?.message || 'Failed to execute turn in TrueForge',
      });
    }
  });

  // Handle Cancel Requested from Webview or Command
  const handleCancelTurn = async () => {
    panelProvider.postMessage({
      type: 'status',
      status: 'cancelling',
      details: 'Cancelling running turn...',
    });

    try {
      await tfClient.cancelTurn();
      reviewEngine.clearAllStagedEdits();
      panelProvider.postMessage({
        type: 'turnDone',
        status: 'cancelled',
        reason: 'client-cancelled',
      });
      vscode.window.showInformationMessage('Forge Agent turn cancelled.');
    } catch (err: any) {
      console.warn('[Forge Agent] Error cancelling turn:', err);
    }
  };

  panelProvider.onCancelRequested(handleCancelTurn);

  // 7. Register Commands
  const openPanelCommand = vscode.commands.registerCommand('forgeAgent.openPanel', () => {
    panelProvider.show();
  });

  const tfOpenPanelCommand = vscode.commands.registerCommand('tfAgent.openPanel', () => {
    panelProvider.show();
  });

  const openChatCommand = vscode.commands.registerCommand('forgeAgent.openChat', () => {
    panelProvider.show();
  });

  const cancelTurnCommand = vscode.commands.registerCommand('forgeAgent.cancelTurn', handleCancelTurn);

  context.subscriptions.push(
    openPanelCommand,
    tfOpenPanelCommand,
    openChatCommand,
    cancelTurnCommand,
    {
      dispose: () => {
        void mcpServer.stop();
      },
    }
  );

  console.log('[Forge Agent] Extension activated successfully.');
}

export function deactivate() {
  console.log('[Forge Agent] Deactivating extension...');
}
