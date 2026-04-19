export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  numTurns: number;
}

export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

export function formatTokenFooter(usage: TokenUsage): string {
  const parts = [
    `输入 ${formatTokenCount(usage.inputTokens)}`,
    `输出 ${formatTokenCount(usage.outputTokens)}`,
    `缓存命中 ${formatTokenCount(usage.cacheReadTokens)}`,
    `成本 $${usage.costUsd.toFixed(3)}`,
    `${usage.numTurns} 轮`,
  ];
  return '· ' + parts.join(' · ');
}

export function appendTokenFooter(text: string, usage: TokenUsage): string {
  if (!text) return text;
  return `${text}\n\n${formatTokenFooter(usage)}`;
}
