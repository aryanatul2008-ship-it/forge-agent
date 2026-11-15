import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { enforceContextBudget } from './budget';

interface SymbolMatch {
  name: string;
  kind: string;
  relativePath: string;
  line: number;
  snippet: string;
  score: number;
}

interface SearchMatch {
  relativePath: string;
  line: number;
  snippet: string;
  score: number;
}

const IGNORED_DIRS = new Set([
  '.git',
  '.venv',
  'venv',
  'node_modules',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.tox',
  '.eggs',
  'dist',
  'build',
  '.vscode',
  '.idea',
]);

const IGNORED_EXTENSIONS = new Set([
  '.pyc',
  '.pyo',
  '.pyd',
  '.so',
  '.dll',
  '.exe',
  '.bin',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.pdf',
  '.zip',
  '.tar',
  '.gz',
  '.whl',
  '.lock',
]);

export class WorkspaceRetrieval {
  private static customWorkspaceRoot: string | null = null;

  /**
   * Override workspace root (used by tests or CLI).
   */
  public static setWorkspaceRoot(rootPath: string): void {
    WorkspaceRetrieval.customWorkspaceRoot = path.resolve(rootPath);
  }

  /**
   * Resolves the current workspace root directory.
   */
  public static getWorkspaceRoot(): string {
    if (WorkspaceRetrieval.customWorkspaceRoot) {
      return WorkspaceRetrieval.customWorkspaceRoot;
    }

    try {
      // Check VS Code workspace folders if running in extension host
      const vscode = require('vscode');
      if (vscode?.workspace?.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        return vscode.workspace.workspaceFolders[0].uri.fsPath;
      }
    } catch {
      // Running outside VS Code
    }

    return process.cwd();
  }

  /**
   * Normalizes path relative to workspace root with forward slashes.
   */
  private static toRelativePath(fullPath: string, root: string): string {
    const rel = path.relative(root, fullPath);
    return rel.replace(/\\/g, '/');
  }

  /**
   * Helper to recursively scan directory files, respecting ignore list.
   */
  private static async collectFiles(
    dir: string,
    root: string,
    fileList: string[] = [],
    maxFiles: number = 1000
  ): Promise<string[]> {
    if (fileList.length >= maxFiles) {
      return fileList;
    }

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return fileList;
    }

