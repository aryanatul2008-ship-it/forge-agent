export interface ContextSnippet {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
  reason: string;
  tokens: number;
  source: 'mention' | 'symbol' | 'bm25' | 'tree';
}

export interface ContextBudgetConfig {
  maxTokens: number;
  charsPerToken: number;
}

export interface ContextResult {
  snippets: ContextSnippet[];
  totalTokens: number;
  budgetTokens: number;
  formattedContext: string;
  summary: string;
}

export interface MentionItem {
  label: string;
  detail: string;
  type: 'file' | 'symbol';
  value: string;
  filePath?: string;
  line?: number;
}

export interface DocumentChunk {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  tokensCount: number;
  termFrequencies: Map<string, number>;
  totalTerms: number;
}

export interface SymbolEntry {
  name: string;
  kind: string;
  filePath: string;
  line: number;
  snippet: string;
  containerName?: string;
}

export interface MentionRef {
  type: 'file' | 'symbol';
  target: string;
  raw: string;
}
