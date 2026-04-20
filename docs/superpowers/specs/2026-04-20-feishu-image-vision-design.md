# Feishu Image Vision — Design Spec

**Date:** 2026-04-20
**Status:** Ready for plan
**Owner:** brookgao
**Affects:** `src/channels/feishu.ts`, `src/image.ts` (new), `src/router.ts`, `src/types.ts`, `src/index.ts`, `src/group-queue.ts`, `src/container-runner.ts`, `container/agent-runner/src/index.ts`, `package.json`

## Problem

NanoClaw's Feishu channel currently drops every non-text message at `src/channels/feishu.ts:296`. When a user sends a screenshot with a question ("this is crashing the dev server, see screenshot") as a Feishu `post` (rich text) message, the bot stays silent — not because it declines to answer, but because the message never reaches the agent pipeline. The bot acquires a reputation for randomly ignoring messages.

We want the Andy agent to see images sent via Feishu and reason over them as multimodal input.

## Scope

**In:**

- Feishu message types `post` (rich text with `tag:text` / `tag:at` / `tag:img`) and `image` (standalone image)
- Up to 5 images per message (truncate + notify on overflow)
- Host-side download, resize, JPEG re-encode, base64 injection as `ContentBlockParam` into the Claude Agent SDK
- Explicit user-visible failure messages when image fetch fails

**Out:**

- `file`, `audio`, `video`, `sticker` message types
- OCR / image pre-processing beyond resize
- Long-term image archival
- Vision benchmark testing for the model itself
- Changes to the group-chat `@mention` requirement (images in group chat still need bot mention to trigger)

## Key Decisions (recorded Q&A)

| # | Decision |
|---|---|
| Q1 | Support `post` + `image` message types (B) |
| Q2 | Preprocess with `sharp`: resize long edge to 1568px, JPEG q85 with mozjpeg; max 5 images per message |
| Q3 | On ANY image failure (download / size / format), reply `🖼️ 图没收到({cause})，能重发吗？` and skip the message entirely. Do not invoke the agent with partial content |
| Q4 | Current batch carries images; historical replay handled automatically by SDK transcript (no custom replay logic) |
| Q5 | Image bytes live in the IPC JSON payload (stdin + `/workspace/ipc/input/` files). No new bind-mount, no host-temp file write. Images are base64-only inside the SDK turn; Read-tool re-inspection is out of scope for this iteration |
| Approach | Sidecar (`images?: ImageAttachment[]` threaded parallel to `text`) — not schema-unification. Keeps pure-text paths untouched |

## Architecture

```mermaid
flowchart LR
  A[Feishu WS event<br/>post / image] --> B[feishu.ts<br/>parseInbound]
  B -->|text + imageKeys| C[image.ts<br/>processImageKeys]
  C -->|ImageAttachment[]| D[onMessage<br/>→ index.ts]
  D -->|buffer| E{container alive?}
  E -->|no| F[container-runner.ts<br/>stdin ContainerInput<br/>with images]
  E -->|yes| G[group-queue.ts<br/>IPC file<br/>with images]
  F --> H[agent-runner.ts<br/>MessageStream.push]
  G --> H
  H -->|ContentBlockParam[]| I[Claude Agent SDK]

  C -.failures.-> J[feishu.ts sendMessage<br/>'🖼️ 图没收到...']

  style C fill:#ffe4b5
  style H fill:#ffe4b5
  style J fill:#ffcccc
```

**Invariants:**

1. Pure-text messages follow the existing code path with zero behavioral change
2. Feishu `tenant_access_token` and app credentials never leave the host
3. Image bytes are not persisted beyond the current SDK session
4. `image_key` values are sanitized before any filesystem or HTTP use

## Feishu Message Parsing

### Input shapes

**`image` message:**

```json
{
  "message_type": "image",
  "content": "{\"image_key\":\"img_v3_...\"}"
}
```

**`post` message:** nested `content` is a 2-D array (`paragraphs × segments`), each segment has a `tag`:

```json
{
  "message_type": "post",
  "content": "{\"title\":\"\",\"content\":[[{\"tag\":\"text\",\"text\":\"...\"},{\"tag\":\"at\",\"user_id\":\"ou_...\"},{\"tag\":\"img\",\"image_key\":\"img_v3_...\"}]]}"
}
```

