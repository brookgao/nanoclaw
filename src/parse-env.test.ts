import { describe, expect, it } from 'vitest';
import { parseIntEnv } from './parse-env.js';

describe('parseIntEnv', () => {
  it('returns the parsed integer when valid', () => {
    expect(parseIntEnv('8080', 47291)).toBe(8080);
  });

  it('falls back when undefined', () => {
    expect(parseIntEnv(undefined, 47291)).toBe(47291);
  });

  it('falls back on non-numeric input (no silent NaN)', () => {
    expect(parseIntEnv('abc', 47291)).toBe(47291);
    expect(parseIntEnv('', 47291)).toBe(47291);
  });

  it('falls back on non-positive values', () => {
    expect(parseIntEnv('0', 180000)).toBe(180000);
    expect(parseIntEnv('-5', 180000)).toBe(180000);
  });
});
