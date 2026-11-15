import * as vscode from 'vscode';
import { DiffReviewEngine } from './diffReview';
import { applyPartialHunks } from './diff';

export class ProposedContentProvider implements vscode.TextDocumentContentProvider {
  public static scheme = 'forge-proposed';
  private reviewEngine: DiffReviewEngine;
  private onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  public onDidChange = this.onDidChangeEmitter.event;

  constructor(reviewEngine: DiffReviewEngine) {
    this.reviewEngine = reviewEngine;
    this.reviewEngine.onStagedEditChange((edit) => {
      const uri = vscode.Uri.parse(`${ProposedContentProvider.scheme}:/${edit.filePath}?toolCallId=${edit.toolCallId}`);
      this.onDidChangeEmitter.fire(uri);
    });
  }

  public provideTextDocumentContent(uri: vscode.Uri): string {
    const query = new URLSearchParams(uri.query);
    const toolCallId = query.get('toolCallId');

    if (!toolCallId) {
      return '// No tool call ID provided';
    }

    const staged = this.reviewEngine.getStagedEdit(toolCallId);
    if (!staged) {
      return '// Staged edit not found or already applied';
    }

    if (staged.proposedContent !== undefined) {
      return staged.proposedContent;
    }

    // Otherwise reconstruct from hunks (or accepted hunks)
    const result = applyPartialHunks(staged.baseContent, staged.hunks.map(h => ({ ...h, status: 'accepted' })));
    return result.newContent;
  }
}

