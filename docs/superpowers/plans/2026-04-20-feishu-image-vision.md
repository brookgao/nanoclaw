# Feishu Image Vision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Andy (the agent running in Feishu groups) see and reason over images attached to `post` (rich text) and `image` Feishu messages.

**Architecture:** Host-side download via existing `@larksuiteoapi/node-sdk` client → `sharp` resize + JPEG re-encode → base64-encoded sidecar `images[]` threaded through the existing `text`/IPC pipeline → `ContentBlockParam[]` injection at the agent-runner's `MessageStream.push()` boundary. Pure-text flow unchanged.

**Tech Stack:** TypeScript, vitest, `sharp@^0.34`, `@anthropic-ai/claude-agent-sdk@^0.2.92` (already declares sharp as optional peer dep), `@larksuiteoapi/node-sdk`, Node 20.

**Spec:** `docs/superpowers/specs/2026-04-20-feishu-image-vision-design.md`

**Field-name note:** the spec used `text` for the message content field, but the actual type is `NewMessage.content` and sender is `NewMessage.sender_name`. This plan uses the real field names.

---

## File Map

| File | Role | Action |
|---|---|---|
| `package.json` | Add `sharp` dep | Modify |
| `src/types.ts` | `ImageAttachment` type + `NewMessage.images?` | Modify |
| `src/image.ts` | Download / resize / base64 pipeline | Create |
| `src/image.test.ts` | Unit tests for `processImageKeys` | Create |
| `tests/fixtures/` | Sample images (normal, large, gif, corrupt) | Create |
| `src/channels/feishu.ts` | `parseInbound` for `post`/`image`, `downloadImage`, failure reply, 👀/❌ reaction, image attached to `deliver` | Modify |
| `src/channels/feishu.test.ts` | Add `post`/`image` parsing + failure cases | Modify |
| `src/router.ts` | `formatMessages` returns `{xml, images}` with `[图 N]` placeholders | Modify |
| `src/router.test.ts` | Add image placeholder tests (new file if absent — confirm in Task 5) | Create or Modify |
| `src/index.ts` | Thread images from buffer → `runContainerAgent` / `sendMessage` | Modify |
| `src/group-queue.ts` | `sendMessage` accepts images + 8 MB IPC cap | Modify |
| `src/group-queue.test.ts` | Add IPC size cap + images field | Modify |
| `src/container-runner.ts` | `ContainerInput.images?` through stdin JSON | Modify |
| `src/container-runner.test.ts` | Add stdin-serialization test | Modify |
| `container/agent-runner/src/index.ts` | `MessageStream.push(text, images?)` → multimodal content blocks; `drainIpcInput` returns `Array<{text, images?}>` | Modify |
| `container/agent-runner/package.json` | No change (sharp not needed in container) | — |

---

## Task 1: Add `sharp` dep + create `src/image.ts` with `processImageKeys` (TDD)

**Why first:** The module has zero upstream dependencies. TDD shakes out resize/failure edge cases before any wiring.

**Files:**
- Modify: `package.json` (add `sharp` to dependencies)
- Create: `src/image.ts`
- Create: `src/image.test.ts`
- Create: `tests/fixtures/image-normal.png` (any small PNG, e.g. 256×256)
- Create: `tests/fixtures/image-huge.png` (e.g. 3000×2000, generated or from any public domain source)
- Create: `tests/fixtures/image-animated.gif` (small animated GIF)
- Create: `tests/fixtures/image-corrupt.jpg` (random bytes with .jpg extension)

- [ ] **Step 1: Install sharp**

```bash
npm install sharp@^0.34
```

Expected: `sharp` appears under `dependencies` in `package.json`; `node_modules/sharp` present.

- [ ] **Step 2: Generate test fixtures**

```bash
mkdir -p tests/fixtures
node -e "
const sharp = require('sharp');
const fs = require('fs');
// 256x256 solid color PNG
sharp({create:{width:256,height:256,channels:3,background:{r:64,g:128,b:200}}}).png().toFile('tests/fixtures/image-normal.png').then(()=>console.log('normal ok'));
// 3000x2000 solid PNG
sharp({create:{width:3000,height:2000,channels:3,background:{r:200,g:80,b:40}}}).png().toFile('tests/fixtures/image-huge.png').then(()=>console.log('huge ok'));
// corrupt file
fs.writeFileSync('tests/fixtures/image-corrupt.jpg', Buffer.from('not an image really'));
console.log('corrupt ok');
"
```

For the animated GIF, use any small public fixture or skip that one specific case (not critical).

Expected: `tests/fixtures/` contains `image-normal.png`, `image-huge.png`, `image-corrupt.jpg` (and ideally `image-animated.gif`).

- [ ] **Step 3: Write `src/image.test.ts` — ALL failing cases up front**

```ts
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
const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;

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
    const dl = makeDownloader({});  // all keys 404
    const r = await processImageKeys(['missing'], dl, noopLogger);
    expect(r.attachments).toHaveLength(0);
    expect(r.failures).toEqual([{ key: 'missing', reason: 'expired' as FailReason }]);
  });

  it('lands timeouts in failures[] with reason=timeout', async () => {
    const timeoutErr = Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
    const dl = makeDownloader({ k1: timeoutErr });
    const r = await processImageKeys(['k1'], dl, noopLogger);
    expect(r.failures[0].reason).toBe('timeout');
  });

  it('lands >10MB in failures[] with reason=too_large', async () => {
    const oversized = Object.assign(new Error('payload too large'), { code: 'ERR_FR_MAX_CONTENT_LENGTH_EXCEEDED' });
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
    const dl = makeDownloader({ k1: NORMAL, k3: NORMAL });  // k2 missing
    const r = await processImageKeys(['k1', 'k2', 'k3'], dl, noopLogger);
    expect(r.attachments.map(a => a.sourceKey)).toEqual(['k1', 'k3']);
    expect(r.failures.map(f => f.key)).toEqual(['k2']);
  });

  it('returns empty on empty input', async () => {
    const dl = vi.fn();
    const r = await processImageKeys([], dl as any, noopLogger);
    expect(r).toEqual({ attachments: [], failures: [] });
    expect(dl).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Run tests — expect all to fail (module not created yet)**

```bash
npx vitest run src/image.test.ts
```

Expected: cannot find module `./image.js`.

- [ ] **Step 5: Create `src/image.ts`**

```ts
import sharp from 'sharp';
import type { Logger } from 'pino';

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
  | 'invalid_key';

