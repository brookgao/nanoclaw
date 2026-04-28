export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  numTurns: number;
}

export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

const CONTEXT_WINDOW = 200_000;

export function formatTokenFooter(usage: TokenUsage): string {
  const ctx =
    usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
  const ctxPct = Math.round((ctx / CONTEXT_WINDOW) * 100);
  const parts = [
    `输入 ${formatTokenCount(usage.inputTokens)}`,
    `输出 ${formatTokenCount(usage.outputTokens)}`,
    `缓存命中 ${formatTokenCount(usage.cacheReadTokens)}`,
    `成本 $${usage.costUsd.toFixed(3)}`,
    `${usage.numTurns} 轮`,
    `ctx:${ctxPct}%`,
  ];
  return '· ' + parts.join(' · ');
}

export function appendTokenFooter(text: string, usage: TokenUsage): string {
  if (!text) return text;
  return `${text}\n\n${formatTokenFooter(usage)}`;
}
