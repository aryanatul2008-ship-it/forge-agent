import * as vscode from 'vscode';
import { TrueForgeClient } from '../trueforge/client';
import { DiffReviewEngine } from '../review/diffReview';
import { ProposedContentProvider } from '../review/virtualDocProvider';

export class InlineEditController {
  private tfClient: TrueForgeClient;
  private reviewEngine: DiffReviewEngine;
  private statusBarItem: vscode.StatusBarItem;
  private activeCancellationTokenSource: vscode.CancellationTokenSource | null = null;

  constructor(tfClient: TrueForgeClient, reviewEngine: DiffReviewEngine) {
    this.tfClient = tfClient;
    this.reviewEngine = reviewEngine;
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.name = 'Forge Agent Status';
  }

  public getStatusBarItem(): vscode.StatusBarItem {
    return this.statusBarItem;
  }

  /**
   * Prompts user for instruction on active editor selection and streams inline edit.
   */
  public async triggerInlineEdit(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('No active editor open for inline edit.');
      return;
    }

    const doc = editor.document;
    const selection = editor.selection;

    // Use current selection or fallback to current line
    const targetRange = selection.isEmpty
      ? doc.lineAt(selection.active.line).range
      : new vscode.Range(selection.start, selection.end);

    const selectedText = doc.getText(targetRange);
    const startLine = targetRange.start.line + 1;
    const endLine = targetRange.end.line + 1;
    const relativePath = vscode.workspace.asRelativePath(doc.uri);

    // Context: up to 12 lines before and after
    const contextStartLine = Math.max(0, targetRange.start.line - 12);
    const contextEndLine = Math.min(doc.lineCount - 1, targetRange.end.line + 12);
    const contextRange = new vscode.Range(
      new vscode.Position(contextStartLine, 0),
      new vscode.Position(contextEndLine, doc.lineAt(contextEndLine).text.length)
    );
    const contextText = doc.getText(contextRange);

    // 1. Show Input Box
    const instruction = await vscode.window.showInputBox({
      title: `Forge Agent Inline Edit (${relativePath}:${startLine}-${endLine})`,
      prompt: 'Enter your edit instruction. Press Enter to submit, Esc to cancel.',
      placeHolder: "e.g. Treat the values 'off' and 'n' as false as well, case-insensitively...",
      ignoreFocusOut: true,
    });

    if (!instruction || instruction.trim().length === 0) {
      return; // User cancelled with Esc or empty
    }

    // 2. Setup Progress in Status Bar & CancellationToken
    this.activeCancellationTokenSource = new vscode.CancellationTokenSource();
    const token = this.activeCancellationTokenSource.token;

    this.statusBarItem.text = '$(sync~spin) Forge Agent: Thinking...';
    this.statusBarItem.tooltip = 'Forge Agent is generating your edit. Press Esc or click to cancel.';
    this.statusBarItem.command = 'forgeAgent.cancelTurn';
    this.statusBarItem.show();

    let tokensReceived = 0;
    let stagedToolCallId: string | null = null;

    token.onCancellationRequested(async () => {
      this.statusBarItem.text = '$(x) Forge Agent: Cancelled';
      setTimeout(() => this.statusBarItem.hide(), 2500);
      try {
        await this.tfClient.cancelTurn();
        this.reviewEngine.clearAllStagedEdits();
      } catch {}
    });

