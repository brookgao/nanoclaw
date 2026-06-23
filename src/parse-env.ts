/**
 * Parse a positive integer from an env var, falling back to `fallback` when the
 * value is missing, non-numeric, or non-positive. Avoids silently propagating
 * NaN (which would, e.g., make net.listen bind a random port or disable the
 * watchdog comparison).
 */
export function parseIntEnv(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
