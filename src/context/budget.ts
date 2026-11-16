export const DEFAULT_WORKSPACE_CONTEXT_BUDGET_TOKENS = 6000;
export const MAX_CONTEXT_TOKENS = 3500;
export const CHARS_PER_TOKEN = 4;
export const MAX_CONTEXT_CHARS = MAX_CONTEXT_TOKENS * CHARS_PER_TOKEN; // ~14,000 chars

/**
 * Estimates token count from string content (rule of thumb: ~4 characters per token).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Enforces a strict token/character budget on any text output before sending to TrueForge.
 * When text exceeds the budget, it truncates gracefully and appends a notice of what was cut.
 */
export function enforceContextBudget(
  text: string,
  options: { label?: string; maxChars?: number; maxTokens?: number } = {}
): string {
  const tokenLimit = options.maxTokens ?? (options.maxChars ? Math.round(options.maxChars / CHARS_PER_TOKEN) : MAX_CONTEXT_TOKENS);
  const charLimit = options.maxChars ?? tokenLimit * CHARS_PER_TOKEN;

  if (text.length <= charLimit) {
    return text;
  }

  const truncated = text.slice(0, charLimit);
  const totalLines = text.split('\n').length;
  const keptLines = truncated.split('\n').length;
  const cutChars = text.length - charLimit;
  const label = options.label ? ` for ${options.label}` : '';

  return (
    truncated +
    `\n\n[TRUNCATED${label}: Output capped at ~${tokenLimit} tokens to preserve context budget. ` +
    `Showing ${keptLines} of ${totalLines} lines (cut ${cutChars} characters / ~${Math.round(cutChars / CHARS_PER_TOKEN)} tokens).]`
  );
}
