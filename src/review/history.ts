import * as path from 'node:path';
import * as fs from 'node:fs';
import { UndoHistoryEntry } from './types';

function getVscode(): any {
  try {
    return require('vscode');
  } catch {
    return null;
  }
}

export class UndoHistoryStack {
  private stack: UndoHistoryEntry[] = [];

  public push(entry: UndoHistoryEntry): void {
    this.stack.push(entry);
  }

  public pop(): UndoHistoryEntry | undefined {
    return this.stack.pop();
  }

  public peek(): UndoHistoryEntry | undefined {
    return this.stack.length > 0 ? this.stack[this.stack.length - 1] : undefined;
  }

  public size(): number {
    return this.stack.length;
  }

  public clear(): void {
    this.stack = [];
  }

  /**
   * Reverts the most recently applied change from the history stack.
   */
  public async undoLast(workspaceRoot?: string): Promise<{
    success: boolean;
    message: string;
    filePath?: string;
    appliedHunksCount?: number;
  }> {
    const entry = this.pop();
    if (!entry) {
      return {
        success: false,
        message: 'No previous agent changes to undo.',
      };
    }

    const vscode = getVscode();
    if (vscode?.workspace?.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
      try {
        const rootUri = vscode.workspace.workspaceFolders[0].uri;
        const fileUri = vscode.Uri.joinPath(rootUri, entry.filePath);
        const doc = await vscode.workspace.openTextDocument(fileUri);

        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
          doc.positionAt(0),
          doc.positionAt(doc.getText().length)
        );

        edit.replace(fileUri, fullRange, entry.previousContent);
        const success = await vscode.workspace.applyEdit(edit);
        if (success) {
          await doc.save();
          return {
            success: true,
            message: `Successfully reverted change to ${entry.filePath} (${entry.appliedHunksCount} hunks undone).`,
            filePath: entry.filePath,
            appliedHunksCount: entry.appliedHunksCount,
          };
        } else {
          // Re-push entry if apply failed
          this.push(entry);
          return {
            success: false,
            message: `Failed to apply undo edit to ${entry.filePath}.`,
          };
        }
      } catch (err: any) {
        this.push(entry);
        return {
          success: false,
          message: `Error reverting ${entry.filePath}: ${err?.message || err}`,
        };
      }
    }

    // Fallback for standalone / testing outside VS Code
    const root = workspaceRoot ?? process.cwd();
    const fullPath = path.resolve(root, entry.filePath);
    try {
      await fs.promises.writeFile(fullPath, entry.previousContent, 'utf-8');
      return {
        success: true,
        message: `Successfully reverted change to ${entry.filePath} (${entry.appliedHunksCount} hunks undone) via disk write.`,
        filePath: entry.filePath,
        appliedHunksCount: entry.appliedHunksCount,
      };
    } catch (err: any) {
      this.push(entry);
      return {
        success: false,
        message: `Error writing reverted content to ${entry.filePath}: ${err?.message || err}`,
      };
    }
  }
}

