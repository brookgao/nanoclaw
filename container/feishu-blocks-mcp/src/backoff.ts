/**
 * Exponential backoff (base 1s, ×2 per attempt) with up to +50% deterministic
 * jitter, capped at 30s. `attempt` is 1-based (1 = first retry).
 *
 * Jitter is derived from the attempt number (no Math.random) so the delay is
 * deterministic and unit-testable while still spreading retries apart.
 */
export function feishuRetryDelayMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** (attempt - 1), 30000);
  const jitter = base * 0.5 * (((attempt * 2654435761) % 1000) / 1000);
  return Math.min(Math.round(base + jitter), 30000);
}

export const FEISHU_MAX_RETRIES = 4;
