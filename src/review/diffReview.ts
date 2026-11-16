import * as path from 'node:path';
import * as fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import {
  DiffHunk,
  StagedEdit,
  EditApplicationResult,
  UndoHistoryEntry,
} from './types';
import { computeHunks, applyPartialHunks } from './diff';
import { UndoHistoryStack } from './history';
import { WorkspaceRetrieval } from '../context/retrieval';

function getVscode(): any {
  try {
    return require('vscode');
  } catch {
    return null;
  }
}

export class DiffReviewEngine {
  private stagedEdits = new Map<string, StagedEdit>();
  private fileToToolCallId = new Map<string, string>();
  private undoHistory = new UndoHistoryStack();
  private onStagedEditChangeCallbacks: Array<(edit: StagedEdit) => void> = [];

  public getUndoHistory(): UndoHistoryStack {
    return this.undoHistory;
  }

  public onStagedEditChange(cb: (edit: StagedEdit) => void): { dispose: () => void } {
    this.onStagedEditChangeCallbacks.push(cb);
    return {
      dispose: () => {
        const idx = this.onStagedEditChangeCallbacks.indexOf(cb);
        if (idx !== -1) {
          this.onStagedEditChangeCallbacks.splice(idx, 1);
        }
      },
    };
  }

  private notifyChange(edit: StagedEdit): void {
    for (const cb of this.onStagedEditChangeCallbacks) {
      try {
        cb(edit);
      } catch {}
    }
  }

  /**
   * Helper to compute SHA-256 hash of text.
   */
  private hashContent(text: string): string {
    return createHash('sha256').update(text, 'utf-8').digest('hex');
  }

  /**
   * Reads current base content of file from workspace.
   */
  private async readCurrentContent(relativePath: string): Promise<string> {
    const root = WorkspaceRetrieval.getWorkspaceRoot();
    const fullPath = path.resolve(root, relativePath);

    const vscode = getVscode();
    if (vscode?.workspace?.textDocuments) {
      const openDoc = vscode.workspace.textDocuments.find(
        (d: any) => path.resolve(d.fileName) === fullPath
      );
      if (openDoc) {
        return openDoc.getText();
      }
    }

    if (fs.existsSync(fullPath)) {
      return await fs.promises.readFile(fullPath, 'utf-8');
    }

    return '';
  }

  /**
   * Stages a proposed edit in memory. Computes hunks if full content is passed.
   * Handles multiple files in one run and repeated edits to the same file.
   */
  public async stageEdit(
    toolCallId: string,
    filePath: string,
    description: string,
    options: {
      newContent?: string;
      hunks?: Array<{
        old_start?: number;
        old_lines?: number;
        new_start?: number;
        new_lines?: number;
        old_text?: string;
        new_text?: string;
        oldStart?: number;
        oldLines?: number;
        newStart?: number;
        newLines?: number;
        oldText?: string;
        newText?: string;
      }>;
    }
  ): Promise<StagedEdit> {
    const normalizedPath = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
    const baseContent = await this.readCurrentContent(normalizedPath);
    const baseContentHash = this.hashContent(baseContent);

    let hunks: DiffHunk[] = [];

    if (options.newContent !== undefined && typeof options.newContent === 'string' && options.newContent.trim().length > 0) {
      hunks = computeHunks(baseContent, options.newContent);
    } else if (options.hunks && options.hunks.length > 0) {
      const baseLines = baseContent.length === 0 ? [] : baseContent.split(/\r?\n/);
      hunks = options.hunks.map((h: any, idx: number) => {
        const oldStart = Number(h.oldStart ?? h.old_start ?? h.start_line ?? h.startLine ?? h.line ?? 1);
        let oldLines = h.oldLines ?? h.old_lines;
        if (oldLines === undefined && (h.end_line !== undefined || h.endLine !== undefined)) {
          const end = Number(h.end_line ?? h.endLine);
          oldLines = Math.max(0, end - oldStart + 1);
        } else if (oldLines === undefined) {
          oldLines = 0;
        }

        const newText = String(
          h.newText ?? h.new_text ?? h.new_content ?? h.newContent ?? h.replacement ?? h.content ?? ''
        );
        let oldText = h.oldText ?? h.old_text ?? h.original_text ?? '';
        if (!oldText && oldLines > 0 && baseLines.length > 0) {
          oldText = baseLines.slice(oldStart - 1, oldStart - 1 + oldLines).join('\n');
        }

        const newLines = newText.length === 0 ? 0 : newText.split(/\r?\n/).length;

        return {
          id: `hunk-${idx + 1}`,
          oldStart,
          oldLines: Number(oldLines),
          newStart: Number(h.newStart ?? h.new_start ?? oldStart),
          newLines,
          oldText,
          newText,
          status: 'pending',
        };
      });
    } else {
      hunks = [];
    }

    const edit: StagedEdit = {
      toolCallId,
      filePath: normalizedPath,
      description,
      hunks,
      baseContent,
      baseContentHash,
      proposedContent: options.newContent,
      createdAt: Date.now(),
    };

    this.stagedEdits.set(toolCallId, edit);
    this.fileToToolCallId.set(normalizedPath, toolCallId);

    this.notifyChange(edit);
    return edit;
  }

  public getStagedEdit(toolCallId: string): StagedEdit | undefined {
    return this.stagedEdits.get(toolCallId);
  }

