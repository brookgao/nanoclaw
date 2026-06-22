import { describe, expect, it } from 'vitest';
import { feishuRetryDelayMs } from '../container/feishu-blocks-mcp/src/backoff.js';

describe('feishuRetryDelayMs', () => {
  it('grows exponentially with attempt', () => {
    expect(feishuRetryDelayMs(1)).toBeGreaterThanOrEqual(500);
    expect(feishuRetryDelayMs(1)).toBeLessThanOrEqual(1500); // base 1s + jitter
    expect(feishuRetryDelayMs(2)).toBeGreaterThan(feishuRetryDelayMs(1) - 1); // ~2s
    expect(feishuRetryDelayMs(3)).toBeGreaterThan(2000); // ~4s
  });

  it('caps the delay at 30s', () => {
    expect(feishuRetryDelayMs(10)).toBeLessThanOrEqual(30000);
  });
});
