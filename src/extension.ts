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

  // 5. Initialize Local MCP Server
  const mcpServer = new LocalMcpServer(reviewEngine);

  // Start MCP server in the background (does not block activation)
  mcpServer
    .start(mcpPort)
    .then(async (info) => {
      console.log(`[Forge Agent] Local MCP Server started at ${info.url}`);
      try {
        await tfClient.registerMcpServer({
          name: 'vscode-ide',
          url: info.url,
          description: 'VS Code Editor capabilities (files, search, diff review, commands)',
          bearerToken: info.token,
        });
        console.log('[Forge Agent] Registered "vscode-ide" MCP server in TrueForge settings');
      } catch (err: any) {
        console.warn('[Forge Agent] Warning: Could not auto-register MCP server in TrueForge:', err?.message || err);
      }
    })
    .catch((err) => {
      console.error('[Forge Agent] Failed to start local MCP server:', err);
    });

  // 6. Register Commands
  // Command required by prompt: "TF Agent: Open Panel"
  const openPanelCommand = vscode.commands.registerCommand('forgeAgent.openPanel', () => {
    panelProvider.show();
  });

  // Alias for tfAgent.openPanel
  const tfOpenPanelCommand = vscode.commands.registerCommand('tfAgent.openPanel', () => {
    panelProvider.show();
  });

  const openChatCommand = vscode.commands.registerCommand('forgeAgent.openChat', () => {
    panelProvider.show();
  });

  const cancelTurnCommand = vscode.commands.registerCommand('forgeAgent.cancelTurn', async () => {
    reviewEngine.clearAllStagedEdits();
    vscode.window.showInformationMessage('Forge Agent turn cancelled and staged edits cleared.');
  });

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
