import * as fs from 'node:fs';
import * as path from 'node:path';
import { WorkspaceIndexer } from './indexer';
import {
  ContextSnippet,
  ContextResult,
  ContextBudgetConfig,
  MentionItem,
  MentionRef,
} from './types';
import { CHARS_PER_TOKEN, MAX_CONTEXT_TOKENS } from './budget';

export class ContextEngine {
  private indexer: WorkspaceIndexer;
  private budgetConfig: ContextBudgetConfig;

  constructor(
    indexer?: WorkspaceIndexer,
    budgetConfig: Partial<ContextBudgetConfig> = {}
  ) {
    this.indexer = indexer ?? new WorkspaceIndexer();
    this.budgetConfig = {
      maxTokens: budgetConfig.maxTokens ?? 6000,
      charsPerToken: budgetConfig.charsPerToken ?? CHARS_PER_TOKEN,
    };
  }

  public getIndexer(): WorkspaceIndexer {
    return this.indexer;
  }

  public setBudgetTokens(tokens: number): void {
    this.budgetConfig.maxTokens = Math.max(500, tokens);
  }

  public getBudgetTokens(): number {
    return this.budgetConfig.maxTokens;
  }

  /**
   * Parses @file and @symbol mentions from a user prompt.
   */
  public parseMentions(prompt: string): { cleanPrompt: string; mentions: MentionRef[] } {
    const mentions: MentionRef[] = [];
    const seen = new Set<string>();

    // Pattern 1: @file:path/to/file or @file:filename
    const fileExplicitRegex = /@file:([^\s]+)/g;
    let match: RegExpExecArray | null;
    while ((match = fileExplicitRegex.exec(prompt)) !== null) {
      const target = match[1].trim();
      const key = `file:${target}`;
      if (!seen.has(key)) {
        seen.add(key);
        mentions.push({ type: 'file', target, raw: match[0] });
      }
    }

    // Pattern 2: @symbol:symbolName
    const symbolExplicitRegex = /@symbol:([^\s]+)/g;
    while ((match = symbolExplicitRegex.exec(prompt)) !== null) {
      const target = match[1].trim();
      const key = `symbol:${target}`;
      if (!seen.has(key)) {
        seen.add(key);
        mentions.push({ type: 'symbol', target, raw: match[0] });
      }
    }

    // Pattern 3: @filename or @symbolName (bare @ mention)
    const bareRegex = /@([A-Za-z0-9_./\\-]+)/g;
    while ((match = bareRegex.exec(prompt)) !== null) {
      const candidate = match[1].trim();
      if (candidate.startsWith('file:') || candidate.startsWith('symbol:')) {
        continue;
      }

      // Check if candidate matches a known file
      const matchingFiles = this.indexer.matchFiles(candidate, 1);
      if (matchingFiles.length > 0 && (candidate.includes('.') || candidate.includes('/') || matchingFiles[0].endsWith(candidate))) {
        const key = `file:${matchingFiles[0]}`;
        if (!seen.has(key)) {
          seen.add(key);
          mentions.push({ type: 'file', target: matchingFiles[0], raw: match[0] });
        }
        continue;
      }

      // Check if candidate matches a known symbol
      const matchingSymbols = this.indexer.searchSymbols(candidate, 1);
      if (matchingSymbols.length > 0 && matchingSymbols[0].name.toLowerCase() === candidate.toLowerCase()) {
        const key = `symbol:${matchingSymbols[0].name}`;
        if (!seen.has(key)) {
          seen.add(key);
          mentions.push({ type: 'symbol', target: matchingSymbols[0].name, raw: match[0] });
        }
      }
    }

    return { cleanPrompt: prompt, mentions };
  }

