export const MAX_CONTEXT_TOKENS = 3500;
export const CHARS_PER_TOKEN = 4;
export const MAX_CONTEXT_CHARS = MAX_CONTEXT_TOKENS * CHARS_PER_TOKEN; // ~14,000 chars

/**
 * Enforces the ~3,500 token budget on any tool output before sending to TrueForge.
 * When text exceeds the budget, it truncates gracefully and appends a notice of what was cut.
 */
export function enforceContextBudget(
  text: string,
  options: { label?: string; maxChars?: number } = {}
): string {
  const limit = options.maxChars ?? MAX_CONTEXT_CHARS;
  if (text.length <= limit) {
    return text;
  }

  const truncated = text.slice(0, limit);
  const totalLines = text.split('\n').length;
  const keptLines = truncated.split('\n').length;
  const cutChars = text.length - limit;
  const label = options.label ? ` for ${options.label}` : '';

  return (
    truncated +
    `\n\n[TRUNCATED${label}: Output capped at ~${MAX_CONTEXT_TOKENS} tokens to preserve context budget. ` +
    `Showing ${keptLines} of ${totalLines} lines (cut ${cutChars} characters / ~${Math.round(cutChars / CHARS_PER_TOKEN)} tokens).]`
  );
}
