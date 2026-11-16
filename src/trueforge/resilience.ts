/**
 * TrueForge Resilience Utilities: Exponential backoff, error categorization,
 * and human-readable error formatting (no stack traces).
 */

export interface ResilienceConfig {
  maxRetriesPerModel: number; // default: 2 (1 initial + 2 retries = 3 attempts per model)
  initialBackoffMs: number; // default: 1000ms
  maxBackoffMs: number; // default: 8000ms
  backoffMultiplier: number; // default: 2
}

export const DEFAULT_RESILIENCE_CONFIG: ResilienceConfig = {
  maxRetriesPerModel: 2,
  initialBackoffMs: 1000,
  maxBackoffMs: 8000,
  backoffMultiplier: 2,
};

/**
 * Pauses execution for the specified milliseconds, respecting AbortSignal.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new Error('Operation aborted'));
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error('Operation aborted'));
    };

    signal?.addEventListener('abort', onAbort);
  });
}

/**
 * Calculates exponential backoff delay with optional slight jitter.
 */
export function calculateBackoffDelay(
  retryCount: number, // 1 for first retry, 2 for second retry
  config: ResilienceConfig = DEFAULT_RESILIENCE_CONFIG
): number {
  if (retryCount <= 0) return 0;
  const expDelay = config.initialBackoffMs * Math.pow(config.backoffMultiplier, retryCount - 1);
  // Add 10% jitter to prevent thundering herd
  const jitter = Math.random() * 0.1 * expDelay;
  return Math.min(config.maxBackoffMs, Math.round(expDelay + jitter));
}

/**
 * Formats any error into a clean, human-readable description.
 * NEVER returns raw stack traces, node_modules paths, or unparsed JSON exceptions.
 */
export function formatHumanReadableError(
  err: any,
  context?: { model?: string; baseUrl?: string; attempts?: number }
): string {
  if (!err) {
    return 'An unknown error occurred while communicating with TrueForge.';
  }

  const rawMsg: string =
    typeof err === 'string'
      ? err
      : err.message || err.reason || err.statusText || String(err);

  const modelLabel = context?.model ? ` "${context.model}"` : '';
  const urlLabel = context?.baseUrl ? ` at ${context.baseUrl}` : '';

  // 1. Unreachable endpoint or network failures
  if (
    rawMsg.includes('fetch failed') ||
    rawMsg.includes('ECONNREFUSED') ||
    rawMsg.includes('ENOTFOUND') ||
    rawMsg.includes('EAI_AGAIN') ||
    rawMsg.includes('UND_ERR_CONNECT_TIMEOUT') ||
    rawMsg.includes('ECONNRESET')
  ) {
    return `Cannot connect to TrueForge${urlLabel}. Please verify that the TrueForge server is running (e.g. run "npx @truefoundry/trueforge" or check http://localhost:8790).`;
  }

  // 2. Request timeouts
  if (
    rawMsg.includes('timeout') ||
    rawMsg.includes('ETIMEDOUT') ||
    rawMsg.includes('TrueForgeTimeoutError') ||
    err.name === 'TimeoutError'
  ) {
    return `TrueForge request timed out. The server took too long to respond${urlLabel}.`;
  }

  // 3. Authentication or invalid API key
  if (
    rawMsg.includes('API_KEY_INVALID') ||
    rawMsg.includes('invalid api key') ||
    rawMsg.includes('Invalid API key') ||
    rawMsg.includes('authentication failed') ||
    rawMsg.includes('Unauthorized') ||
    rawMsg.includes('401') ||
    rawMsg.includes('403')
  ) {
    return `Authentication failed: The API key for model${modelLabel} is invalid, missing, or unauthorized in TrueForge. Please verify your provider API key in TrueForge (http://localhost:8790).`;
  }

  // 4. Rate limits or quota exhaustion
  if (
    rawMsg.includes('RESOURCE_EXHAUSTED') ||
    rawMsg.includes('rate limit') ||
    rawMsg.includes('429') ||
    rawMsg.includes('quota exceeded') ||
    rawMsg.includes('Too Many Requests')
  ) {
    return `Rate limit or quota exceeded for model${modelLabel}. Please wait a few moments or verify your API quota limits in TrueForge.`;
  }

  // 5. Unknown or unconfigured model
  if (
    rawMsg.includes('Unknown model') ||
    rawMsg.includes('not configured on provider') ||
    rawMsg.includes('is not supported') ||
    rawMsg.includes('model not found') ||
    rawMsg.includes('422')
  ) {
    return `Model${modelLabel} is not available or not configured in TrueForge. Please check your configured models in extension settings.`;
  }

  // 6. User or client cancellation
  if (
    rawMsg.includes('client-cancelled') ||
    rawMsg.includes('aborted') ||
    err.name === 'AbortError'
  ) {
    return 'The operation was cancelled by the user.';
  }

  // 7. General cleanup: strip any stack trace traces or JSON wrappers
  let sanitized = rawMsg;

  // Extract from JSON error if wrapped
  try {
    const parsed = JSON.parse(sanitized);
    if (parsed?.error?.message) {
      sanitized = parsed.error.message;
    } else if (parsed?.message) {
      sanitized = parsed.message;
    }
  } catch {}

  // Strip anything following "\n at " (stack trace)
  if (sanitized.includes('\n at ')) {
    sanitized = sanitized.split('\n at ')[0].trim();
  }
  if (sanitized.includes('    at ')) {
    sanitized = sanitized.split('    at ')[0].trim();
  }

  // Remove leading "Error: "
  sanitized = sanitized.replace(/^Error:\s*/, '').trim();

  // If message contains internal file paths, strip them
  sanitized = sanitized.replace(/\([A-Za-z]:\\[^)]+\)/g, '').trim();
  sanitized = sanitized.replace(/\(\/[^)]+\)/g, '').trim();

  if (!sanitized) {
    return `TrueForge turn failed for model${modelLabel}.`;
  }

  return `TrueForge error: ${sanitized}`;
}