export type Downloader = (key: string) => Promise<Buffer>;

const KEY_REGEX = /^[a-zA-Z0-9_-]+$/;
const MAX_LONG_EDGE = 1568;
const JPEG_QUALITY = 85;

function classifyError(err: unknown): FailReason {
  const e = err as { code?: string; statusCode?: number; response?: { status?: number } };
  const status = e?.statusCode ?? e?.response?.status;
  if (status === 403 || status === 404) return 'expired';
  if (e?.code === 'ECONNABORTED' || /timeout/i.test(String((err as Error)?.message ?? ''))) return 'timeout';
  if (e?.code === 'ERR_FR_MAX_CONTENT_LENGTH_EXCEEDED' || /max.*content.*length/i.test(String((err as Error)?.message ?? ''))) return 'too_large';
  return 'expired';
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
    logger.warn({ key, reason, err: (err as Error).message }, '[image] download failed');
    return { key, reason };
  }

  try {
    const out = await sharp(buf)
      .rotate()
      .resize(MAX_LONG_EDGE, MAX_LONG_EDGE, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer();
    return {
      mediaType: 'image/jpeg',
      base64: out.toString('base64'),
      sourceKey: key,
    };
  } catch (err) {
    logger.warn({ key, err: (err as Error).message }, '[image] decode/encode failed');
    return { key, reason: 'bad_format' };
  }
}

export async function processImageKeys(
  imageKeys: string[],
  downloader: Downloader,
  logger: Logger,
): Promise<{ attachments: ImageAttachment[]; failures: Array<{ key: string; reason: FailReason }> }> {
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
```

- [ ] **Step 6: Run tests — expect all to pass**

```bash
npx vitest run src/image.test.ts
```

Expected: 9 passing.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/image.ts src/image.test.ts tests/fixtures/
git commit -m "feat(image): add processImageKeys module with sharp resize/JPEG pipeline"
```

---

## Task 2: Extend shared types (`src/types.ts`)

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add `ImageAttachment` re-export and extend `NewMessage`**

Find the `NewMessage` interface (currently at `src/types.ts:57-70`). Replace:

```ts
export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  thread_id?: string;
  reply_to_message_id?: string;
  reply_to_message_content?: string;
  reply_to_sender_name?: string;
}
```

with:

```ts
import type { ImageAttachment } from './image.js';
export type { ImageAttachment } from './image.js';

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  thread_id?: string;
  reply_to_message_id?: string;
  reply_to_message_content?: string;
  reply_to_sender_name?: string;
  images?: ImageAttachment[];
}
```

(Add the `import type` line at the top of `src/types.ts` alongside existing imports.)

- [ ] **Step 2: Build**

```bash
npm run build
```

Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): add ImageAttachment export and NewMessage.images field"
```

---

## Task 3: Feishu `post` / `image` parser — `parseInbound` (TDD)

**Files:**
- Modify: `src/channels/feishu.ts` (add `parseInbound` helper; update `handleEvent` to use it)
- Modify: `src/channels/feishu.test.ts` (replace existing "ignores non-text" with new cases)

- [ ] **Step 1: Add new failing tests to `feishu.test.ts`**

Open `src/channels/feishu.test.ts`, **remove** the existing test block `it('ignores non-text message types', ...)` (currently around line 137-142), and in its place add:

```ts
import { parseInbound } from './feishu.js';  // NEW: exported helper

