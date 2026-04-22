import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import sharp from 'sharp';
import { processImageKeys, type FailReason } from './image.js';

const NORMAL = readFileSync('tests/fixtures/image-normal.png');
const HUGE = readFileSync('tests/fixtures/image-huge.png');
const CORRUPT = readFileSync('tests/fixtures/image-corrupt.jpg');

function makeDownloader(map: Record<string, Buffer | Error>) {
  return vi.fn(async (key: string) => {
    const v = map[key];
    if (v instanceof Error) throw v;
    if (!v) throw Object.assign(new Error('404'), { statusCode: 404 });
    return v;
  });
}
const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
} as any;

describe('processImageKeys', () => {
  it('processes a normal PNG → JPEG output', async () => {
    const dl = makeDownloader({ k1: NORMAL });
    const r = await processImageKeys(['k1'], dl, noopLogger);
    expect(r.attachments).toHaveLength(1);
    expect(r.attachments[0].mediaType).toBe('image/jpeg');
    expect(r.attachments[0].sourceKey).toBe('k1');
    expect(r.attachments[0].base64.length).toBeGreaterThan(0);
    expect(r.failures).toHaveLength(0);
  });

  it('resizes huge image to ≤1568px long edge', async () => {
    const dl = makeDownloader({ k1: HUGE });
    const r = await processImageKeys(['k1'], dl, noopLogger);
    const outBuf = Buffer.from(r.attachments[0].base64, 'base64');
    const meta = await sharp(outBuf).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1568);
  });

  it('lands 404 downloads in failures[] with reason=expired', async () => {
    const dl = makeDownloader({});
    const r = await processImageKeys(['missing'], dl, noopLogger);
    expect(r.attachments).toHaveLength(0);
    expect(r.failures).toEqual([
      { key: 'missing', reason: 'expired' as FailReason },
    ]);
  });

  it('lands timeouts in failures[] with reason=timeout', async () => {
    const timeoutErr = Object.assign(new Error('timeout'), {
      code: 'ECONNABORTED',
    });
    const dl = makeDownloader({ k1: timeoutErr });
    const r = await processImageKeys(['k1'], dl, noopLogger);
    expect(r.failures[0].reason).toBe('timeout');
  });

  it('lands >10MB in failures[] with reason=too_large', async () => {
    const oversized = Object.assign(new Error('payload too large'), {
      code: 'ERR_FR_MAX_CONTENT_LENGTH_EXCEEDED',
    });
    const dl = makeDownloader({ k1: oversized });
    const r = await processImageKeys(['k1'], dl, noopLogger);
    expect(r.failures[0].reason).toBe('too_large');
  });

  it('lands corrupt bytes in failures[] with reason=bad_format', async () => {
    const dl = makeDownloader({ k1: CORRUPT });
    const r = await processImageKeys(['k1'], dl, noopLogger);
    expect(r.failures[0].reason).toBe('bad_format');
  });

  it('rejects invalid image_key (regex mismatch) without HTTP call', async () => {
    const dl = vi.fn();
    const r = await processImageKeys(['../etc/passwd'], dl as any, noopLogger);
    expect(dl).not.toHaveBeenCalled();
    expect(r.failures[0].reason).toBe('invalid_key');
  });

  it('handles mixed success/failure in parallel', async () => {
    const dl = makeDownloader({ k1: NORMAL, k3: NORMAL });
    const r = await processImageKeys(['k1', 'k2', 'k3'], dl, noopLogger);
    expect(r.attachments.map((a) => a.sourceKey)).toEqual(['k1', 'k3']);
    expect(r.failures.map((f) => f.key)).toEqual(['k2']);
  });

  it('returns empty on empty input', async () => {
    const dl = vi.fn();
    const r = await processImageKeys([], dl as any, noopLogger);
    expect(r).toEqual({ attachments: [], failures: [] });
    expect(dl).not.toHaveBeenCalled();
  });

  it('unclassified download error → failures[] with reason=download_failed', async () => {
    const dnsErr = Object.assign(new Error('getaddrinfo ENOTFOUND feishu.cn'), {
      code: 'ENOTFOUND',
    });
    const dl = makeDownloader({ k1: dnsErr });
    const r = await processImageKeys(['k1'], dl, noopLogger);
    expect(r.failures[0].reason).toBe('download_failed');
  });
});
