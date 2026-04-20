import sharp from 'sharp';
import type { logger } from './logger.js';

type Logger = typeof logger;

export type ImageAttachment = {
  mediaType: 'image/jpeg';
  base64: string;
  sourceKey: string;
};

export type FailReason =
  | 'expired'
  | 'timeout'
  | 'too_large'
  | 'bad_format'
  | 'invalid_key'
  | 'download_failed';

export type Downloader = (key: string) => Promise<Buffer>;

const KEY_REGEX = /^[a-zA-Z0-9_-]+$/;
const MAX_LONG_EDGE = 1568;
const JPEG_QUALITY = 85;

function classifyError(err: unknown): FailReason {
  const e = err as {
    code?: string;
    statusCode?: number;
    response?: { status?: number };
  };
  const status = e?.statusCode ?? e?.response?.status;
  if (status === 403 || status === 404) return 'expired';
  if (
    e?.code === 'ECONNABORTED' ||
    /timeout/i.test(String((err as Error)?.message ?? ''))
  )
    return 'timeout';
  if (
    e?.code === 'ERR_FR_MAX_CONTENT_LENGTH_EXCEEDED' ||
    /max.*content.*length/i.test(String((err as Error)?.message ?? ''))
  )
    return 'too_large';
  return 'download_failed';
}

async function processOne(
  key: string,
  downloader: Downloader,
  logger: Logger,
): Promise<ImageAttachment | { key: string; reason: FailReason }> {
  if (!KEY_REGEX.test(key)) {
    logger.error({ key }, '[image] invalid image_key rejected');
    return { key, reason: 'invalid_key' };
  }

  let buf: Buffer;
  try {
    buf = await downloader(key);
  } catch (err) {
    const reason = classifyError(err);
    logger.warn(
      { key, reason, err: (err as Error).message },
      '[image] download failed',
    );
    return { key, reason };
  }

  try {
    const out = await sharp(buf)
      .rotate()
      .resize(MAX_LONG_EDGE, MAX_LONG_EDGE, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer();
    return {
      mediaType: 'image/jpeg',
      base64: out.toString('base64'),
      sourceKey: key,
    };
  } catch (err) {
    logger.warn(
      { key, err: (err as Error).message },
      '[image] decode/encode failed',
    );
    return { key, reason: 'bad_format' };
  }
}

export async function processImageKeys(
  imageKeys: string[],
  downloader: Downloader,
  logger: Logger,
): Promise<{
  attachments: ImageAttachment[];
  failures: Array<{ key: string; reason: FailReason }>;
}> {
  if (imageKeys.length === 0) return { attachments: [], failures: [] };

  const results = await Promise.all(
    imageKeys.map((k) => processOne(k, downloader, logger)),
  );

  const attachments: ImageAttachment[] = [];
  const failures: Array<{ key: string; reason: FailReason }> = [];
  for (const r of results) {
    if ('base64' in r) attachments.push(r);
    else failures.push(r);
  }
  return { attachments, failures };
}