describe('parseInbound', () => {
  const botOpenId = 'ou_bot';

  it('text message → text only, no images', () => {
    const r = parseInbound(
      { message_type: 'text', content: JSON.stringify({ text: 'hello' }), mentions: [] } as any,
      botOpenId,
    );
    expect(r).toEqual({ text: 'hello', imageKeys: [], botMentioned: false });
  });

  it('image message → single image key, empty text', () => {
    const r = parseInbound(
      { message_type: 'image', content: JSON.stringify({ image_key: 'img_v3_abc' }), mentions: [] } as any,
      botOpenId,
    );
    expect(r).toEqual({ text: '', imageKeys: ['img_v3_abc'], botMentioned: false });
  });

  it('post: text + img + at (bot) → text preserved, bot at omitted, image collected, botMentioned=true', () => {
    const content = JSON.stringify({
      title: '',
      content: [[
        { tag: 'text', text: 'look at this ' },
        { tag: 'at', user_id: botOpenId },
        { tag: 'img', image_key: 'img_k1' },
      ]],
    });
    const r = parseInbound(
      { message_type: 'post', content, mentions: [{ key: '@_user_1', id: { open_id: botOpenId }, name: 'Andy' }] } as any,
      botOpenId,
    );
    expect(r!.text).toBe('look at this');
    expect(r!.imageKeys).toEqual(['img_k1']);
    expect(r!.botMentioned).toBe(true);
  });

  it('post: at non-bot user → substituted with @name from mentions[]', () => {
    const content = JSON.stringify({
      title: '',
      content: [[
        { tag: 'text', text: 'hey ' },
        { tag: 'at', user_id: 'ou_other' },
        { tag: 'text', text: ' look' },
      ]],
    });
    const r = parseInbound(
      { message_type: 'post', content, mentions: [{ key: '@_user_2', id: { open_id: 'ou_other' }, name: '小明' }] } as any,
      botOpenId,
    );
    expect(r!.text).toBe('hey @小明 look');
  });

  it('post: at with no matching mentions[] → fallback to user_id', () => {
    const content = JSON.stringify({
      title: '',
      content: [[{ tag: 'at', user_id: 'ou_unknown' }]],
    });
    const r = parseInbound(
      { message_type: 'post', content, mentions: [] } as any,
      botOpenId,
    );
    expect(r!.text).toBe('@ou_unknown');
  });

  it('post: >5 images → truncated + marker appended', () => {
    const segs = Array.from({ length: 7 }, (_, i) => ({ tag: 'img', image_key: `k${i}` }));
    const content = JSON.stringify({ title: '', content: [segs] });
    const r = parseInbound(
      { message_type: 'post', content, mentions: [] } as any,
      botOpenId,
    );
    expect(r!.imageKeys).toHaveLength(5);
    expect(r!.imageKeys).toEqual(['k0', 'k1', 'k2', 'k3', 'k4']);
    expect(r!.text).toContain('[系统: 本条消息含 7 张图，仅处理前 5 张]');
  });

  it('post: multiple paragraphs joined with newlines', () => {
    const content = JSON.stringify({
      title: '',
      content: [
        [{ tag: 'text', text: 'line 1' }],
        [{ tag: 'text', text: 'line 2' }],
      ],
    });
    const r = parseInbound(
      { message_type: 'post', content, mentions: [] } as any,
      botOpenId,
    );
    expect(r!.text).toBe('line 1\nline 2');
  });

  it('post: unknown tag → silently skipped', () => {
    const content = JSON.stringify({
      title: '',
      content: [[
        { tag: 'text', text: 'before ' },
        { tag: 'emoji', emoji_type: 'SMILE' },
        { tag: 'text', text: 'after' },
      ]],
    });
    const r = parseInbound(
      { message_type: 'post', content, mentions: [] } as any,
      botOpenId,
    );
    expect(r!.text).toBe('before after');
  });

  it('malformed post content JSON → returns null', () => {
    const r = parseInbound(
      { message_type: 'post', content: '{not json', mentions: [] } as any,
      botOpenId,
    );
    expect(r).toBeNull();
  });

  it('other types (audio/video/file/sticker) → returns null', () => {
    for (const t of ['audio', 'video', 'file', 'sticker']) {
      const r = parseInbound(
        { message_type: t, content: '{}', mentions: [] } as any,
        botOpenId,
      );
      expect(r).toBeNull();
    }
  });

  it('empty text + zero images → returns null', () => {
    const r = parseInbound(
      { message_type: 'post', content: JSON.stringify({ title: '', content: [[]] }), mentions: [] } as any,
      botOpenId,
    );
    expect(r).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect all failing**

```bash
npx vitest run src/channels/feishu.test.ts
```

Expected: `parseInbound` is not exported.

- [ ] **Step 3: Implement `parseInbound` in `src/channels/feishu.ts`**

Add at module level (above `class FeishuChannel`):

```ts
type PostSegment =
  | { tag: 'text'; text: string }
  | { tag: 'at'; user_id: string }
  | { tag: 'img'; image_key: string }
  | { tag: string; [k: string]: any };

type PostContent = { title?: string; content: PostSegment[][] };

type FeishuMention = { key?: string; id?: { open_id?: string }; name?: string };

export type ParsedInbound = {
  text: string;
  imageKeys: string[];
  botMentioned: boolean;
};

const MAX_IMAGES_PER_MESSAGE = 5;

export function parseInbound(
  m: { message_type: string; content: string; mentions?: FeishuMention[] },
  botOpenId: string | null,
): ParsedInbound | null {
  const mentions = m.mentions ?? [];
  const botMentioned = !!botOpenId && mentions.some((x) => x.id?.open_id === botOpenId);

  if (m.message_type === 'text') {
    try {
      const text = JSON.parse(m.content)?.text ?? '';
      return { text, imageKeys: [], botMentioned };
    } catch {
      return null;
    }
  }

  if (m.message_type === 'image') {
    try {
      const key = JSON.parse(m.content)?.image_key ?? '';
      if (!key) return null;
      return { text: '', imageKeys: [key], botMentioned };
    } catch {
      return null;
    }
  }

  if (m.message_type !== 'post') return null;

  let parsed: PostContent;
  try {
    parsed = JSON.parse(m.content);
  } catch {
    return null;
  }

  const paragraphs = parsed.content ?? [];
  const textLines: string[] = [];
  const imageKeys: string[] = [];

  for (const segs of paragraphs) {
    const parts: string[] = [];
    for (const seg of segs) {
      if (seg.tag === 'text' && typeof seg.text === 'string') {
        parts.push(seg.text);
      } else if (seg.tag === 'at' && typeof seg.user_id === 'string') {
        if (seg.user_id === botOpenId) continue;
        const mention = mentions.find((x) => x.id?.open_id === seg.user_id);
        const name = mention?.name ?? seg.user_id;
        parts.push(`@${name}`);
      } else if (seg.tag === 'img' && typeof seg.image_key === 'string') {
        imageKeys.push(seg.image_key);
      }
      // unknown tags: ignored
    }
    const line = parts.join('').trim();
    if (line) textLines.push(line);
  }

  const originalImageCount = imageKeys.length;
  const truncatedKeys = imageKeys.slice(0, MAX_IMAGES_PER_MESSAGE);
  let text = textLines.join('\n').replace(/\s+/g, ' ').trim();
  if (originalImageCount > MAX_IMAGES_PER_MESSAGE) {
    text = `${text}\n[系统: 本条消息含 ${originalImageCount} 张图，仅处理前 ${MAX_IMAGES_PER_MESSAGE} 张]`.trim();
  }

  if (!text && truncatedKeys.length === 0) return null;

  return { text, imageKeys: truncatedKeys, botMentioned };
}
```

Note: the `.replace(/\s+/g, ' ')` collapses whitespace so the "hey @小明 look" test matches. The paragraph newline handling is preserved because the join happens after normalization per-line.

**Wait — that's a conflict.** The "multiple paragraphs joined with newlines" test expects `\n` preserved. Adjust: don't collapse whitespace globally. Instead, only trim per-line. Replace the last block with:

```ts
  const originalImageCount = imageKeys.length;
  const truncatedKeys = imageKeys.slice(0, MAX_IMAGES_PER_MESSAGE);
  let text = textLines.join('\n');
  if (originalImageCount > MAX_IMAGES_PER_MESSAGE) {
    text = `${text}\n[系统: 本条消息含 ${originalImageCount} 张图，仅处理前 ${MAX_IMAGES_PER_MESSAGE} 张]`.trim();
  }

  if (!text && truncatedKeys.length === 0) return null;
  return { text, imageKeys: truncatedKeys, botMentioned };
```

And fix the `parts.join('')` per line — trim only the line, not collapse whitespace inside the message. Test the "hey @小明 look" expectation: parts = `['hey ', '@小明', ' look']`, joined = `'hey @小明 look'`, trimmed = `'hey @小明 look'`. ✓

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/channels/feishu.test.ts
```

Expected: all parseInbound tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/channels/feishu.ts src/channels/feishu.test.ts
git commit -m "feat(feishu): add parseInbound for post/image message types"
```

---

## Task 4: Wire `feishu.ts` download + failure path (TDD)

**Goal:** Replace the text-only filter at line 296 with routing through `parseInbound` + `processImageKeys`. Handle failures by sending `🖼️ ...` and swapping the reaction to `❌`.

**Files:**
- Modify: `src/channels/feishu.ts`
- Modify: `src/channels/feishu.test.ts`

- [ ] **Step 1: Add failing integration tests to `feishu.test.ts`**

At the bottom of the file (still inside the `describe('FeishuChannel inbound p2p', ...)` or a new describe block):

```ts
describe('FeishuChannel image pipeline', () => {
  beforeEach(() => {
    process.env.FEISHU_APP_ID = 'cli_test';
    process.env.FEISHU_APP_SECRET = 'secret_test';
  });

  it('p2p image success → onMessage called with images and audit log emitted', async () => {
    const onMessage = vi.fn();
    const ch = getChannelFactory('feishu')!(makeOpts({ onMessage }))! as any;
    // Inject stub downloader
    ch.downloadImage = vi.fn(async () => readFileSync('tests/fixtures/image-normal.png'));

    await ch.handleEvent(makeEvent({
      msg_type: 'image',
      content: JSON.stringify({ image_key: 'img_good' }),
    }));
    // handleEvent becomes async now — await it

    expect(onMessage).toHaveBeenCalledTimes(1);
    const msg = onMessage.mock.calls[0][1];
    expect(msg.images).toHaveLength(1);
    expect(msg.images[0].sourceKey).toBe('img_good');
  });

  it('p2p image fail → sendMessage called with 🖼️ prefix, onMessage NOT called', async () => {
    const onMessage = vi.fn();
    const ch = getChannelFactory('feishu')!(makeOpts({ onMessage }))! as any;
    const sendSpy = vi.spyOn(ch, 'sendMessage').mockResolvedValue(undefined);
    ch.downloadImage = vi.fn(async () => { throw Object.assign(new Error('404'), { statusCode: 404 }); });

    await ch.handleEvent(makeEvent({
      msg_type: 'image',
      content: JSON.stringify({ image_key: 'img_expired' }),
    }));

    expect(onMessage).not.toHaveBeenCalled();
    expect(sendSpy).toHaveBeenCalled();
    const [, text] = sendSpy.mock.calls[0];
    expect(text).toMatch(/^🖼️ 图没收到\(过期\)/);
  });

  it('p2p mixed 2/3 fail → failure message shows counts', async () => {
    const onMessage = vi.fn();
    const ch = getChannelFactory('feishu')!(makeOpts({ onMessage }))! as any;
    const sendSpy = vi.spyOn(ch, 'sendMessage').mockResolvedValue(undefined);
    const good = readFileSync('tests/fixtures/image-normal.png');
    ch.downloadImage = vi.fn(async (k: string) => {
      if (k === 'a' || k === 'c') throw Object.assign(new Error('404'), { statusCode: 404 });
      return good;
    });

    // post with 3 images
    const content = JSON.stringify({
      title: '',
      content: [[
        { tag: 'img', image_key: 'a' },
        { tag: 'img', image_key: 'b' },
        { tag: 'img', image_key: 'c' },
      ]],
    });
    await ch.handleEvent(makeEvent({ msg_type: 'post', content }));

    expect(onMessage).not.toHaveBeenCalled();
    const [, text] = sendSpy.mock.calls[0];
    expect(text).toMatch(/3 张图有 2 张没收到/);
  });
});
```

Also adjust the import at the top of `feishu.test.ts`: `import { readFileSync } from 'fs';`.

- [ ] **Step 2: Run — expect all failing**

```bash
npx vitest run src/channels/feishu.test.ts
```

- [ ] **Step 3: Implement `downloadImage`, wire `parseInbound` + `processImageKeys` in `handleEvent`**

In `src/channels/feishu.ts`:

a) Add `downloadImage` method to `FeishuChannel` class:

```ts
async downloadImage(imageKey: string): Promise<Buffer> {
  const res: any = await this.client.request(
    {
      method: 'GET',
      url: `/open-apis/im/v1/images/${imageKey}`,
      params: { type: 'message' },
      responseType: 'arraybuffer',
    },
    { maxContentLength: 10 * 1024 * 1024, timeout: 8000 },
  );
  return Buffer.from(res);
}
```

b) Add failure-message builder at module level:

```ts
function buildFailureMessage(
  failures: Array<{ key: string; reason: FailReason }>,
  totalImageCount: number,
): string {
  const failCount = failures.length;
  if (totalImageCount > 1 && failCount < totalImageCount) {
    return `🖼️ ${totalImageCount} 张图有 ${failCount} 张没收到，能把这些重发下吗？`;
  }
  const reason = failures[0]?.reason ?? 'expired';
  const zh = ({
    expired: '过期',
    timeout: '超时',
    too_large: '过大',
    bad_format: '格式',
    invalid_key: '过期',
  } as const)[reason];
  if (reason === 'too_large') return `🖼️ 图太大(>10MB)，能压缩后重发吗？`;
  if (reason === 'bad_format') return `🖼️ 这张图我读不了（可能损坏或格式不支持），能换一张发吗？`;
  return `🖼️ 图没收到(${zh})，能重发吗？`;
}
```

Add imports:

```ts
import { processImageKeys, type FailReason, type ImageAttachment } from '../image.js';
```

c) Replace the existing `handleEvent` body at lines ~272–364 (the whole method). Key changes:
- Make `handleEvent` async.
- Use `parseInbound(m, this.botOpenId)` instead of the inline text-only check.
- If `parsed.imageKeys.length > 0`, await `processImageKeys(parsed.imageKeys, (k) => this.downloadImage(k), logger)`.
- If `failures.length > 0`: `this.reactFail(m.message_id)` (see step 3d), `await this.sendMessage(chatId, buildFailureMessage(...))`, return without `deliver`.
- Else: `this.reactAck(m.message_id)`, `this.deliver(chatId, m.message_id, senderOpenId, parsed.text, ..., isGroup)` with a new parameter `images: attachments`.
- Log the audit line after successful processing.

Full replacement:

```ts
async handleEvent(payload: any): Promise<void> {
  const ev = payload?.event;
  if (!ev?.message) return;
  const m = ev.message;

  const senderType: string = ev.sender?.sender_type ?? '';
  const senderOpenId: string = ev.sender?.sender_id?.open_id ?? '';
  if (senderType !== 'user') { logger.debug({ senderType }, '[feishu] drop non-user'); return; }
  if (this.botOpenId && senderOpenId === this.botOpenId) { logger.debug('[feishu] drop self'); return; }
  if (!this.remember(m.message_id)) { logger.debug({ message_id: m.message_id }, '[feishu] dedup'); return; }

  const parsed = parseInbound(m, this.botOpenId);
  if (!parsed) { logger.debug({ message_type: m.message_type }, '[feishu] parseInbound dropped'); return; }

  const chatId: string = m.chat_id;
  const chatType: string = m.chat_type;

  // Group chat: enforce @bot mention
  if (chatType !== 'p2p' && !parsed.botMentioned) {
    logger.debug({ chatId }, '[feishu] group msg without bot mention');
    return;
  }

  // Strip the bot mention display text from post text (for group chats)
  let cleanedText = parsed.text;
  if (chatType !== 'p2p') {
    const botMention = (m.mentions ?? []).find((x: any) => x.id?.open_id === this.botOpenId);
    if (botMention?.key) {
      cleanedText = cleanedText.split(botMention.key).join('').trim();
    }
  }

  // Download + process images (if any)
  let attachments: ImageAttachment[] = [];
  if (parsed.imageKeys.length > 0) {
    this.reactAck(m.message_id); // 👀 immediately
    const result = await processImageKeys(
      parsed.imageKeys,
      (k) => this.downloadImage(k),
      logger,
    );
    if (result.failures.length > 0) {
      this.reactFail(m.message_id); // ❌
      const failMsg = buildFailureMessage(result.failures, parsed.imageKeys.length);
      await this.sendMessage(chatId, failMsg);
      logger.warn({ msg_id: m.message_id, failures: result.failures }, '[feishu] image failure');
      return;
    }
    attachments = result.attachments;
    logger.info({
      msg_id: m.message_id,
      image_count: attachments.length,
      total_base64_bytes: attachments.reduce((s, a) => s + a.base64.length, 0),
      est_input_tokens: attachments.length * 1568,
      feishu_keys: attachments.map((a) => a.sourceKey),
    }, '[feishu] image attached');
  } else {
    this.reactAck(m.message_id); // 👀 same as before for text
  }

  this.deliver(
    chatId,
    m.message_id,
    senderOpenId,
    cleanedText,
    payload.header?.create_time,
    chatType !== 'p2p',
    attachments,
  );
}
```

d) Implement `reactFail` (analogous to existing `reactAck`):

