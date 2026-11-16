import * as vscode from 'vscode';
import { TrueForgeClient } from './trueforge/client';
import { formatHumanReadableError } from './trueforge/resilience';
import { LocalMcpServer } from './mcp/server';
import { DiffReviewEngine } from './review/diffReview';
import { ProposedContentProvider } from './review/virtualDocProvider';
import { AgentPanelProvider } from './webview/agentPanel';
import { InlineEditController } from './editor/inlineEdit';
import { WorkspaceRetrieval } from './context/retrieval';
import { WorkspaceIndexer } from './context/indexer';
import { ContextEngine } from './context/engine';

function getEffectiveModels(config: vscode.WorkspaceConfiguration): string[] {
  const models = config.get<string[]>('models', []);
  const primary = config.get<string>('primaryModel');
  const fallback = config.get<string>('fallbackModel');

  const result: string[] = [];
  if (primary && primary.trim()) {
    result.push(primary.trim());
  }
  if (models && models.length > 0) {
    for (const m of models) {
      if (m && m.trim() && !result.includes(m.trim())) {
        result.push(m.trim());
      }
    }
  }
  if (fallback && fallback.trim() && !result.includes(fallback.trim())) {
    result.push(fallback.trim());
  }

  if (result.length === 0) {
    result.push('google-gemini/gemini-3-1-flash-lite', 'google-gemini/gemini-3-5-flash-lite');
  }
  return result;
}

