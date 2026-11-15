import * as vscode from 'vscode';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { enforceContextBudget } from './budget';

export class WorkspaceRetrieval {
  /**
   * Reads a file from the workspace, optionally within a line range (1-indexed).
   */
  public static async readFile(
    relativePath: string,
    startLine?: number,
    endLine?: number
  ): Promise<string> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      throw new Error('No open workspace folder.');
    }

    const rootUri = workspaceFolders[0].uri;
    const fileUri = vscode.Uri.joinPath(rootUri, relativePath);

    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(fileUri);
    } catch (err: any) {
      throw new Error(`Failed to read file "${relativePath}": ${err.message}`);
    }

    const totalLines = doc.lineCount;
    const s = Math.max(1, startLine ?? 1);
    const e = Math.min(totalLines, endLine ?? totalLines);

    if (s > totalLines) {
      return enforceContextBudget(`File has ${totalLines} lines. Requested start line ${s} is out of bounds.`);
    }

    const lines: string[] = [];
    for (let i = s - 1; i < e; i++) {
      const lineText = doc.lineAt(i).text;
      lines.push(`${i + 1} | ${lineText}`);
    }

    const raw = lines.join('\n');
    return enforceContextBudget(raw, { label: relativePath });
  }

  /**
   * Searches the workspace files for text matches using VS Code findFiles & document scan.
   */
  public static async searchWorkspace(query: string, maxFiles: number = 20): Promise<string> {
    const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**', maxFiles * 2);
    const matches: string[] = [];
    const lowerQuery = query.toLowerCase();

    for (const file of files) {
      if (matches.length >= maxFiles) {
        break;
      }
      try {
        const doc = await vscode.workspace.openTextDocument(file);
        const relative = vscode.workspace.asRelativePath(file);
        for (let i = 0; i < doc.lineCount; i++) {
          const line = doc.lineAt(i).text;
          if (line.toLowerCase().includes(lowerQuery)) {
            matches.push(`${relative}:${i + 1}: ${line.trim()}`);
            if (matches.length >= maxFiles) {
              break;
            }
          }
        }
      } catch {
        // Skip unreadable / binary files
      }
    }

    if (matches.length === 0) {
      return `No matches found for query "${query}".`;
    }

    return enforceContextBudget(matches.join('\n'), { label: `search "${query}"` });
  }

  /**
   * Searches for workspace symbols matching the query.
   */
  public static async findSymbol(query: string): Promise<string> {
    const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
      'vscode.executeWorkspaceSymbolProvider',
      query
    );

    if (!symbols || symbols.length === 0) {
      return `No symbols found matching "${query}".`;
    }

    const formatted = symbols.slice(0, 30).map((sym) => {
      const relPath = vscode.workspace.asRelativePath(sym.location.uri);
      const line = sym.location.range.start.line + 1;
      return `${sym.name} (${vscode.SymbolKind[sym.kind]}) -> ${relPath}:${line}`;
    });

    return enforceContextBudget(formatted.join('\n'), { label: `symbol "${query}"` });
  }

  /**
   * Executes a command via PowerShell on Windows.
   */
  public static async runCommand(
    command: string,
    timeoutMs: number = 30000
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const cwd = workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : process.cwd();

    return new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
        cwd,
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`Command timed out after ${timeoutMs}ms: "${command}"`));
      }, timeoutMs);

      child.stdout.on('data', (d) => {
        stdout += d.toString();
      });

      child.stderr.on('data', (d) => {
        stderr += d.toString();
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          stdout: enforceContextBudget(stdout, { label: 'stdout' }),
          stderr: enforceContextBudget(stderr, { label: 'stderr' }),
          exitCode: code ?? 0,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
}