```ts
private async reactFail(messageId: string): Promise<void> {
  try {
    await this.client.im.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: 'X' } }, // Feishu uses "X" for ❌; fallback handled silently
    });
  } catch (err) {
    logger.debug({ err: (err as Error).message }, '[feishu] reactFail ignored');
  }
}
```

(If the exact emoji code is unknown, use `'CRY'` or any valid supported type — the critical observable behavior is that `reactFail` is called, not the specific emoji.)

e) Extend `deliver` signature:

```ts
private deliver(
  chatId: string,
  messageId: string,
  senderOpenId: string,
  content: string,
  createTime: string | undefined,
  isGroup: boolean,
  images: ImageAttachment[] = [],
): void {
  // ... existing body
  // When constructing NewMessage for onMessage:
  const msg: NewMessage = {
    id: messageId,
    chat_jid: chatId,
    sender: senderOpenId,
    sender_name: /* existing logic */,
    content,
    timestamp: /* existing */,
    images: images.length > 0 ? images : undefined,
    // ... other existing fields
  };
  this.opts.onMessage(chatId, msg);
}
```

(Preserve the rest of existing deliver logic — only add `images` field to the NewMessage object.)

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/channels/feishu.test.ts
```

Expected: all tests pass including new image pipeline tests.

- [ ] **Step 5: Commit**

```bash
git add src/channels/feishu.ts src/channels/feishu.test.ts
git commit -m "feat(feishu): wire image download + failure reply through parseInbound"
```

---

## Task 5: `router.ts` — `formatMessages` returns `{xml, images}` (TDD)

**Files:**
- Modify: `src/router.ts`
- Create or Modify: `src/router.test.ts`

- [ ] **Step 1: Check if router.test.ts exists**

```bash
ls src/router.test.ts 2>/dev/null && echo "exists" || echo "create"
```

- [ ] **Step 2: Write failing tests (create or extend `src/router.test.ts`)**

```ts
import { describe, it, expect } from 'vitest';
import { formatMessages } from './router.js';
import type { NewMessage, ImageAttachment } from './types.js';