### Parser

Add to `feishu.ts`:

```ts
type ParsedInbound = {
  text: string;
  imageKeys: string[];
  botMentioned: boolean;
};

function parseInbound(m: FeishuMessage, botOpenId: string): ParsedInbound | null;
```

Extraction rules:

| msg_type | text source | image source |
|---|---|---|
| `text` | `content.text` | (none) |
| `image` | `""` | `content.image_key` |
| `post` | concat of all `tag:text` segments (paragraphs separated by `\n`); `tag:at` substituted with `@name` where `name` is looked up in the event's top-level `mentions[]` array (fallback to `user_id` if not present), omitted entirely when the `user_id` equals the bot's own `open_id`; `tag:code_block`/`tag:a` kept inline as their text content; unknown tags ignored | all `tag:img.image_key` values, in document order |
| other | — | — (drop silently) |

Limits:

- `imageKeys` truncated to 5, with `\n[系统: 本条消息含 N 张图，仅处理前 5 张]` appended to `text` when truncation occurred
- `imageKeys` that fail `/^[a-zA-Z0-9_-]+$/` are dropped, logged `error`
- Empty `text` + zero `imageKeys` → discard whole message, no ack

### Group chat routing

`post` and `image` messages in group chat require the existing `@mention bot` condition. Without it, drop silently (matches text-message behavior).

## Image Pipeline — `src/image.ts` (new)

### Public surface

```ts
export type ImageAttachment = {
  mediaType: 'image/jpeg';   // always JPEG after re-encode
  base64: string;
  sourceKey: string;
};

export async function processImageKeys(
  imageKeys: string[],
  downloader: (key: string) => Promise<Buffer>,  // injected by feishu.ts
  logger: Logger,
): Promise<{ attachments: ImageAttachment[]; failures: Array<{ key: string; reason: FailReason }> }>;

type FailReason = 'expired' | 'timeout' | 'too_large' | 'bad_format' | 'invalid_key';
```

### Download

`feishu.ts` exposes a `downloadImage(key: string): Promise<Buffer>` helper that calls:

```ts
this.client.request({
  method: 'GET',
  url: `/open-apis/im/v1/images/${key}`,
  params: { type: 'message' },
  responseType: 'arraybuffer',
}, { maxContentLength: 10 * 1024 * 1024, timeout: 8000 });
```

The `@larksuiteoapi/node-sdk` Client auto-manages `tenant_access_token`.

### Preprocessing

```ts
await sharp(inputBuf)
  .rotate()
  .resize(1568, 1568, { fit: 'inside', withoutEnlargement: true })
  .jpeg({ quality: 85, mozjpeg: true })
  .toBuffer();
```

- Any input format → JPEG out
- GIF: sharp's default behavior keeps the first frame
- `rotate()` applies EXIF orientation

### Concurrency & failure

- Up to 5 images downloaded+processed in parallel (`Promise.all` with per-image try/catch)
- Each failure becomes one entry in `failures[]` with a `FailReason` enum
- Any `failures.length > 0` triggers the caller's failure path — we never deliver partial attachments

## Data Flow — 5 File Changes

### `src/types.ts` — extend NewMessage

```ts
export interface NewMessage {
  // ... existing fields
  images?: ImageAttachment[];
}
```

Re-export `ImageAttachment` from here so `image.ts`, `router.ts`, `container-runner.ts`, and `agent-runner` all import from one place.

### `src/router.ts` — `formatMessages` returns images

```ts
export function formatMessages(messages: NewMessage[]): { xml: string; images: ImageAttachment[] };
```

For each message, append `[图 N]` markers (globally incrementing across the batch) to its text, in the order images appear in `m.images`. Aggregate all images into a single flat array in the same order.

### `src/index.ts` — plumb images to container-runner

`runAgent()` now passes `images` into `ContainerInput`:

```ts
const { xml, images } = formatMessages(buffered);
await runContainerAgent(group, { prompt: xml, images, ...otherFields }, ...);
```