  /**
   * Autocomplete suggestions for @ mentions in the chat input.
   */
  public getMentionSuggestions(query: string, type: 'file' | 'symbol' | 'all' = 'all'): MentionItem[] {
    const cleanQ = query.replace(/^@/, '').trim();
    const suggestions: MentionItem[] = [];

    // Check if query starts with "file:" or "symbol:"
    let effectiveType = type;
    let effectiveQuery = cleanQ;

    if (cleanQ.startsWith('file:')) {
      effectiveType = 'file';
      effectiveQuery = cleanQ.slice(5).trim();
    } else if (cleanQ.startsWith('symbol:')) {
      effectiveType = 'symbol';
      effectiveQuery = cleanQ.slice(7).trim();
    }

    if (effectiveType === 'file' || effectiveType === 'all') {
      const matchedFiles = this.indexer.matchFiles(effectiveQuery, 10);
      for (const f of matchedFiles) {
        suggestions.push({
          label: f,
          detail: `File (${path.extname(f) || 'file'})`,
          type: 'file',
          value: `@file:${f}`,
          filePath: f,
        });
      }
    }

    if (effectiveType === 'symbol' || effectiveType === 'all') {
      const matchedSymbols = this.indexer.searchSymbols(effectiveQuery, 10);
      for (const s of matchedSymbols) {
        suggestions.push({
          label: s.name,
          detail: `${s.kind} in ${s.filePath}:${s.line}`,
          type: 'symbol',
          value: `@symbol:${s.name}`,
          filePath: s.filePath,
          line: s.line,
        });
      }
    }

    return suggestions;
  }

  /**
   * Resolves explicit @ mentions into bounded ContextSnippets.
   */
  public async resolveMentions(mentions: MentionRef[]): Promise<ContextSnippet[]> {
    const root = this.indexer.getWorkspaceRoot();
    const snippets: ContextSnippet[] = [];

    for (const m of mentions) {
      if (m.type === 'file') {
        const matching = this.indexer.matchFiles(m.target, 1);
        const relPath = matching.length > 0 ? matching[0] : m.target;
        const fullPath = path.resolve(root, relPath);

        if (fs.existsSync(fullPath)) {
          try {
            const content = await fs.promises.readFile(fullPath, 'utf-8');
            const lines = content.split(/\r?\n/);
            const totalLines = lines.length;

            // Bounded: include up to 60 lines max for an explicit file mention
            const maxLines = Math.min(60, totalLines);
            const snippetContent = lines.slice(0, maxLines).join('\n');
            const tokens = Math.ceil(snippetContent.length / this.budgetConfig.charsPerToken);

            snippets.push({
              id: `mention:${relPath}#L1-L${maxLines}`,
              filePath: relPath,
              startLine: 1,
              endLine: maxLines,
              content: snippetContent,
              score: 1000, // Highest priority
              reason: `Explicit mention @file:${relPath} (lines 1-${maxLines}${totalLines > maxLines ? ` of ${totalLines}` : ''})`,
              tokens,
              source: 'mention',
            });
          } catch {}
        }
      } else if (m.type === 'symbol') {
        const symbols = this.indexer.searchSymbols(m.target, 3);
        const matched = symbols.find((s) => s.name.toLowerCase() === m.target.toLowerCase()) || symbols[0];

        if (matched) {
          const fullPath = path.resolve(root, matched.filePath);
          if (fs.existsSync(fullPath)) {
            try {
              const content = await fs.promises.readFile(fullPath, 'utf-8');
              const lines = content.split(/\r?\n/);
              // Extract window around symbol definition: 3 lines before, 30 lines after
              const startLine = Math.max(1, matched.line - 3);
              const endLine = Math.min(lines.length, matched.line + 30);
              const snippetContent = lines.slice(startLine - 1, endLine).join('\n');
              const tokens = Math.ceil(snippetContent.length / this.budgetConfig.charsPerToken);

              snippets.push({
                id: `mention:symbol:${matched.name}#L${startLine}-L${endLine}`,
                filePath: matched.filePath,
                startLine,
                endLine,
                content: snippetContent,
                score: 950,
                reason: `Explicit mention @symbol:${matched.name} (${matched.kind} in ${matched.filePath}:${matched.line})`,
                tokens,
                source: 'symbol',
              });
            } catch {}
          }
        }
      }
    }

    return snippets;
  }