    for (const entry of entries) {
      if (fileList.length >= maxFiles) {
        break;
      }

      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name) && !entry.name.endsWith('.egg-info')) {
          await WorkspaceRetrieval.collectFiles(path.join(dir, entry.name), root, fileList, maxFiles);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!IGNORED_EXTENSIONS.has(ext)) {
          fileList.push(path.join(dir, entry.name));
        }
      }
    }

    return fileList;
  }

  /**
   * Lists directory contents up to a maximum recursion depth.
   */
  public static async listDir(relativePath: string = '.', maxDepth: number = 1): Promise<string> {
    const root = WorkspaceRetrieval.getWorkspaceRoot();
    const targetDir = path.resolve(root, relativePath.trim() || '.');

    // Security check: ensure target is inside workspace
    if (!targetDir.startsWith(root)) {
      throw new Error(`Access denied: "${relativePath}" is outside the workspace root.`);
    }

    if (!fs.existsSync(targetDir)) {
      throw new Error(`Directory not found: "${relativePath}"`);
    }

    const stat = await fs.promises.stat(targetDir);
    if (!stat.isDirectory()) {
      throw new Error(`Path is not a directory: "${relativePath}"`);
    }

    const depth = Math.min(Math.max(1, maxDepth), 3);
    const lines: string[] = [`Directory listing for "${WorkspaceRetrieval.toRelativePath(targetDir, root) || '.'}" (depth: ${depth}):`];

    let dirCount = 0;
    let fileCount = 0;

    const walk = async (currentDir: string, currentDepth: number, prefix: string) => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
      } catch (err: any) {
        lines.push(`${prefix}[ERROR reading directory: ${err.message}]`);
        return;
      }

      // Sort directories first, then alphabetical
      entries.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

      for (const entry of entries) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.endsWith('.egg-info')) {
          continue;
        }

        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          dirCount++;
          lines.push(`${prefix}[DIR]  ${entry.name}/`);
          if (currentDepth < depth) {
            await walk(fullPath, currentDepth + 1, `${prefix}  `);
          }
        } else if (entry.isFile()) {
          fileCount++;
          let sizeStr = '';
          try {
            const fileStat = await fs.promises.stat(fullPath);
            sizeStr = ` (${(fileStat.size / 1024).toFixed(1)} KB)`;
          } catch {}
          lines.push(`${prefix}[FILE] ${entry.name}${sizeStr}`);
        }
      }
    };

    await walk(targetDir, 1, '  ');
    lines.push(`\nTotal: ${dirCount} directories, ${fileCount} files`);

    return enforceContextBudget(lines.join('\n'), { label: `list_dir "${relativePath}"` });
  }

  /**
   * Reads a file from the workspace, optionally within a 1-indexed line range.
   */
  public static async readFile(
    relativePath: string,
    startLine?: number,
    endLine?: number
  ): Promise<string> {
    const root = WorkspaceRetrieval.getWorkspaceRoot();
    const fullPath = path.resolve(root, relativePath.trim());

    if (!fullPath.startsWith(root)) {
      throw new Error(`Access denied: "${relativePath}" is outside the workspace root.`);
    }

    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: "${relativePath}"`);
    }

    let content: string;
    // Check if open in VS Code document buffer first
    try {
      const vscode = require('vscode');
      const openDoc = vscode?.workspace?.textDocuments?.find(
        (doc: any) => path.resolve(doc.fileName) === fullPath
      );
      if (openDoc) {
        content = openDoc.getText();
      } else {
        content = await fs.promises.readFile(fullPath, 'utf-8');
      }
    } catch {
      content = await fs.promises.readFile(fullPath, 'utf-8');
    }

    const allLines = content.split(/\r?\n/);
    const totalLines = allLines.length;

    if (totalLines === 0) {
      return `File: ${WorkspaceRetrieval.toRelativePath(fullPath, root)} (empty file)`;
    }

    const s = Math.max(1, startLine ?? 1);
    const e = Math.min(totalLines, endLine ?? totalLines);

    if (s > totalLines) {
      return enforceContextBudget(
        `File: ${WorkspaceRetrieval.toRelativePath(fullPath, root)} has ${totalLines} lines. Requested start_line ${s} exceeds total line count.`
      );
    }

    const formattedLines: string[] = [
      `File: ${WorkspaceRetrieval.toRelativePath(fullPath, root)} (lines ${s}-${e} of ${totalLines})`,
    ];

    for (let i = s - 1; i < e; i++) {
      const lineNum = String(i + 1).padStart(4, ' ');
      formattedLines.push(`${lineNum} | ${allLines[i]}`);
    }

    return enforceContextBudget(formattedLines.join('\n'), { label: relativePath });
  }

  /**
   * Searches workspace files for text or regex matches.
   * Returns ranked snippets with file path, line number, and context.
   */
  public static async searchWorkspace(
    query: string,
    options?: {
      isRegex?: boolean;
      maxResults?: number;
      filePattern?: string;
    }
  ): Promise<string> {
    const root = WorkspaceRetrieval.getWorkspaceRoot();
    const q = query?.trim() ?? '';
    if (!q) {
      return 'Search query cannot be empty.';
    }

    const isRegex = Boolean(options?.isRegex);
    const maxResults = Math.min(Math.max(1, options?.maxResults ?? 25), 50);
    const filePattern = options?.filePattern?.trim().toLowerCase();

    let regex: RegExp;
    if (isRegex) {
      try {
        regex = new RegExp(q, 'gi');
      } catch (err: any) {
        return `Invalid regular expression "${q}": ${err.message}`;
      }
    } else {
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      regex = new RegExp(escaped, 'gi');
    }

    const allFiles = await WorkspaceRetrieval.collectFiles(root, root, [], 800);
    const matches: SearchMatch[] = [];

    for (const filePath of allFiles) {
      const relPath = WorkspaceRetrieval.toRelativePath(filePath, root);
      if (filePattern && !relPath.toLowerCase().includes(filePattern)) {
        continue;
      }

      let content: string;
      try {
        content = await fs.promises.readFile(filePath, 'utf-8');
      } catch {
        continue; // Skip unreadable / binary files
      }

      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (regex.test(line)) {
          // Reset regex index for global regexes
          regex.lastIndex = 0;

          // Ranking score
          let score = 10;
          const trimmed = line.trim();

          // High priority: definition lines
          if (/^(?:def|class|function|export|const|let|var)\s+/i.test(trimmed)) {
            score += 50;
          }
          // Exact word boundary match
          const wordBoundary = new RegExp(`\\b${isRegex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
          if (wordBoundary.test(trimmed)) {
            score += 30;
          }
          // Matching filename
          if (relPath.toLowerCase().includes(q.toLowerCase())) {
            score += 20;
          }

          // Build surrounding context snippet (1 line before, match, 1 line after)
          const contextSnippet: string[] = [];
          if (i > 0) {
            contextSnippet.push(`  ${String(i).padStart(4, ' ')} | ${lines[i - 1]}`);
          }
          contextSnippet.push(`> ${String(i + 1).padStart(4, ' ')} | ${line}`);
          if (i + 1 < lines.length) {
            contextSnippet.push(`  ${String(i + 2).padStart(4, ' ')} | ${lines[i + 1]}`);
          }

          matches.push({
            relativePath: relPath,
            line: i + 1,
            snippet: contextSnippet.join('\n'),
            score,
          });

          if (matches.length >= maxResults * 3) {
            break;
          }
        }
      }

      if (matches.length >= maxResults * 3) {
        break;
      }
    }

    if (matches.length === 0) {
      return `No matches found for query "${q}".`;
    }

    // Sort by ranking score descending
    matches.sort((a, b) => b.score - a.score);
    const topMatches = matches.slice(0, maxResults);

    const output: string[] = [
      `Found ${matches.length} matches for "${q}" (showing top ${topMatches.length} ranked results):\n`,
    ];

    for (const m of topMatches) {
      output.push(`${m.relativePath}:${m.line} (Score: ${m.score})`);
      output.push(m.snippet);
      output.push('');
    }

    return enforceContextBudget(output.join('\n'), { label: `search "${q}"` });
  }

  /**
   * Searches for symbol definitions in workspace.
   * Uses VS Code executeWorkspaceSymbolProvider if available, with a fast Python regex fallback.
   */
  public static async findSymbol(query: string): Promise<string> {
    const root = WorkspaceRetrieval.getWorkspaceRoot();
    const q = query?.trim() ?? '';
    if (!q) {
      return 'Symbol query cannot be empty.';
    }

    const matches: SymbolMatch[] = [];

    // 1. Try VS Code executeWorkspaceSymbolProvider first if running inside VS Code
    try {
      const vscode = require('vscode');
      if (vscode?.commands?.executeCommand) {
        const symbols = (await vscode.commands.executeCommand(
          'vscode.executeWorkspaceSymbolProvider',
          q
        )) as any[];
        if (symbols && symbols.length > 0) {
          for (const sym of symbols) {
            const relPath = WorkspaceRetrieval.toRelativePath(sym.location.uri.fsPath, root);
            const line = sym.location.range.start.line + 1;
            const kindName = vscode.SymbolKind[sym.kind] || 'Symbol';
            const isExact = sym.name.toLowerCase() === q.toLowerCase();
            matches.push({
              name: sym.name,
              kind: kindName,
              relativePath: relPath,
              line,
              snippet: `${sym.name} (${kindName})`,
              score: isExact ? 100 : 50,
            });
          }
        }
      }
    } catch {
      // Not inside VS Code extension host or command not registered
    }

    // 2. Python Text/Regex Fallback (and when VS Code returns 0 results or is unindexed)
    if (matches.length === 0) {
      const allFiles = await WorkspaceRetrieval.collectFiles(root, root, [], 800);
      const pythonFiles = allFiles.filter((f) => f.endsWith('.py'));

      // Patterns for Python definitions
      // def func_name(...)
      const defRegex = /^[ \t]*(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(/;
      // class ClassName(...)
      const classRegex = /^[ \t]*class\s+([A-Za-z0-9_]+)(?:\s*\(|:)/;
      // VAR = ...
      const assignRegex = /^[ \t]*([A-Za-z0-9_]+)\s*=/;

      const lowerQ = q.toLowerCase();

      for (const filePath of pythonFiles) {
        const relPath = WorkspaceRetrieval.toRelativePath(filePath, root);
        let content: string;
        try {
          content = await fs.promises.readFile(filePath, 'utf-8');
        } catch {
          continue;
        }

        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          let symName: string | null = null;
          let kind = 'Symbol';

          const defMatch = line.match(defRegex);
          if (defMatch) {
            symName = defMatch[1];
            kind = 'Function';
          } else {
            const classMatch = line.match(classRegex);
            if (classMatch) {
              symName = classMatch[1];
              kind = 'Class';
            } else {
              const assignMatch = line.match(assignRegex);
              if (assignMatch && assignMatch[1].toLowerCase() === lowerQ) {
                symName = assignMatch[1];
                kind = 'Variable';
              }
            }
          }

          if (symName) {
            const lowerSym = symName.toLowerCase();
            if (lowerSym.includes(lowerQ)) {
              let score = 20;
              if (lowerSym === lowerQ) {
                score = 100; // Exact match
              } else if (lowerSym.startsWith(lowerQ)) {
                score = 60;
              }

              matches.push({
                name: symName,
                kind,
                relativePath: relPath,
                line: i + 1,
                snippet: line.trim(),
                score,
              });
            }
          }
        }
      }
    }

    if (matches.length === 0) {
      return `No symbols found matching "${q}".`;
    }

    // Sort by score descending, then by file/line
    matches.sort((a, b) => b.score - a.score);
    const topMatches = matches.slice(0, 30);

    const output: string[] = [`Found ${matches.length} symbol definitions matching "${q}":\n`];
    for (const m of topMatches) {
      output.push(`[${m.kind}] ${m.name} -> ${m.relativePath}:${m.line}`);
      output.push(`  Definition: ${m.snippet}`);
    }

    return enforceContextBudget(output.join('\n'), { label: `find_symbol "${q}"` });
  }

  /**
   * Executes a command via PowerShell on Windows.
   */
  public static async runCommand(
    command: string,
    timeoutMs: number = 30000
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const cwd = WorkspaceRetrieval.getWorkspaceRoot();

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
