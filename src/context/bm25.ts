import { DocumentChunk } from './types';

/**
 * Common English and code stop words to filter out of search queries.
 */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from',
  'has', 'he', 'in', 'is', 'it', 'its', 'of', 'on', 'that', 'the',
  'to', 'was', 'were', 'will', 'with', 'this', 'then', 'there',
]);

/**
 * Tokenizes text and code into searchable terms.
 * Handles snake_case, camelCase, path separators, and alphanumeric tokens.
 */
export function tokenizeText(text: string): string[] {
  if (!text) return [];

  // Match sequences of word characters preserving casing for camelCase splitting
  const rawTokens = text.match(/[A-Za-z0-9_]+/g) || [];
  const terms: string[] = [];

  for (const raw of rawTokens) {
    if (raw.length <= 1) continue;
    const lower = raw.toLowerCase();
    if (STOP_WORDS.has(lower)) continue;

    // Add lowercased original token
    terms.push(lower);

    // Split on underscores
    if (raw.includes('_')) {
      const parts = lower.split('_').filter((p) => p.length > 1 && !STOP_WORDS.has(p));
      terms.push(...parts);
    }

    // Split camelCase or numbers (e.g. "FlaskGroup" -> "flask", "group")
    const camelParts = raw
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([0-9]+)/g, ' $1 ')
      .toLowerCase()
      .split(/\s+/)
      .filter((p) => p.length > 1 && !STOP_WORDS.has(p));

    if (camelParts.length > 1) {
      terms.push(...camelParts);
    }
  }

  return terms;
}

export interface BM25SearchResult {
  chunk: DocumentChunk;
  score: number;
  matchedTerms: string[];
}

export class BM25Index {
  private chunks = new Map<string, DocumentChunk>();
  private docFrequencies = new Map<string, number>(); // term -> count of chunks containing term
  private totalLength = 0;
  private k1: number;
  private b: number;

  constructor(k1: number = 1.2, b: number = 0.75) {
    this.k1 = k1;
    this.b = b;
  }

  /**
   * Average document length across all indexed chunks.
   */
  public get avgDocLength(): number {
    return this.chunks.size > 0 ? this.totalLength / this.chunks.size : 1;
  }

  /**
   * Total number of indexed chunks.
   */
  public get totalDocuments(): number {
    return this.chunks.size;
  }

  /**
   * Adds or updates a document chunk in the index.
   */
  public addChunk(chunk: DocumentChunk): void {
    if (this.chunks.has(chunk.id)) {
      this.removeChunk(chunk.id);
    }

    this.chunks.set(chunk.id, chunk);
    this.totalLength += chunk.totalTerms;

    for (const term of chunk.termFrequencies.keys()) {
      const current = this.docFrequencies.get(term) || 0;
      this.docFrequencies.set(term, current + 1);
    }
  }

  /**
   * Removes a document chunk from the index.
   */
  public removeChunk(chunkId: string): void {
    const chunk = this.chunks.get(chunkId);
    if (!chunk) return;

    this.chunks.delete(chunkId);
    this.totalLength -= chunk.totalTerms;

    for (const term of chunk.termFrequencies.keys()) {
      const current = this.docFrequencies.get(term) || 0;
      if (current <= 1) {
        this.docFrequencies.delete(term);
      } else {
        this.docFrequencies.set(term, current - 1);
      }
    }
  }

  /**
   * Clears all indexed chunks.
   */
  public clear(): void {
    this.chunks.clear();
    this.docFrequencies.clear();
    this.totalLength = 0;
  }

  /**
   * Calculates Inverse Document Frequency (IDF) using Robertson-Spärck Jones formula with smoothing.
   */
  public getIdf(term: string): number {
    const n = this.docFrequencies.get(term) || 0;
    const N = this.chunks.size;
    if (N === 0) return 0;

    // Smoothed BM25 IDF: ln((N - n + 0.5) / (n + 0.5) + 1)
    return Math.max(0, Math.log((N - n + 0.5) / (n + 0.5) + 1));
  }

  /**
   * Searches the indexed chunks with BM25 keyword scoring.
   * Gives extra relevance weight to terms matching the file path.
   */
  public search(query: string, maxResults: number = 10): BM25SearchResult[] {
    const queryTerms = tokenizeText(query);
    if (queryTerms.length === 0 || this.chunks.size === 0) {
      return [];
    }

    const uniqueQueryTerms = Array.from(new Set(queryTerms));
    const avgdl = this.avgDocLength;
    const results: BM25SearchResult[] = [];

    for (const chunk of this.chunks.values()) {
      let score = 0;
      const matchedTerms: string[] = [];
      const normalizedPath = chunk.filePath.toLowerCase();

      for (const term of uniqueQueryTerms) {
        const tf = chunk.termFrequencies.get(term) || 0;
        const idf = this.getIdf(term);

        if (tf > 0) {
          matchedTerms.push(term);
          // Standard Okapi BM25 formula
          const numerator = tf * (this.k1 + 1);
          const denominator = tf + this.k1 * (1 - this.b + (this.b * chunk.totalTerms) / avgdl);
          score += idf * (numerator / denominator);
        }

        // Path relevance bonus
        if (normalizedPath.includes(term)) {
          score += idf * 0.75 + 0.5;
          if (!matchedTerms.includes(term)) {
            matchedTerms.push(term);
          }
        }
      }

      if (score > 0.05 && matchedTerms.length > 0) {
        // Boost score slightly if multiple query terms matched
        const coverageRatio = matchedTerms.length / uniqueQueryTerms.length;
        score = score * (1 + 0.5 * coverageRatio);

        results.push({
          chunk,
          score,
          matchedTerms,
        });
      }
    }

    // Sort descending by score
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, maxResults);
  }
}