  /**
   * Retrieves bounded, ranked workspace context using mentions, symbol matching,
   * and BM25 search over chunks, strictly enforced against the token budget.
   */
  public async retrieveRelevantContext(
    query: string,
    options: { maxTokens?: number } = {}
  ): Promise<ContextResult> {
    const budgetTokens = options.maxTokens ?? this.budgetConfig.maxTokens;
    const maxChars = budgetTokens * this.budgetConfig.charsPerToken;

    // 1. Parse and resolve explicit mentions
    const { cleanPrompt, mentions } = this.parseMentions(query);
    const mentionSnippets = await this.resolveMentions(mentions);

    // 2. Search BM25 chunks
    const bm25Results = this.indexer.searchBM25(cleanPrompt, 15);
    const candidateSnippets: ContextSnippet[] = [...mentionSnippets];

    // 3. Search matching symbols for key query terms
    const symbolMatches = this.indexer.searchSymbols(cleanPrompt, 5);
    const root = this.indexer.getWorkspaceRoot();

    for (const sym of symbolMatches) {
      const fullPath = path.resolve(root, sym.filePath);
      if (fs.existsSync(fullPath)) {
        try {
          const content = await fs.promises.readFile(fullPath, 'utf-8');
          const lines = content.split(/\r?\n/);
          const startLine = Math.max(1, sym.line - 2);
          const endLine = Math.min(lines.length, sym.line + 25);
          const snippetContent = lines.slice(startLine - 1, endLine).join('\n');
          const tokens = Math.ceil(snippetContent.length / this.budgetConfig.charsPerToken);

          candidateSnippets.push({
            id: `symbol:${sym.filePath}#L${startLine}-L${endLine}`,
            filePath: sym.filePath,
            startLine,
            endLine,
            content: snippetContent,
            score: 150,
            reason: `Matches symbol definition "${sym.name}" (${sym.kind} in ${sym.filePath}:${sym.line})`,
            tokens,
            source: 'symbol',
          });
        } catch {}
      }
    }

    // 4. Convert BM25 chunks to Candidate Snippets
    for (const res of bm25Results) {
      const chunk = res.chunk;
      const termsSummary = res.matchedTerms.slice(0, 4).join(', ');
      candidateSnippets.push({
        id: chunk.id,
        filePath: chunk.filePath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        content: chunk.content,
        score: res.score,
        reason: `BM25 match (Score: ${res.score.toFixed(2)}, terms: ${termsSummary})`,
        tokens: chunk.tokensCount,
        source: 'bm25',
      });
    }

    // 5. Ranking: Mentions first, then symbols, then BM25 score descending
    candidateSnippets.sort((a, b) => b.score - a.score);

    // 6. Deduplication and Overlap Merging
    const dedupedSnippets = this.deduplicateAndMergeSnippets(candidateSnippets);

    // 7. Strict Token Budget Accumulation (Never whole-file concatenation!)
    const chosenSnippets: ContextSnippet[] = [];
    let currentTokens = 0;
    let currentChars = 0;

    for (const snippet of dedupedSnippets) {
      const snippetTokens = Math.ceil(snippet.content.length / this.budgetConfig.charsPerToken);

      if (currentTokens + snippetTokens <= budgetTokens) {
        chosenSnippets.push(snippet);
        currentTokens += snippetTokens;
        currentChars += snippet.content.length;
      } else {
        // Can we partially fit a truncated slice of this snippet into the remaining budget?
        const remainingTokens = budgetTokens - currentTokens;
        if (remainingTokens >= 80) {
          const allowedChars = remainingTokens * this.budgetConfig.charsPerToken;
          const lines = snippet.content.split('\n');
          let partialText = '';
          let keptLines = 0;

          for (const line of lines) {
            if ((partialText + line + '\n').length > allowedChars) break;
            partialText += line + '\n';
            keptLines++;
          }

          if (keptLines > 3) {
            const truncatedSnippet: ContextSnippet = {
              ...snippet,
              endLine: snippet.startLine + keptLines - 1,
              content: partialText.trimEnd(),
              tokens: Math.ceil(partialText.length / this.budgetConfig.charsPerToken),
              reason: `${snippet.reason} [Capped to fit remaining budget]`,
            };
            chosenSnippets.push(truncatedSnippet);
            currentTokens += truncatedSnippet.tokens;
            currentChars += partialText.length;
          }
        }
        break; // Budget filled
      }
    }

    // 8. Format structured context block
    const formattedContext = this.formatContextBlock(chosenSnippets, currentTokens, budgetTokens);
    const uniqueFiles = new Set(chosenSnippets.map((s) => s.filePath));
    const summary = `Context used: ${chosenSnippets.length} snippets from ${uniqueFiles.size} files (${currentTokens} / ${budgetTokens} tokens)`;

    return {
      snippets: chosenSnippets,
      totalTokens: currentTokens,
      budgetTokens,
      formattedContext,
      summary,
    };
  }