const mkImg = (key: string): ImageAttachment => ({ mediaType: 'image/jpeg', base64: 'AAAA', sourceKey: key });

function mkMsg(content: string, images?: ImageAttachment[]): NewMessage {
  return {
    id: `id-${content}`,
    chat_jid: 'chat',
    sender: 'u',
    sender_name: 'User',
    content,
    timestamp: '2026-04-20T10:00:00Z',
    images,
  };
}

describe('formatMessages image markers', () => {
  it('no images → xml only, images: []', () => {
    const r = formatMessages([mkMsg('hello')], 'UTC');
    expect(r.xml).toContain('<message');
    expect(r.xml).not.toContain('[图');
    expect(r.images).toEqual([]);
  });

  it('single message with 2 images → [图 1] [图 2] appended', () => {
    const r = formatMessages([mkMsg('what is this?', [mkImg('k1'), mkImg('k2')])], 'UTC');
    expect(r.xml).toContain('what is this? [图 1] [图 2]');
    expect(r.images.map((i) => i.sourceKey)).toEqual(['k1', 'k2']);
  });

  it('two messages with 1 image each → globally numbered', () => {
    const r = formatMessages(
      [mkMsg('first', [mkImg('a')]), mkMsg('second', [mkImg('b')])],
      'UTC',
    );
    expect(r.xml).toMatch(/first \[图 1\].*second \[图 2\]/s);
    expect(r.images.map((i) => i.sourceKey)).toEqual(['a', 'b']);
  });

  it('mixed: one message with images, one without', () => {
    const r = formatMessages(
      [mkMsg('with', [mkImg('a')]), mkMsg('without')],
      'UTC',
    );
    expect(r.xml).toContain('with [图 1]');
    expect(r.xml).not.toContain('without [图');
    expect(r.images).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run — expect compile error (return type mismatch) or assertion failures**

```bash
npx vitest run src/router.test.ts
```

- [ ] **Step 4: Update `src/router.ts` `formatMessages` signature**

Replace the current function (lines 13-32) with:

```ts
import { Channel, NewMessage, ImageAttachment } from './types.js';
// ...
export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): { xml: string; images: ImageAttachment[] } {
  const allImages: ImageAttachment[] = [];
  let imgIdx = 0;

  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    const replyAttr = m.reply_to_message_id
      ? ` reply_to="${escapeXml(m.reply_to_message_id)}"`
      : '';
    const replySnippet =
      m.reply_to_message_content && m.reply_to_sender_name
        ? `\n  <quoted_message from="${escapeXml(m.reply_to_sender_name)}">${escapeXml(m.reply_to_message_content)}</quoted_message>`
        : '';

    const markers: string[] = [];
    for (const img of m.images ?? []) {
      imgIdx++;
      allImages.push(img);
      markers.push(`[图 ${imgIdx}]`);
    }
    const contentWithMarkers =
      markers.length > 0 ? `${m.content} ${markers.join(' ')}` : m.content;

    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}"${replyAttr}>${replySnippet}${escapeXml(contentWithMarkers)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;
  return {
    xml: `${header}<messages>\n${lines.join('\n')}\n</messages>`,
    images: allImages,
  };
}
```

- [ ] **Step 5: Update callers in `src/index.ts`**

Find every call to `formatMessages(...)` in `src/index.ts` (grep). Replace usages like:

```ts
const prompt = formatMessages(buffered, timezone);
```

with:

```ts
const { xml: prompt, images } = formatMessages(buffered, timezone);
```

Then thread `images` into the downstream call (see Task 6 for the `ContainerInput` shape).

```bash
grep -n "formatMessages(" src/index.ts
```

For each site, adapt to destructure `{ xml, images }` from the return.

- [ ] **Step 6: Run build + tests**

```bash
npm run build && npx vitest run src/router.test.ts src/channels/feishu.test.ts
```

Expected: clean build, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/router.ts src/router.test.ts src/index.ts
git commit -m "feat(router): formatMessages returns {xml, images} with [图 N] markers"
```

---

## Task 6: `ContainerInput.images` + `group-queue` IPC extension (TDD)

**Files:**
- Modify: `src/container-runner.ts`
- Modify: `src/container-runner.test.ts`
- Modify: `src/group-queue.ts`
- Modify: `src/group-queue.test.ts`

- [ ] **Step 1: Failing tests for container-runner serialization**

In `src/container-runner.test.ts`, add:

```ts
it('serializes images field in stdin ContainerInput', () => {
  // Use the existing test harness that captures stdin JSON
  const input: ContainerInput = {
    prompt: '<messages/>',
    groupFolder: 'g1',
    chatJid: 'c1',
    isMain: false,
    images: [{ mediaType: 'image/jpeg', base64: 'AAAA', sourceKey: 'k1' }],
  };
  // … existing serialize helper or spawn mock …
  const serialized = /* path under test that writes stdin */ JSON.stringify(input);
  const reparsed = JSON.parse(serialized);
  expect(reparsed.images).toHaveLength(1);
  expect(reparsed.images[0].sourceKey).toBe('k1');
});

it('omits images field when undefined (backward compat)', () => {
  const input: ContainerInput = {
    prompt: '<messages/>',
    groupFolder: 'g1',
    chatJid: 'c1',
    isMain: false,
  };
  const serialized = JSON.stringify(input);
  const reparsed = JSON.parse(serialized);
  expect(reparsed.images).toBeUndefined();
});
```

(If the existing `container-runner.test.ts` already has a stdin-capture harness, adapt these tests to its shape. If not, the point of these two tests is narrow: `ContainerInput` passes through `JSON.stringify` correctly.)

- [ ] **Step 2: Extend `ContainerInput`**

In `src/container-runner.ts` (line 37):

```ts
import type { ImageAttachment } from './types.js';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  // ... existing fields
  images?: ImageAttachment[];
}
```

No changes needed elsewhere in container-runner.ts — the stdin write is already `JSON.stringify(input)` which handles the new field.

- [ ] **Step 3: Failing tests for group-queue**

In `src/group-queue.test.ts`:

```ts
it('sendMessage writes IPC file with images field', () => {
  // setup: activate a group with a container, stub fs
  const gq = new GroupQueue(/*...*/);
  gq.markActive('jid1', 'container1', 'groupFolder1');
  const ok = gq.sendMessage('jid1', 'hello', [{ mediaType: 'image/jpeg', base64: 'AAAA', sourceKey: 'k1' }]);
  expect(ok).toBe(true);
  // read the just-written IPC file
  const files = fs.readdirSync(IPC_PATH);
  const data = JSON.parse(fs.readFileSync(path.join(IPC_PATH, files[0]), 'utf-8'));
  expect(data).toEqual({ type: 'message', text: 'hello', images: [{ mediaType: 'image/jpeg', base64: 'AAAA', sourceKey: 'k1' }] });
});

it('sendMessage rejects >8MB payload', () => {
  const gq = new GroupQueue(/*...*/);
  gq.markActive('jid1', 'container1', 'groupFolder1');
  const huge = 'A'.repeat(9 * 1024 * 1024);  // 9MB base64 string
  const ok = gq.sendMessage('jid1', 'hello', [{ mediaType: 'image/jpeg', base64: huge, sourceKey: 'k1' }]);
  expect(ok).toBe(false);
});
```

- [ ] **Step 4: Update `group-queue.ts:160`**

Replace `sendMessage`:

```ts
import type { ImageAttachment } from './types.js';

const MAX_IPC_JSON_BYTES = 8 * 1024 * 1024;

sendMessage(groupJid: string, text: string, images?: ImageAttachment[]): boolean {
  const state = this.getGroup(groupJid);
  if (!state.active || !state.groupFolder || state.isTaskContainer) return false;
  state.idleWaiting = false;

  const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
  try {
    fs.mkdirSync(inputDir, { recursive: true });
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
    const filepath = path.join(inputDir, filename);
    const tempPath = `${filepath}.tmp`;
    const payload: { type: 'message'; text: string; images?: ImageAttachment[] } = {
      type: 'message',
      text,
    };
    if (images && images.length > 0) payload.images = images;
    const body = JSON.stringify(payload);
    if (body.length > MAX_IPC_JSON_BYTES) return false;
    fs.writeFileSync(tempPath, body);
    fs.renameSync(tempPath, filepath);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Update callers of `sendMessage(jid, text)`**

```bash
grep -rn "sendMessage(" src --include="*.ts" | grep -v test
```

For each site that delivers a buffered message to a live container, pass through the images array. Most hot paths live in `src/index.ts`. Where a caller is a text-only path (e.g. scheduler, IPC watcher), leave the second argument undefined — the field is optional.

- [ ] **Step 6: Run tests + build**

```bash
npm run build && npx vitest run src/group-queue.test.ts src/container-runner.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add src/container-runner.ts src/container-runner.test.ts src/group-queue.ts src/group-queue.test.ts src/index.ts
git commit -m "feat(ipc): thread images through ContainerInput and group-queue (8MB cap)"
```

---

## Task 7: Agent-runner multimodal `MessageStream` + `drainIpcInput` (TDD)

**Files:**
- Modify: `container/agent-runner/src/index.ts`
- Create or Modify: `container/agent-runner/src/index.test.ts` (if no test file exists yet, create a minimal one that covers MessageStream + drainIpcInput in isolation)

- [ ] **Step 1: Failing tests**

Create `container/agent-runner/src/index.test.ts` (or add to an existing one):

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
// Export MessageStream and drainIpcInput from index.ts (add `export` keywords) so they are testable.
import { MessageStream, drainIpcInput, _setIpcInputDir } from './index.js';

describe('MessageStream', () => {
  it('string content when no images', async () => {
    const ms = new MessageStream();
    ms.push('hello');
    ms.end();
    const out = [];
    for await (const m of ms) out.push(m);
    expect(out[0].message.content).toBe('hello');
  });

  it('ContentBlockParam[] when images present', async () => {
    const ms = new MessageStream();
    ms.push('hello', [{ mediaType: 'image/jpeg', base64: 'AAAA', sourceKey: 'k1' }]);
    ms.end();
    const out = [];
    for await (const m of ms) out.push(m);
    expect(out[0].message.content).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
    ]);
  });
});

describe('drainIpcInput', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-'));
    _setIpcInputDir(tmpDir);
  });

  it('parses file with images field', () => {
    fs.writeFileSync(
      path.join(tmpDir, '1.json'),
      JSON.stringify({ type: 'message', text: 'hi', images: [{ mediaType: 'image/jpeg', base64: 'AAAA', sourceKey: 'k1' }] }),
    );
    const out = drainIpcInput();
    expect(out).toEqual([{ text: 'hi', images: [{ mediaType: 'image/jpeg', base64: 'AAAA', sourceKey: 'k1' }] }]);
  });

  it('parses file without images field (backward compat)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '2.json'),
      JSON.stringify({ type: 'message', text: 'hi' }),
    );
    const out = drainIpcInput();
    expect(out).toEqual([{ text: 'hi' }]);
  });
});
```

(Note: the `_setIpcInputDir` helper is a test seam — add a tiny export that lets tests override `IPC_INPUT_DIR`. Pattern: `let IPC_INPUT_DIR = '/workspace/ipc/input'; export function _setIpcInputDir(d: string) { IPC_INPUT_DIR = d; }`.)

- [ ] **Step 2: Update `MessageStream.push` signature**

In `container/agent-runner/src/index.ts` (class around line 97):

```ts
import type { MessageParam } from '@anthropic-ai/sdk/resources';

