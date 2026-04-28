import { describe, expect, it } from 'vitest';
import {
  appendTokenFooter,
  formatTokenCount,
  formatTokenFooter,
} from './token-footer.js';

describe('formatTokenCount', () => {
  it('returns raw integer when below 1000', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(89)).toBe('89');
    expect(formatTokenCount(999)).toBe('999');
  });

  it('formats thousands as X.XK', () => {
    expect(formatTokenCount(1000)).toBe('1.0K');
    expect(formatTokenCount(2100)).toBe('2.1K');
    expect(formatTokenCount(12400)).toBe('12.4K');
    expect(formatTokenCount(999_499)).toBe('999.5K');
  });

  it('formats millions as X.XM', () => {
    expect(formatTokenCount(1_000_000)).toBe('1.0M');
    expect(formatTokenCount(1_500_000)).toBe('1.5M');
  });

  it('clamps invalid values to 0', () => {
    expect(formatTokenCount(-1)).toBe('0');
    expect(formatTokenCount(NaN)).toBe('0');
  });
});

describe('formatTokenFooter', () => {
  it('formats the canonical user-approved layout with ctx percentage', () => {
    // 12400 + 8200 + 0 = 20600 → 20600/200000 = 10.3% → rounds to 10%
    expect(
      formatTokenFooter({
        inputTokens: 12400,
        outputTokens: 2100,
        cacheReadTokens: 8200,
        cacheCreationTokens: 0,
        costUsd: 0.034,
        numTurns: 3,
      }),
    ).toBe(
      '· 输入 12.4K · 输出 2.1K · 缓存命中 8.2K · 成本 $0.034 · 3 轮 · ctx:10%',
    );
  });

  it('always shows cache (even when 0)', () => {
    const out = formatTokenFooter({
      inputTokens: 500,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0.001,
      numTurns: 1,
    });
    expect(out).toContain('缓存命中 0');
    expect(out).toContain('成本 $0.001');
    expect(out).toContain('1 轮');
    expect(out).toContain('ctx:0%');
  });

  it('formats cost with 3-decimal precision', () => {
    expect(
      formatTokenFooter({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 1.234567,
        numTurns: 0,
      }),
    ).toContain('成本 $1.235');
  });

  it('shows correct percentage for large context', () => {
    // 3 + 55700 + 0 = 55703 → 55703/200000 = 27.85% → rounds to 28%
    const out = formatTokenFooter({
      inputTokens: 3,
      outputTokens: 380,
      cacheReadTokens: 55700,
      cacheCreationTokens: 0,
      costUsd: 10.201,
      numTurns: 1,
    });
    expect(out).toContain('ctx:28%');
  });

  it('includes cacheCreationTokens in ctx percentage', () => {
    // 100 + 50000 + 5000 = 55100 → 55100/200000 = 27.55% → rounds to 28%
    const out = formatTokenFooter({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 50000,
      cacheCreationTokens: 5000,
      costUsd: 0.5,
      numTurns: 1,
    });
    expect(out).toContain('ctx:28%');
  });
});

describe('appendTokenFooter', () => {
  it('appends footer separated by blank line', () => {
    const result = appendTokenFooter('Andy 的回复', {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0.001,
      numTurns: 1,
    });
    expect(result).toBe(
      'Andy 的回复\n\n· 输入 100 · 输出 50 · 缓存命中 0 · 成本 $0.001 · 1 轮 · ctx:0%',
    );
  });

  it('returns empty input unchanged', () => {
    expect(
      appendTokenFooter('', {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
        numTurns: 0,
      }),
    ).toBe('');
  });
});