  /**
   * Merges overlapping or adjacent snippets from the same file, avoiding duplicates.
   */
  private deduplicateAndMergeSnippets(snippets: ContextSnippet[]): ContextSnippet[] {
    const fileMap = new Map<string, ContextSnippet[]>();

    for (const s of snippets) {
      const list = fileMap.get(s.filePath) || [];
      list.push(s);
      fileMap.set(s.filePath, list);
    }

    const mergedResults: ContextSnippet[] = [];

    for (const [filePath, fileSnippets] of fileMap.entries()) {
      // Sort snippets by startLine ascending
      fileSnippets.sort((a, b) => a.startLine - b.startLine);

      const mergedFileSnippets: ContextSnippet[] = [];

      for (const curr of fileSnippets) {
        if (mergedFileSnippets.length === 0) {
          mergedFileSnippets.push({ ...curr });
          continue;
        }

        const prev = mergedFileSnippets[mergedFileSnippets.length - 1];

        // Check for overlap or adjacency (within 5 lines)
        if (curr.startLine <= prev.endLine + 5) {
          // Merge snippets
          if (curr.endLine > prev.endLine) {
            const root = this.indexer.getWorkspaceRoot();
            const fullPath = path.resolve(root, filePath);
            let combinedContent = prev.content;

            if (fs.existsSync(fullPath)) {
              try {
                const raw = fs.readFileSync(fullPath, 'utf-8');
                const allLines = raw.split(/\r?\n/);
                combinedContent = allLines.slice(prev.startLine - 1, curr.endLine).join('\n');
              } catch {}
            }

            prev.endLine = curr.endLine;
            prev.content = combinedContent;
            prev.tokens = Math.ceil(combinedContent.length / this.budgetConfig.charsPerToken);
            prev.score = Math.max(prev.score, curr.score);
            prev.reason = `${prev.reason} + ${curr.reason}`;
          }
        } else {
          mergedFileSnippets.push({ ...curr });
        }
      }

      mergedResults.push(...mergedFileSnippets);
    }

    // Re-sort overall by score descending
    mergedResults.sort((a, b) => b.score - a.score);
    return mergedResults;
  }

  /**
   * Formats retrieved snippets into a clean, markdown-delimited context prompt.
   */
  private formatContextBlock(
    snippets: ContextSnippet[],
    totalTokens: number,
    budgetTokens: number
  ): string {
    if (snippets.length === 0) {
      return '';
    }

    const blocks: string[] = [
      `### Workspace Context (${totalTokens} / ${budgetTokens} tokens bounded context):`,
      '',
    ];

    for (const s of snippets) {
      const ext = path.extname(s.filePath).replace('.', '') || 'text';
      blocks.push(
        `---`,
        `[File: ${s.filePath} (Lines ${s.startLine}-${s.endLine}) | Reason: ${s.reason}]`,
        `\`\`\`${ext}`,
        s.content,
        `\`\`\``,
        ''
      );
    }

    return blocks.join('\n');
  }
}
