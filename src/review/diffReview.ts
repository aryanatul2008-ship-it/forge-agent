import * as vscode from 'vscode';
import { DiffHunk, StagedEdit, EditApplicationResult } from './types';

export class DiffReviewEngine {
  private stagedEdits = new Map<string, StagedEdit>();

  /**
   * Stages a proposed edit in memory for user review. No disk modifications happen here.
   */
  public stageEdit(
    toolCallId: string,
    filePath: string,
    description: string,
    hunks: DiffHunk[]
  ): StagedEdit {
    const edit: StagedEdit = {
      toolCallId,
      filePath,
      description,
      hunks: hunks.map((h, idx) => ({
        ...h,
        id: h.id || `hunk-${idx + 1}`,
        status: h.status || 'pending',
      })),
      createdAt: Date.now(),
    };
    this.stagedEdits.set(toolCallId, edit);
    return edit;
  }

  public getStagedEdit(toolCallId: string): StagedEdit | undefined {
    return this.stagedEdits.get(toolCallId);
  }

  public setHunkDecision(
    toolCallId: string,
    hunkId: string,
    decision: 'accepted' | 'rejected'
  ): boolean {
    const edit = this.stagedEdits.get(toolCallId);
    if (!edit) {
      return false;
    }
    const hunk = edit.hunks.find((h) => h.id === hunkId);
    if (!hunk) {
      return false;
    }
    hunk.status = decision;
    return true;
  }

  public setAllHunksDecision(toolCallId: string, decision: 'accepted' | 'rejected'): boolean {
    const edit = this.stagedEdits.get(toolCallId);
    if (!edit) {
      return false;
    }
    for (const hunk of edit.hunks) {
      hunk.status = decision;
    }
    return true;
  }

  /**
   * Discards all staged edits. Used on cancellation to leave the workspace untouched.
   */
  public clearAllStagedEdits(): void {
    this.stagedEdits.clear();
  }

  /**
   * Applies accepted hunks for a tool call via VS Code WorkspaceEdit.
   * Edits are applied in reverse line order so line shifts don't invalidate subsequent edits.
   */
  public async applyApprovedEdit(toolCallId: string): Promise<EditApplicationResult> {
    const staged = this.stagedEdits.get(toolCallId);
    if (!staged) {
      throw new Error(`No staged edit found for tool call "${toolCallId}".`);
    }

    const accepted = staged.hunks.filter((h) => h.status === 'accepted');
    const rejected = staged.hunks.filter((h) => h.status === 'rejected' || h.status === 'pending');

    if (accepted.length === 0) {
      this.stagedEdits.delete(toolCallId);
      return {
        filePath: staged.filePath,
        appliedCount: 0,
        rejectedCount: rejected.length,
        summary: `User rejected all ${rejected.length} hunks. Workspace remains unchanged.`,
      };
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      throw new Error('No open workspace folder.');
    }

    const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, staged.filePath);
    const doc = await vscode.workspace.openTextDocument(fileUri);

    const workspaceEdit = new vscode.WorkspaceEdit();

    // Sort descending by start line to keep offsets valid
    const sortedHunks = [...accepted].sort((a, b) => b.oldStart - a.oldStart);

    for (const hunk of sortedHunks) {
      const startLine = Math.max(0, hunk.oldStart - 1);
      const endLine = Math.min(doc.lineCount, startLine + Math.max(0, hunk.oldLines));
      const range = new vscode.Range(
        new vscode.Position(startLine, 0),
        new vscode.Position(endLine, 0)
      );

      const replacement = hunk.newText.endsWith('\n') ? hunk.newText : hunk.newText + '\n';
      workspaceEdit.replace(fileUri, range, replacement);
    }

    const success = await vscode.workspace.applyEdit(workspaceEdit);
    if (!success) {
      throw new Error(`Failed to apply WorkspaceEdit to ${staged.filePath}`);
    }

    // Optionally save the document after applying edits
    await doc.save();
    this.stagedEdits.delete(toolCallId);

    return {
      filePath: staged.filePath,
      appliedCount: accepted.length,
      rejectedCount: rejected.length,
      summary: `Successfully applied ${accepted.length} hunks; ${rejected.length} hunks were rejected.`,
    };
  }
}