### `src/group-queue.ts` — IPC extended

```ts
sendMessage(groupJid: string, text: string, images?: ImageAttachment[]): boolean;
```

Written IPC file shape: `{ type: 'message', text, images? }`. Reject (return `false`) if the serialized JSON exceeds **8 MB**. On rejection the caller (`feishu.ts`) sends `消息体过大（含图），请分次发送`.

### `src/container-runner.ts` — ContainerInput extended

```ts
export interface ContainerInput {
  // ... existing fields
  images?: ImageAttachment[];
}
```

No additional bind-mounts. `images` ride inside the stdin ContainerInput JSON for the first message, and inside IPC files for subsequent messages.

### `container/agent-runner/src/index.ts` — multimodal MessageStream

```ts
class MessageStream {
  push(text: string, images?: ImageAttachment[]): void {
    const content: MessageParam['content'] =
      images && images.length
        ? [
            { type: 'text', text },
            ...images.map(img => ({
              type: 'image' as const,
              source: { type: 'base64' as const, media_type: img.mediaType, data: img.base64 },
            })),
          ]
        : text;
    this.queue.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null });
    // ... existing notify
  }
}
```

`drainIpcInput()` return type changes from `string[]` to `Array<{text: string; images?: ImageAttachment[]}>`. `waitForIpcMessage()` stops joining with `\n` — instead, each drained message becomes a separate `MessageStream.push()`, i.e., one SDK user turn per IPC message. This keeps image→text alignment intact.

### Container respawn / SDK session resume

No host-side replay logic needed. Claude Agent SDK persists `ContentBlockParam[]` content in its JSONL transcript. On resume (`resume: sessionId` option), the SDK rehydrates full multimodal history. `parseTranscript()` already handles `content` as either a string or an array of blocks (`container/agent-runner/src/index.ts:263-265`).

PreCompact may summarize image blocks to `[image]` text — SDK internal behavior, acceptable.

## Error Handling

| Scenario | Trigger | User-visible | Log level |
|---|---|---|---|
| HTTP 403/404 (expired key) | image.ts download | `🖼️ 图没收到(过期)，能重发一下吗？` | warn |
| Download timeout (>8s) | image.ts | `🖼️ 图没收到(超时)，能重发吗？` | warn |
| Download >10MB | axios maxContentLength | `🖼️ 图太大(>10MB)，能压缩后重发吗？` | info |
| sharp decode failure | image.ts | `🖼️ 这张图我读不了（可能损坏或格式不支持），能换一张发吗？` | warn |
| `image_key` regex rejected | image.ts sanitize | (treat as expired) | error |
| >5 images in one message | image.ts truncate | agent processes first 5; prompt carries `[系统: 本条消息含 N 张图，仅处理前 5 张]` | info |
| IPC file >8MB | group-queue.ts | `消息体过大（含图），请分次发送` | warn |
| `post` content JSON malformed | feishu.ts parseInbound | silent drop (matches current behavior) | warn |
| Mixed success (2/5 fail) | image.ts | `🖼️ 5 张图有 2 张没收到，能把这些重发下吗？` (show counts, not keys) | warn |

### Ack behavior (Feishu reaction)

- Upon message receipt with images: reply with `👀` reaction immediately (before download)
- On success: proceed to deliver + existing flow
- On any failure: change reaction to `❌` and send the failure text

### Audit log

Successful image batch emits:

```ts
logger.info({
  msg_id, image_count, total_base64_bytes,
  est_input_tokens: image_count * 1568,
  feishu_keys: images.map(i => i.sourceKey),
}, '[feishu] image attached');
```

No rate limit / budget cap in this iteration — logs-only observability.

### Accepted trade-offs

- No retry on download failure — prefer fast fail + user resend
- No persistent message buffer across nanoclaw restarts
- No handling of Feishu message recall (existing text path also ignores recall)

## Dependencies

- `sharp@^0.34` added to host `package.json`. Agent SDK already declares `@img/sharp-*` as optional peer dependencies, so platform binaries are available via npm dedup.
- No new deps in `container/agent-runner/package.json`.
- `@larksuiteoapi/node-sdk` — existing.

## Testing