export async function activate(context: vscode.ExtensionContext) {
  console.log('[Forge Agent] Activating extension...');

  // 1. Initialize Review Engine & Virtual Document Provider
  const reviewEngine = new DiffReviewEngine();
  const proposedProvider = new ProposedContentProvider(reviewEngine);

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      ProposedContentProvider.scheme,
      proposedProvider
    )
  );

  // 2. Initialize and Register Webview View Provider
  const panelProvider = new AgentPanelProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AgentPanelProvider.viewType, panelProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // 3. Read Configuration & Initialize Context Engine
  const config = vscode.workspace.getConfiguration('forgeAgent');
  const trueforgeUrl = config.get<string>('trueforgeUrl', 'http://localhost:8790');
  const mcpPort = config.get<number>('mcpPort', 8795);
  const models = getEffectiveModels(config);
  const contextBudget = config.get<number>('contextBudgetTokens', 6000);

  const indexer = new WorkspaceIndexer();
  const contextEngine = new ContextEngine(indexer, { maxTokens: contextBudget });

  // Index workspace in background
  indexer.initialize().then(() => {
    console.log(
      `[Forge Agent] Workspace indexed: ${indexer.getIndexedFilesCount()} files, ${indexer.getIndexedChunksCount()} chunks, ${indexer.getIndexedSymbolsCount()} symbols`
    );
  }).catch((err) => {
    console.warn('[Forge Agent] Background workspace indexing error:', err);
  });

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
        const newModels = getEffectiveModels(updatedConfig);
        const newBudget = updatedConfig.get<number>('contextBudgetTokens', 6000);
        tfClient.updateConfig({ baseUrl: newUrl, models: newModels });
        contextEngine.setBudgetTokens(newBudget);
      }
    })
  );

  // 5. Initialize Local MCP Server with Context Engine
  const mcpServer = new LocalMcpServer(reviewEngine, contextEngine);

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

  // 6. Connect Webview Events, Autocomplete Mentions & Diff Review to TrueForge Client
  panelProvider.onQueryMentions((query) => {
    const suggestions = contextEngine.getMentionSuggestions(query);
    panelProvider.postMessage({ type: 'mentionSuggestions', suggestions });
  });

  panelProvider.onOpenFile(async (filePath: string, line?: number) => {
    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (workspaceFolders && workspaceFolders.length > 0) {
        const rootUri = workspaceFolders[0].uri;
        const fileUri = vscode.Uri.joinPath(rootUri, filePath);
        const doc = await vscode.workspace.openTextDocument(fileUri);
        const editor = await vscode.window.showTextDocument(doc);
        if (line && line > 0) {
          const pos = new vscode.Position(line - 1, 0);
          editor.selection = new vscode.Selection(pos, pos);
          editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        }
      }
    } catch (err: any) {
      vscode.window.showWarningMessage(`Could not open file ${filePath}: ${err?.message || err}`);
    }
  });

  panelProvider.onPromptSubmitted(async (userPrompt: string) => {
    try {
      panelProvider.postMessage({ type: 'status', status: 'running', details: 'Retrieving context...' });

      // Retrieve bounded context via ContextEngine (mentions + BM25 chunks + symbols)
      const contextRes = await contextEngine.retrieveRelevantContext(userPrompt);

      if (contextRes.snippets.length > 0) {
        panelProvider.postMessage({
          type: 'contextUsed',
          items: contextRes.snippets.map((s) => ({
            file: s.filePath,
            range: `Lines ${s.startLine}-${s.endLine}`,
            reason: s.reason,
            tokens: s.tokens,
            snippetPreview: s.content.slice(0, 300),
            line: s.startLine,
          })),
          totalTokens: contextRes.totalTokens,
          budgetTokens: contextRes.budgetTokens,
          summary: contextRes.summary,
        });
      }

      panelProvider.postMessage({ type: 'status', status: 'running', details: 'Connecting to agent...' });

      const promptWithContext = contextRes.formattedContext
        ? `${contextRes.formattedContext}\n\n### User Request:\n${userPrompt}`
        : userPrompt;

      // Stream the turn with full resilience (exponential backoff, fallback models, human errors)
      const turnResult = await tfClient.streamTurnWithResilience(
        promptWithContext,
        {
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
          onApprovalRequired: async (calls) => {
            for (const call of calls) {
              if (call.name === 'propose_edit') {
                const filePath = call.arguments?.file || call.arguments?.path || call.arguments?.file_path;
                const explanation = call.arguments?.explanation || call.arguments?.description || 'Proposed code modifications';
                const newContent = call.arguments?.new_content || call.arguments?.newContent || call.arguments?.content;
                const hunks = call.arguments?.edits || call.arguments?.hunks;

                let staged: any;
                if (filePath) {
                  try {
                    staged = await reviewEngine.stageEdit(call.id, filePath, explanation, { newContent, hunks });
                  } catch (stageErr: any) {
                    console.warn('[Forge Agent] Error staging proposed edit:', stageErr);
                  }
                }

                panelProvider.postMessage({
                  type: 'toolApprovalRequired',
                  toolCallId: call.id,
                  name: call.name,
                  arguments: call.arguments,
                  edit: staged,
                });
              } else {
                panelProvider.postMessage({
                  type: 'toolApprovalRequired',
                  toolCallId: call.id,
                  name: call.name,
                  arguments: call.arguments,
                });
              }
            }
          },
          onNotice: (message, level) => {
            panelProvider.postMessage({ type: 'notice', message, level });
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
        },
        {
          models: tfClient.getModels(),
          mcpServerName: 'vscode-ide',
        }
      );

      if (turnResult.status === 'error') {
        reviewEngine.clearAllStagedEdits();
      }
    } catch (err: any) {
      reviewEngine.clearAllStagedEdits();
      const humanMsg = formatHumanReadableError(err, {
        model: tfClient.getPrimaryModel(),
        baseUrl: tfClient.getBaseUrl(),
      });
      panelProvider.postMessage({
        type: 'error',
        message: humanMsg,
      });
    }
  });

  // Tool Approval / Hunk Decisions
  panelProvider.onApprovalDecision(async (toolCallId, decision, reason) => {
    try {
      const sessionId = tfClient.getCurrentSessionId();
      const turnId = tfClient.getCurrentTurnId();
      if (sessionId && turnId) {
        await tfClient.sendToolApproval(sessionId, turnId, toolCallId, decision, reason);
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to send tool approval: ${err?.message || err}`);
    }
  });

  panelProvider.onHunkDecision((toolCallId, hunkId, decision) => {
    reviewEngine.setHunkDecision(toolCallId, hunkId, decision);
  });

  panelProvider.onAllHunksDecision((toolCallId, decision) => {
    reviewEngine.setAllHunksDecision(toolCallId, decision);
  });

  panelProvider.onOpenDiff((toolCallId, filePath) => {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      const rootUri = workspaceFolders[0].uri;
      const origUri = vscode.Uri.joinPath(rootUri, filePath);
      const propUri = vscode.Uri.parse(
        `${ProposedContentProvider.scheme}:/${filePath}?toolCallId=${toolCallId}`
      );
      vscode.commands.executeCommand('vscode.diff', origUri, propUri, `Review: ${filePath}`);
    }
  });

  reviewEngine.onStagedEditChange((edit) => {
    panelProvider.postMessage({ type: 'stagedEdit', edit });
  });

  // Handle Cancel Requested from Webview or Command
  const handleCancelTurn = async () => {
    panelProvider.postMessage({
      type: 'status',
      status: 'cancelling',
      details: 'Cancelling running turn...',
    });

    try {
      WorkspaceRetrieval.killRunningCommands();
      await tfClient.cancelTurn();
      reviewEngine.clearAllStagedEdits();

      // Close any open diff editors displaying proposed edits
      try {
        for (const group of vscode.window.tabGroups.all) {
          for (const tab of group.tabs) {
            if (tab.input && typeof tab.input === 'object' && 'modified' in tab.input) {
              const modUri = (tab.input as any).modified;
              if (modUri?.scheme === ProposedContentProvider.scheme) {
                vscode.window.tabGroups.close(tab);
              }
            }
          }
        }
      } catch {}

      panelProvider.postMessage({
        type: 'turnDone',
        status: 'cancelled',
        reason: 'client-cancelled',
      });
      vscode.window.showInformationMessage('Forge Agent turn cancelled. All staged edits discarded.');
    } catch (err: any) {
      console.warn('[Forge Agent] Error cancelling turn:', err);
    }
  };

  panelProvider.onCancelRequested(handleCancelTurn);

  // 7. Register Commands & Inline Edit Controller
  const inlineController = new InlineEditController(tfClient, reviewEngine);

  const inlineEditCommand = vscode.commands.registerCommand('forgeAgent.inlineEdit', async () => {
    await inlineController.triggerInlineEdit();
  });

  const tfInlineEditCommand = vscode.commands.registerCommand('tfAgent.inlineEdit', async () => {
    await inlineController.triggerInlineEdit();
  });

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

  const undoLastChangeCommand = vscode.commands.registerCommand('forgeAgent.undoLastChange', async () => {
    const result = await reviewEngine.undoLastChange();
    if (result.success) {
      vscode.window.showInformationMessage(result.message);
    } else {
      vscode.window.showWarningMessage(result.message);
    }
  });

  const tfUndoLastChangeCommand = vscode.commands.registerCommand('tfAgent.undoLastChange', async () => {
    await vscode.commands.executeCommand('forgeAgent.undoLastChange');
  });

  context.subscriptions.push(
    openPanelCommand,
    tfOpenPanelCommand,
    openChatCommand,
    cancelTurnCommand,
    undoLastChangeCommand,
    tfUndoLastChangeCommand,
    inlineEditCommand,
    tfInlineEditCommand,
    inlineController.getStatusBarItem(),
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