  public getStagedEditForFile(filePath: string): StagedEdit | undefined {
    const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
    const toolCallId = this.fileToToolCallId.get(normalized);
    return toolCallId ? this.stagedEdits.get(toolCallId) : undefined;
  }

  public getAllStagedEdits(): StagedEdit[] {
    return Array.from(this.stagedEdits.values());
  }

  public setHunkDecision(
    toolCallId: string,
    hunkId: string,
    decision: 'accepted' | 'rejected'
  ): boolean {
    const edit = this.stagedEdits.get(toolCallId);
    if (!edit) return false;

    const hunk = edit.hunks.find((h) => h.id === hunkId);
    if (!hunk) return false;

    hunk.status = decision;
    this.notifyChange(edit);
    return true;
  }

  public setAllHunksDecision(toolCallId: string, decision: 'accepted' | 'rejected'): boolean {
    const edit = this.stagedEdits.get(toolCallId);
    if (!edit) return false;

    for (const hunk of edit.hunks) {
      hunk.status = decision;
    }
    this.notifyChange(edit);
    return true;
  }

  public clearAllStagedEdits(): void {
    this.stagedEdits.clear();
    this.fileToToolCallId.clear();
  }

  /**
   * Applies accepted hunks for a staged edit.
   * Checks for stale files (modified by user meanwhile) before applying.
   * Records previous content on undo history stack.
   */
  public async applyApprovedEdit(toolCallId: string): Promise<EditApplicationResult> {
    const staged = this.stagedEdits.get(toolCallId);
    if (!staged) {
      throw new Error(`No staged edit found for tool call "${toolCallId}".`);
    }

    const currentContent = await this.readCurrentContent(staged.filePath);
    const currentHash = this.hashContent(currentContent);

    // Stale File Detection: Check if file was modified meanwhile by the user
    if (currentHash !== staged.baseContentHash) {
      return {
        filePath: staged.filePath,
        appliedCount: 0,
        rejectedCount: staged.hunks.length,
        isStale: true,
        summary: `Conflict detected: "${staged.filePath}" was modified by the user after the proposed edit was staged. Changes were not applied.`,
      };
    }

    const accepted = staged.hunks.filter((h) => h.status === 'accepted');
    const rejected = staged.hunks.filter((h) => h.status === 'rejected' || h.status === 'pending');

    if (accepted.length === 0) {
      this.stagedEdits.delete(toolCallId);
      this.fileToToolCallId.delete(staged.filePath);
      return {
        filePath: staged.filePath,
        appliedCount: 0,
        rejectedCount: rejected.length,
        summary: `All ${rejected.length} hunks were rejected. Workspace remains unchanged.`,
      };
    }

    const vscode = getVscode();

    // Inside VS Code extension host: apply via WorkspaceEdit
    if (vscode?.workspace?.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
      const rootUri = vscode.workspace.workspaceFolders[0].uri;
      const fileUri = vscode.Uri.joinPath(rootUri, staged.filePath);
      const doc = await vscode.workspace.openTextDocument(fileUri);

      const workspaceEdit = new vscode.WorkspaceEdit();
      // Apply accepted hunks descending by line
      const sortedHunks = [...accepted].sort((a, b) => b.oldStart - a.oldStart);

      for (const hunk of sortedHunks) {
        const startLine = Math.max(0, hunk.oldStart - 1);
        const endLine = Math.min(doc.lineCount, startLine + Math.max(0, hunk.oldLines));
        const range = new vscode.Range(
          new vscode.Position(startLine, 0),
          new vscode.Position(endLine, 0)
        );

        const replacement = hunk.newText.length === 0 ? '' : (hunk.newText.endsWith('\n') ? hunk.newText : hunk.newText + '\n');
        workspaceEdit.replace(fileUri, range, replacement);
      }

      const success = await vscode.workspace.applyEdit(workspaceEdit);
      if (!success) {
        throw new Error(`Failed to apply WorkspaceEdit to ${staged.filePath}`);
      }

      await doc.save();
    } else {
      // Outside VS Code (tests / standalone execution): apply via partial hunk engine
      const root = WorkspaceRetrieval.getWorkspaceRoot();
      const fullPath = path.resolve(root, staged.filePath);
      const result = applyPartialHunks(staged.baseContent, staged.hunks);
      await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.promises.writeFile(fullPath, result.newContent, 'utf-8');
    }

    // Push previous content to Undo History Stack
    this.undoHistory.push({
      id: randomUUID(),
      filePath: staged.filePath,
      timestamp: Date.now(),
      previousContent: staged.baseContent,
      appliedHunksCount: accepted.length,
    });

    this.stagedEdits.delete(toolCallId);
    this.fileToToolCallId.delete(staged.filePath);

    return {
      filePath: staged.filePath,
      appliedCount: accepted.length,
      rejectedCount: rejected.length,
      summary: `Applied ${accepted.length} hunks (${rejected.length} hunks rejected).`,
    };
  }

  public getUndoHistorySize(): number {
    return this.undoHistory.size();
  }

  /**
   * Reverts the last applied edit from the undo history stack.
   */
  public async undoLastChange(workspaceRoot?: string): Promise<{
    success: boolean;
    message: string;
    filePath?: string;
    appliedHunksCount?: number;
  }> {
    return this.undoHistory.undoLast(workspaceRoot);
  }
}