### Unit tests

**`src/image.test.ts` (new, ~15 cases):**

Mock `downloader` with `vi.fn()`. Do NOT mock `sharp` — use real fixtures.

- Normal JPEG/PNG/GIF → JPEG output
- 3000×3000 → resized ≤1568px (verify by re-reading output with sharp metadata)
- GIF first-frame extraction
- 403, timeout, >10MB, decode failure all land in `failures[]`
- `image_key` regex rejection skips the HTTP call
- Mixed success/failure across 5 concurrent downloads
- Empty input → empty result
- `sourceKey` preserved in output

**`src/channels/feishu.test.ts` (extend):**

- `image` type (p2p) with valid key → onMessage receives `images[1]`, text `""`
- `post` with text+at+img → text preserves non-bot `@name`, images length matches
- `post` text-only → `images` undefined, text path unchanged
- `post` with 7 images → truncated to 5 + truncation marker in text
- `post` with image fetch failure → `sendMessage` called with `🖼️`, `onMessage` NOT called
- `post` in group chat without bot @mention → `onMessage` NOT called
- Malformed `post` JSON → warn logged, `onMessage` NOT called

**`src/router.test.ts` (extend):**

- Empty batch images → xml unchanged from current behavior
- Single message with 2 images → `[图 1] [图 2]` appended to that message's text
- Two messages each with 1 image → `[图 1]` in msg 1, `[图 2]` in msg 2, global counter

### Integration tests

**`src/container-runner.test.ts`:**

- ContainerInput with images → serialized stdin JSON contains `images` field
- ContainerInput without images → `images` field absent (backward compat)

**`container/agent-runner/*.test.ts`:**

- `MessageStream.push('hello', [img])` → queued `SDKUserMessage.message.content` is `[{type:'text'}, {type:'image', source:{type:'base64',...}}]`
- `MessageStream.push('hello')` without images → `content === 'hello'` (string)
- `drainIpcInput()` parses IPC files with and without `images` field (backward compat)

**`src/index.test.ts`:**

- Buffer flush with images → `runContainerAgent` called with `input.images` populated
- `group-queue.sendMessage` with images → IPC file contains `images` field

### Manual smoke checklist (`test-checklist.md` alongside this spec, run before declaring done)

1. p2p: send single image, no text → Andy describes image
2. p2p: image + text "this is the error" → Andy reasons over both
3. Group chat with `@Andy`: image + text → Andy replies normally
4. Group chat, image WITHOUT `@Andy` → no response
5. Send 6 images → Andy processes first 5, mentions truncation
6. Send corrupted `.jpg` (random bytes) → Andy replies `🖼️ 这张图我读不了...`

Acceptance: all 6 pass AND `logs/nanoclaw.log` shows `[feishu] image attached` entries with populated `feishu_keys`.

### Out of test scope

- Claude model vision answer quality
- Exhaustive `post` tag variants (formula, emoji, code_block) — one "unknown tag tolerated" test covers the forward-compat case
- Token-cost benchmarks — logs-only observability for now

## Security

| Risk | Mitigation |
|---|---|
| `image_key` path injection | `/^[a-zA-Z0-9_-]+$/` sanitize in `image.ts` before any HTTP or filesystem use |
| IPC JSON bloat / memory pressure | Hard cap 8MB per IPC file; reject with user-visible message |
| Credentials exfiltration to container | All Feishu auth stays on host; container receives only pre-encoded base64 bytes |
| Image content sent to third parties | Claude API (Anthropic) is the only external recipient — same trust boundary as existing text messages |

## Open Questions

None remaining from the Q&A cycle. The writing-plans phase may surface implementation-level questions (ordering of commits, feature flag for staged rollout, etc.) but no architectural gaps remain.

## Acceptance Criteria

- Unit tests pass (`npm test`)
- Manual smoke checklist passes all 6 items
- `logs/nanoclaw.log` contains `[feishu] image attached` entries after smoke test
- Pure-text message round-trip unchanged (regression test: current feishu.test.ts text cases still pass unchanged)
- No Feishu credentials observable inside any agent container (`docker exec ... env` contains no `FEISHU_*`)