type ImageAttachment = { mediaType: 'image/jpeg'; base64: string; sourceKey: string };

export class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string, images?: ImageAttachment[]): void {
    const content: MessageParam['content'] =
      images && images.length
        ? [
            { type: 'text', text },
            ...images.map((img) => ({
              type: 'image' as const,
              source: {
                type: 'base64' as const,
                media_type: img.mediaType,
                data: img.base64,
              },
            })),
          ]
        : text;
    this.queue.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void { this.done = true; this.waiting?.(); }
  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) yield this.queue.shift()!;
      if (this.done) return;
      await new Promise<void>((r) => { this.waiting = r; });
      this.waiting = null;
    }
  }
}
```

- [ ] **Step 3: Update `drainIpcInput` return type**

Currently `drainIpcInput(): string[]`. Change to:

```ts
export type DrainedMessage = { text: string; images?: ImageAttachment[] };

export function drainIpcInput(): DrainedMessage[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();
    const out: DrainedMessage[] = [];
    for (const f of files) {
      const full = path.join(IPC_INPUT_DIR, f);
      try {
        const raw = fs.readFileSync(full, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed?.type === 'message' && typeof parsed.text === 'string') {
          const msg: DrainedMessage = { text: parsed.text };
          if (Array.isArray(parsed.images) && parsed.images.length > 0) {
            msg.images = parsed.images;
          }
          out.push(msg);
        }
      } catch { /* skip corrupt file */ }
      try { fs.unlinkSync(full); } catch {/* ignore */}
    }
    return out;
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Update `waitForIpcMessage` + its callers to handle the new return type**

Find every usage of `drainIpcInput()` (likely in `waitForIpcMessage` around line 376 and in the main loop). Previously they joined with `\n` and pushed a single string. Change to per-message push:

```ts
const messages = drainIpcInput();
if (messages.length > 0) {
  for (const m of messages) stream.push(m.text, m.images);
  continue;
}
```

(Exact integration depends on the current loop structure — keep semantics: each IPC message becomes one `stream.push()` call.)

- [ ] **Step 5: Update the initial stdin path**

Where the initial `ContainerInput` is consumed and pushed to the stream:

```ts
const input: ContainerInput = JSON.parse(await readStdin());
stream.push(input.prompt, input.images);
```

- [ ] **Step 6: Run tests + build inside container-agent-runner**

```bash
cd container/agent-runner && npm run build && npx vitest run src/
```

Expected: all tests pass; build is clean.

- [ ] **Step 7: Commit**

```bash
git add container/agent-runner/src/
git commit -m "feat(agent-runner): multimodal MessageStream + drainIpcInput with images"
```

---

## Task 8: End-to-end smoke verification

**Files:**
- Modify: `docs/superpowers/specs/2026-04-20-feishu-image-vision-design.md` (append smoke-test results)

- [ ] **Step 1: Rebuild container image**

```bash
./container/build.sh
```

Expected: clean build including updated agent-runner.

- [ ] **Step 2: Restart nanoclaw**

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

- [ ] **Step 3: Run the 6 smoke scenarios documented in the spec**

Open Feishu, find Andy's p2p chat, send:

1. A single image (no text) of a screenshot. Expected: Andy describes what's in the image.
2. Image + text "这报错怎么改". Expected: Andy responds referencing the image content.
3. In the langgraph 问题修复 group, `@阿飞-PM` + image + text. Expected: normal reply.
4. In the same group, image without `@阿飞-PM`. Expected: silent (no reply).
5. 6 images in one message. Expected: Andy processes first 5, mentions truncation.
6. A `.jpg` file that's random bytes (or rename a `.txt` to `.jpg`). Expected: `🖼️ 这张图我读不了...`

- [ ] **Step 4: Tail log to confirm audit line fires**

```bash
tail -n 50 data/logs/nanoclaw.log | grep "\[feishu\] image attached"
```

Expected: at least one entry with `image_count`, `total_base64_bytes`, `feishu_keys`.

- [ ] **Step 5: Verify no Feishu credentials in container**

```bash
container exec -it $(docker ps --filter "name=nanoclaw-" --format "{{.Names}}" | head -n1) env | grep FEISHU || echo "✅ no FEISHU env in container"
```

(Substitute your container runtime command; the point is to confirm `FEISHU_APP_ID/SECRET` are absent.)

- [ ] **Step 6: Append smoke results to spec**

At the end of the spec file, add a new section:

```markdown
## Smoke Results (YYYY-MM-DD)

| # | Scenario | Pass? | Notes |
|---|---|---|---|
| 1 | p2p single image | | |
| 2 | p2p image + text | | |
| 3 | group @+image+text | | |
| 4 | group image no @ | | |
| 5 | 6 images truncation | | |
| 6 | corrupt image | | |

Audit log: ✅/❌
Credentials isolation: ✅/❌
```

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/specs/2026-04-20-feishu-image-vision-design.md
git commit -m "docs(feishu-vision): record smoke test results"
```

---

## Self-Review

**1. Spec coverage:**

| Spec section | Task |
|---|---|
| Feishu Message Parsing (`parseInbound`) | Task 3 |
| Image Pipeline (`src/image.ts`) | Task 1 |
| `src/types.ts` extension | Task 2 |
| `src/router.ts` placeholder injection | Task 5 |
| `src/index.ts` threading | Task 5 (callers updated), Task 6 (sendMessage callers) |
| `src/group-queue.ts` IPC + 8MB cap | Task 6 |
| `src/container-runner.ts` ContainerInput | Task 6 |
| `container/agent-runner/src/index.ts` | Task 7 |
| Error handling table | Task 4 (failure reply) |
| Ack behavior (👀/❌) | Task 4 |
| Audit log | Task 4 |
| Testing (unit + integration) | Tasks 1, 3, 4, 5, 6, 7 |
| Manual smoke checklist | Task 8 |
| Security (image_key regex, 8MB cap) | Task 1 (regex), Task 6 (cap) |

**2. Placeholder scan:** No TBD / TODO / "implement similar to above" in executable steps. Task 6 Step 1 references "existing stdin-capture harness" — flagged for the executor to adapt to the real test shape, not a hand-wave (there's a concrete narrow assertion to make either way).

**3. Type consistency:**
- `ImageAttachment` defined once in `src/image.ts`, re-exported through `src/types.ts`, imported everywhere else. ✓
- `processImageKeys` signature stable across Tasks 1, 4. ✓
- `FailReason` enum values consistent: `expired | timeout | too_large | bad_format | invalid_key`. ✓
- `MessageStream.push(text, images?)` signature stable across Tasks 7 initial stdin and IPC loop. ✓
- `drainIpcInput` return type change from `string[]` → `DrainedMessage[]` — callers updated in Task 7 Step 4. ✓
