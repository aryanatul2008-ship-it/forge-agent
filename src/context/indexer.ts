import * as fs from 'node:fs';
import * as path from 'node:path';
import { BM25Index, tokenizeText, BM25SearchResult } from './bm25';
import { DocumentChunk, SymbolEntry } from './types';

function getVscode(): any {
  try {
    return require('vscode');
  } catch {
    return null;
  }
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

const CHUNK_SIZE_LINES = 35;
const CHUNK_OVERLAP_LINES = 10;
const CHARS_PER_TOKEN = 4;

export class WorkspaceIndexer {
  private workspaceRoot: string = '';
  private bm25Index = new BM25Index();
  private fileChunks = new Map<string, string[]>(); // relativePath -> chunkIds
  private symbols: SymbolEntry[] = [];
  private fileList: string[] = [];
  private isIndexing = false;
  private watcherDisposable?: { dispose: () => void };
  private updateDebounceTimers = new Map<string, NodeJS.Timeout>();

  constructor(workspaceRoot?: string) {
    if (workspaceRoot) {
      this.workspaceRoot = path.resolve(workspaceRoot);
    }
  }

  public setWorkspaceRoot(root: string): void {
    this.workspaceRoot = path.resolve(root);
  }

  public getWorkspaceRoot(): string {
    if (this.workspaceRoot) {
      return this.workspaceRoot;
    }
    const vscode = getVscode();
    if (vscode?.workspace?.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
      return vscode.workspace.workspaceFolders[0].uri.fsPath;
    }
    return process.cwd();
  }

  public getBM25Index(): BM25Index {
    return this.bm25Index;
  }

  public getIndexedFilesCount(): number {
    return this.fileList.length;
  }

  public getIndexedChunksCount(): number {
    return this.bm25Index.totalDocuments;
  }

  public getIndexedSymbolsCount(): number {
    return this.symbols.length;
  }

  /**
   * Initializes and indexes the entire workspace.
   */
  public async initialize(workspaceRoot?: string): Promise<void> {
    if (workspaceRoot) {
      this.workspaceRoot = path.resolve(workspaceRoot);
    }
    const root = this.getWorkspaceRoot();
    this.isIndexing = true;

    this.bm25Index.clear();
    this.fileChunks.clear();
    this.symbols = [];
    this.fileList = [];

    try {
      const allFiles = await this.collectFiles(root, root, [], 800);
      this.fileList = allFiles.map((f) => this.toRelativePath(f, root));

      for (const relPath of this.fileList) {
        try {
          await this.indexFile(relPath);
        } catch (err) {
          // Skip unreadable files
        }
      }

      this.setupFileWatcher();
    } finally {
      this.isIndexing = false;
    }
  }

  /**
   * Indexes or re-indexes a single file.
   */
  public async indexFile(relativePath: string, fileContent?: string): Promise<void> {
    const root = this.getWorkspaceRoot();
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    const fullPath = path.resolve(root, normalized);

    // Remove old chunks for this file
    const oldChunkIds = this.fileChunks.get(normalized);
    if (oldChunkIds) {
      for (const id of oldChunkIds) {
        this.bm25Index.removeChunk(id);
      }
      this.fileChunks.delete(normalized);
    }

    // Remove old symbols for this file
    this.symbols = this.symbols.filter((s) => s.filePath !== normalized);

    let content = fileContent;
    if (content === undefined) {
      if (!fs.existsSync(fullPath)) return;
      try {
        content = await fs.promises.readFile(fullPath, 'utf-8');
      } catch {
        return;
      }
    }

    if (!this.fileList.includes(normalized)) {
      this.fileList.push(normalized);
    }

    // 1. Chunk the file and add to BM25
    const chunks = this.chunkFile(normalized, content);
    const chunkIds: string[] = [];
    for (const chunk of chunks) {
      chunkIds.push(chunk.id);
      this.bm25Index.addChunk(chunk);
    }
    this.fileChunks.set(normalized, chunkIds);

    // 2. Extract symbols
    const fileSymbols = this.extractSymbols(normalized, content);
    this.symbols.push(...fileSymbols);
  }

  /**
   * Removes a file and its indexed chunks/symbols.
   */
  public removeFile(relativePath: string): void {
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    const oldChunkIds = this.fileChunks.get(normalized);
    if (oldChunkIds) {
      for (const id of oldChunkIds) {
        this.bm25Index.removeChunk(id);
      }
      this.fileChunks.delete(normalized);
    }
    this.symbols = this.symbols.filter((s) => s.filePath !== normalized);
    this.fileList = this.fileList.filter((f) => f !== normalized);
  }

  /**
   * Splits file content into overlapping windows of code chunks.
   */
  private chunkFile(relativePath: string, content: string): DocumentChunk[] {
    const lines = content.split(/\r?\n/);
    const totalLines = lines.length;
    if (totalLines === 0) return [];

    const chunks: DocumentChunk[] = [];

    // If file is very small (< 45 lines), create one single chunk
    if (totalLines <= CHUNK_SIZE_LINES + 10) {
      const chunkText = lines.join('\n');
      const terms = tokenizeText(chunkText);
      const tfMap = new Map<string, number>();
      for (const t of terms) {
        tfMap.set(t, (tfMap.get(t) || 0) + 1);
      }

      chunks.push({
        id: `${relativePath}#L1-L${totalLines}`,
        filePath: relativePath,
        startLine: 1,
        endLine: totalLines,
        content: chunkText,
        tokensCount: Math.ceil(chunkText.length / CHARS_PER_TOKEN),
        termFrequencies: tfMap,
        totalTerms: terms.length,
      });

      return chunks;
    }

    let start = 0;
    let chunkIndex = 1;

    while (start < totalLines) {
      const end = Math.min(start + CHUNK_SIZE_LINES, totalLines);
      const chunkLines = lines.slice(start, end);
      const chunkText = chunkLines.join('\n');
      const terms = tokenizeText(chunkText);
      const tfMap = new Map<string, number>();
      for (const t of terms) {
        tfMap.set(t, (tfMap.get(t) || 0) + 1);
      }

      chunks.push({
        id: `${relativePath}#L${start + 1}-L${end}`,
        filePath: relativePath,
        startLine: start + 1,
        endLine: end,
        content: chunkText,
        tokensCount: Math.ceil(chunkText.length / CHARS_PER_TOKEN),
        termFrequencies: tfMap,
        totalTerms: terms.length,
      });

      if (end >= totalLines) break;
      start += CHUNK_SIZE_LINES - CHUNK_OVERLAP_LINES;
      chunkIndex++;
    }

    return chunks;
  }

  /**
   * Lightweight extraction of symbols using regex patterns.
   */
  private extractSymbols(relativePath: string, content: string): SymbolEntry[] {
    const symbols: SymbolEntry[] = [];
    const lines = content.split(/\r?\n/);
    const ext = path.extname(relativePath).toLowerCase();

    // Python definitions
    if (ext === '.py') {
      const funcRegex = /^[ \t]*(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(/;
      const classRegex = /^[ \t]*class\s+([A-Za-z0-9_]+)(?:\s*\(|:)/;
      const assignRegex = /^([A-Za-z0-9_]{3,})\s*=\s*(?:click\.|FlaskGroup|Blueprint|[A-Z])/;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let match = line.match(funcRegex);
        if (match) {
          symbols.push({
            name: match[1],
            kind: 'function',
            filePath: relativePath,
            line: i + 1,
            snippet: line.trim(),
          });
          continue;
        }

        match = line.match(classRegex);
        if (match) {
          symbols.push({
            name: match[1],
            kind: 'class',
            filePath: relativePath,
            line: i + 1,
            snippet: line.trim(),
          });
          continue;
        }

        match = line.match(assignRegex);
        if (match) {
          symbols.push({
            name: match[1],
            kind: 'variable',
            filePath: relativePath,
            line: i + 1,
            snippet: line.trim(),
          });
        }
      }
    } else if (ext === '.ts' || ext === '.js' || ext === '.tsx' || ext === '.jsx') {
      // TypeScript / JavaScript definitions
      const funcRegex = /^[ \t]*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/;
      const classRegex = /^[ \t]*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/;
      const ifaceRegex = /^[ \t]*(?:export\s+)?interface\s+([A-Za-z0-9_$]+)/;
      const typeRegex = /^[ \t]*(?:export\s+)?type\s+([A-Za-z0-9_$]+)\s*=/;
      const constRegex = /^[ \t]*(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:function|\(.*?\)\s*=>)/;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let match = line.match(funcRegex) || line.match(constRegex);
        if (match) {
          symbols.push({
            name: match[1],
            kind: 'function',
            filePath: relativePath,
            line: i + 1,
            snippet: line.trim(),
          });
          continue;
        }

        match = line.match(classRegex);
        if (match) {
          symbols.push({
            name: match[1],
            kind: 'class',
            filePath: relativePath,
            line: i + 1,
            snippet: line.trim(),
          });
          continue;
        }

        match = line.match(ifaceRegex) || line.match(typeRegex);
        if (match) {
          symbols.push({
            name: match[1],
            kind: 'type',
            filePath: relativePath,
            line: i + 1,
            snippet: line.trim(),
          });
        }
      }
    }

    return symbols;
  }

  /**
   * Sets up file watching for incremental refresh.
   */
  private setupFileWatcher(): void {
    if (this.watcherDisposable) {
      this.watcherDisposable.dispose();
    }

    const vscode = getVscode();
    if (vscode?.workspace?.createFileSystemWatcher) {
      const watcher = vscode.workspace.createFileSystemWatcher('**/*');

      const queueUpdate = (uri: any, isDelete = false) => {
        const root = this.getWorkspaceRoot();
        const relPath = this.toRelativePath(uri.fsPath, root);
        if (this.shouldIgnore(relPath)) return;

        const existing = this.updateDebounceTimers.get(relPath);
        if (existing) clearTimeout(existing);

        const timer = setTimeout(async () => {
          this.updateDebounceTimers.delete(relPath);
          if (isDelete) {
            this.removeFile(relPath);
          } else {
            await this.indexFile(relPath);
          }
        }, 300);

        this.updateDebounceTimers.set(relPath, timer);
      };

      watcher.onDidChange((uri: any) => queueUpdate(uri));
      watcher.onDidCreate((uri: any) => queueUpdate(uri));
      watcher.onDidDelete((uri: any) => queueUpdate(uri, true));

      this.watcherDisposable = watcher;
    }
  }

  /**
   * Searches BM25 index over chunks.
   */
  public searchBM25(query: string, maxResults: number = 10): BM25SearchResult[] {
    return this.bm25Index.search(query, maxResults);
  }

  /**
   * Searches indexed symbols by prefix or substring match.
   */
  public searchSymbols(query: string, limit: number = 20): SymbolEntry[] {
    const q = query.toLowerCase().trim();
    if (!q) return this.symbols.slice(0, limit);

    const scored: Array<{ symbol: SymbolEntry; score: number }> = [];

    for (const sym of this.symbols) {
      const nameLower = sym.name.toLowerCase();
      let score = 0;

      if (nameLower === q) {
        score = 100;
      } else if (nameLower.startsWith(q)) {
        score = 80;
      } else if (nameLower.includes(q)) {
        score = 50;
      }

      if (score > 0) {
        scored.push({ symbol: sym, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.symbol);
  }

  /**
   * Matches workspace files for mention autocomplete.
   */
  public matchFiles(query: string, limit: number = 20): string[] {
    const q = query.toLowerCase().trim().replace(/^\/+/, '');
    if (!q) return this.fileList.slice(0, limit);

    const scored: Array<{ file: string; score: number }> = [];

    for (const file of this.fileList) {
      const lower = file.toLowerCase();
      const base = path.basename(file).toLowerCase();
      let score = 0;

      if (base === q) {
        score = 100;
      } else if (base.startsWith(q)) {
        score = 80;
      } else if (lower.includes(q)) {
        score = 50;
      }

      if (score > 0) {
        scored.push({ file, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.file);
  }

  /**
   * Returns complete indexed file tree list.
   */
  public getFileTree(): string[] {
    return [...this.fileList];
  }

  private shouldIgnore(relativePath: string): boolean {
    const parts = relativePath.replace(/\\/g, '/').split('/');
    for (const p of parts) {
      if (IGNORED_DIRS.has(p) || p.endsWith('.egg-info')) return true;
    }
    const ext = path.extname(relativePath).toLowerCase();
    return IGNORED_EXTENSIONS.has(ext);
  }

  private toRelativePath(fullPath: string, root: string): string {
    const rel = path.relative(root, fullPath);
    return rel.replace(/\\/g, '/');
  }

  private async collectFiles(
    dir: string,
    root: string,
    fileList: string[] = [],
    maxFiles: number = 800
  ): Promise<string[]> {
    if (fileList.length >= maxFiles) return fileList;

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return fileList;
    }

    for (const entry of entries) {
      if (fileList.length >= maxFiles) break;

      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name) && !entry.name.endsWith('.egg-info')) {
          await this.collectFiles(path.join(dir, entry.name), root, fileList, maxFiles);
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

  public dispose(): void {
    if (this.watcherDisposable) {
      this.watcherDisposable.dispose();
    }
    for (const timer of this.updateDebounceTimers.values()) {
      clearTimeout(timer);
    }
    this.updateDebounceTimers.clear();
  }
}