    try {
      const sessionId = await this.tfClient.getOrCreateSession({
        mcpServerName: 'vscode-ide',
        modelName: this.tfClient.getPrimaryModel(),
      });

      const prompt = [
        `You are performing an inline edit in VS Code on file "${relativePath}".`,
        `Lines ${startLine}-${endLine} are selected.`,
        '',
        '### Selected Code:',
        '```',
        selectedText,
        '```',
        '',
        '### Surrounding Context:',
        '```',
        contextText,
        '```',
        '',
        '### User Instruction:',
        instruction.trim(),
        '',
        'CRITICAL INSTRUCTION:',
        `Call the \`propose_edit\` tool on "${relativePath}" with the modified code in \`new_content\` or \`hunks\`.`,
        'Only modify what was requested by the user instruction.',
      ].join('\n');

      await this.tfClient.streamTurn(sessionId, prompt, {
        onDelta: (content) => {
          tokensReceived += content.length;
          this.statusBarItem.text = `$(sync~spin) Forge Agent: Streaming edit (~${Math.round(tokensReceived / 4)} tokens)...`;
        },
        onApprovalRequired: async (calls) => {
          for (const call of calls) {
            if (call.name === 'propose_edit') {
              stagedToolCallId = call.id;
              const filePath = call.arguments?.file || call.arguments?.path || relativePath;
              const explanation = call.arguments?.explanation || call.arguments?.description || instruction;
              const newContent = call.arguments?.new_content || call.arguments?.newContent || call.arguments?.content;
              const hunks = call.arguments?.edits || call.arguments?.hunks;

              await this.reviewEngine.stageEdit(call.id, filePath, explanation, { newContent, hunks });
            }
          }
        },
        onStatusUpdate: (status, details) => {
          if (status === 'calling_tool') {
            this.statusBarItem.text = '$(tools) Forge Agent: Preparing proposed edit...';
          }
        },
      });

      this.statusBarItem.text = '$(check) Forge Agent: Edit Ready';
      setTimeout(() => this.statusBarItem.hide(), 3000);

      // 3. In-Editor Diff Review Workflow
      if (stagedToolCallId) {
        await this.handleInEditorReview(stagedToolCallId, doc.uri, relativePath);
      } else {
        // Fallback: check if an edit was staged under the file path
        const stagedByFile = this.reviewEngine.getStagedEditForFile(relativePath);
        if (stagedByFile) {
          await this.handleInEditorReview(stagedByFile.toolCallId, doc.uri, relativePath);
        } else {
          vscode.window.showInformationMessage('Forge Agent completed turn without proposing edits.');
        }
      }
    } catch (err: any) {
      if (!token.isCancellationRequested) {
        this.statusBarItem.text = '$(error) Forge Agent: Error';
        vscode.window.showErrorMessage(`Inline edit failed: ${err?.message || err}`);
      }
    } finally {
      this.activeCancellationTokenSource?.dispose();
      this.activeCancellationTokenSource = null;
    }
  }

  /**
   * Prompts user with review options (Open Diff Editor, Accept All, Reject All, Per-Hunk review).
   */
  private async handleInEditorReview(
    toolCallId: string,
    originalUri: vscode.Uri,
    relativePath: string
  ): Promise<void> {
    const staged = this.reviewEngine.getStagedEdit(toolCallId);
    if (!staged || staged.hunks.length === 0) {
      return;
    }

    const proposedUri = vscode.Uri.parse(
      `${ProposedContentProvider.scheme}:/${relativePath}?toolCallId=${toolCallId}`
    );

    // Automatically open the side-by-side diff in VS Code editor
    await vscode.commands.executeCommand(
      'vscode.diff',
      originalUri,
      proposedUri,
      `Inline Diff: ${relativePath} (${staged.hunks.length} hunks)`
    );

    // Present quick-action review options
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: '$(check) Accept All Changes',
          description: `Apply all ${staged.hunks.length} proposed hunk(s) to ${relativePath}`,
          action: 'accept_all',
        },
        {
          label: '$(list-unordered) Review Hunks Individually',
          description: 'Accept or reject each proposed hunk one by one',
          action: 'review_hunks',
        },
        {
          label: '$(x) Reject All Changes',
          description: 'Discard proposed changes; workspace remains unchanged',
          action: 'reject_all',
        },
      ],
      {
        placeHolder: `Proposed edit for ${relativePath}: ${staged.description}`,
        ignoreFocusOut: true,
      }
    );

    if (!choice || choice.action === 'reject_all') {
      this.reviewEngine.setAllHunksDecision(toolCallId, 'rejected');
      const sessionId = this.tfClient.getCurrentSessionId();
      const turnId = this.tfClient.getCurrentTurnId();
      if (sessionId && turnId) {
        await this.tfClient.sendToolApproval(sessionId, turnId, toolCallId, 'deny', 'User rejected changes');
      }
      this.reviewEngine.clearAllStagedEdits();
      vscode.window.showInformationMessage('Inline edit rejected. Workspace unchanged.');
      return;
    }

    if (choice.action === 'review_hunks') {
      await this.promptIndividualHunksReview(toolCallId, relativePath);
    } else if (choice.action === 'accept_all') {
      this.reviewEngine.setAllHunksDecision(toolCallId, 'accepted');
    }

    // Apply approved edit
    const sessionId = this.tfClient.getCurrentSessionId();
    const turnId = this.tfClient.getCurrentTurnId();

    const hasAccepted = staged.hunks.some((h) => h.status === 'accepted');
    if (hasAccepted) {
      if (sessionId && turnId) {
        await this.tfClient.sendToolApproval(sessionId, turnId, toolCallId, 'allow');
      }
      const result = await this.reviewEngine.applyApprovedEdit(toolCallId);
      vscode.window.showInformationMessage(
        `Inline edit applied to ${result.filePath} (${result.appliedCount} hunks applied). Use "TF Agent: Undo Last Applied Change" or Ctrl+Z to undo.`
      );
    } else {
      if (sessionId && turnId) {
        await this.tfClient.sendToolApproval(sessionId, turnId, toolCallId, 'deny', 'User rejected all hunks');
      }
      this.reviewEngine.clearAllStagedEdits();
      vscode.window.showInformationMessage('No hunks were accepted. Workspace unchanged.');
    }
  }

  /**
   * Prompts user for individual hunk decisions.
   */
  private async promptIndividualHunksReview(
    toolCallId: string,
    relativePath: string
  ): Promise<void> {
    const staged = this.reviewEngine.getStagedEdit(toolCallId);
    if (!staged) return;

    for (const hunk of staged.hunks) {
      const decision = await vscode.window.showQuickPick(
        [
          {
            label: '$(check) Accept this Hunk',
            description: `Lines ${hunk.oldStart}-${hunk.oldStart + Math.max(1, hunk.oldLines) - 1}`,
            value: 'accepted' as const,
          },
          {
            label: '$(x) Reject this Hunk',
            description: 'Keep original code for this section',
            value: 'rejected' as const,
          },
        ],
        {
          placeHolder: `Hunk ${hunk.id} for ${relativePath}: Line ${hunk.oldStart}`,
          ignoreFocusOut: true,
        }
      );

      hunk.status = decision?.value ?? 'rejected';
      this.reviewEngine.setHunkDecision(toolCallId, hunk.id, hunk.status);
    }
  }
}
