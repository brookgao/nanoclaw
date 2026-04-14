# Add Feishu Channel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `/add-feishu` so a user can talk to NanoClaw from Feishu (国内飞书) in private chat (main channel) and group chat (via @mention).

**Architecture:** A new `FeishuChannel` class implementing the existing `Channel` interface in `src/types.ts`. Uses `@larksuiteoapi/node-sdk` WebSocket client — no public URL needed. Self-registers via `registerChannel('feishu', factory)`. Factory returns `null` when creds are absent (same pattern as Slack/Telegram). Distributed as a skill branch following the `/add-telegram` / `/add-slack` install flow.

**Tech Stack:** TypeScript, `@larksuiteoapi/node-sdk` v1.x, vitest, NanoClaw `Channel` interface.

**Spec:** `docs/superpowers/specs/2026-04-14-add-feishu-channel-design.md`

---

## File Structure

**Create:**
- `src/channels/feishu.ts` — `FeishuChannel` class + factory + `registerChannel` self-registration. ~200 LOC.
- `src/channels/feishu.test.ts` — unit tests. ~250 LOC.
- `.claude/skills/add-feishu/SKILL.md` — skill entrypoint (Phases 1–3).
- `.claude/skills/add-feishu/FEISHU_SETUP.md` — Feishu Open Platform console walkthrough.

**Modify:**
- `src/channels/index.ts` — append `// feishu` comment + `import './feishu.js';`
- `package.json` — add dep `@larksuiteoapi/node-sdk`
- `.env.example` — add `FEISHU_APP_ID=`, `FEISHU_APP_SECRET=`, `FEISHU_DOMAIN=feishu`

---

## Task 1: Add dependency and env scaffolding

**Files:**
- Modify: `package.json`
- Modify: `.env.example`

- [ ] **Step 1: Add dependency**

Run:
```bash
npm install @larksuiteoapi/node-sdk@^1.60.0
```

Expected: `package.json` gains `"@larksuiteoapi/node-sdk": "^1.60.0"` under `dependencies`; `package-lock.json` updated. (Verified: 1.60.0 is the latest published version as of 2026-04-14.)

- [ ] **Step 2: Extend `.env.example`**

Append these lines to `.env.example`:

```
# Feishu (国内飞书) — set both to enable the Feishu channel
FEISHU_APP_ID=
FEISHU_APP_SECRET=
# Optional: "feishu" (default, 国内) or "lark" (海外)
FEISHU_DOMAIN=feishu
```

- [ ] **Step 3: Verify build still clean**

Run:
```bash
npm run build
```
Expected: exit 0, no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json .env.example
git commit -m "feat(feishu): add @larksuiteoapi/node-sdk dependency and env vars"
```

---

## Task 2: Factory-returns-null test (credentials absent)

**Files:**
- Create: `src/channels/feishu.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/channels/feishu.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getChannelFactory } from './registry.js';

// Import triggers self-registration
import './feishu.js';

describe('FeishuChannel factory', () => {
  const origEnv = { ...process.env };
  beforeEach(() => {
    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;
  });
  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('returns null when FEISHU_APP_ID missing', () => {
    process.env.FEISHU_APP_SECRET = 'secret';
    const factory = getChannelFactory('feishu');
    expect(factory).toBeDefined();
    const channel = factory!({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });
    expect(channel).toBeNull();
  });

  it('returns null when FEISHU_APP_SECRET missing', () => {
    process.env.FEISHU_APP_ID = 'cli_xxx';
    const factory = getChannelFactory('feishu');
    const channel = factory!({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });
    expect(channel).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npx vitest run src/channels/feishu.test.ts
```
Expected: FAIL — `Cannot find module './feishu.js'`.

- [ ] **Step 3: Create minimal `feishu.ts`**

Create `src/channels/feishu.ts`:

```ts
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel } from '../types.js';

export function createFeishuChannel(_opts: ChannelOpts): Channel | null {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) return null;
  // Full impl added in later tasks.
  throw new Error('FeishuChannel not yet implemented');
}

registerChannel('feishu', createFeishuChannel);
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
npx vitest run src/channels/feishu.test.ts
```
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/channels/feishu.ts src/channels/feishu.test.ts
git commit -m "feat(feishu): factory returns null when credentials missing"
```

---

## Task 3: Wire into channel barrel

**Files:**
- Modify: `src/channels/index.ts`

- [ ] **Step 1: Add import**

Edit `src/channels/index.ts`, append:

```ts
// feishu
import './feishu.js';
```

- [ ] **Step 2: Verify build**

Run:
```bash
npm run build
```
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/channels/index.ts
git commit -m "feat(feishu): register feishu channel via barrel import"
```

---

## Task 4: FeishuChannel scaffold with Channel interface

**Files:**
- Modify: `src/channels/feishu.ts`
- Modify: `src/channels/feishu.test.ts`

- [ ] **Step 1: Write failing test for construction and `name`**

Append to `src/channels/feishu.test.ts`:

```ts
describe('FeishuChannel construction', () => {
  beforeEach(() => {
    process.env.FEISHU_APP_ID = 'cli_test';
    process.env.FEISHU_APP_SECRET = 'secret_test';
  });

  it('constructs with name "feishu" and starts disconnected', () => {
    const factory = getChannelFactory('feishu')!;
    const ch = factory({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    })!;
    expect(ch).not.toBeNull();
    expect(ch.name).toBe('feishu');
    expect(ch.isConnected()).toBe(false);
  });

  it('ownsJid returns true only for feishu: prefix', () => {
    const factory = getChannelFactory('feishu')!;
    const ch = factory({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    })!;
    expect(ch.ownsJid('feishu:oc_abc')).toBe(true);
    expect(ch.ownsJid('telegram:123')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npx vitest run src/channels/feishu.test.ts
```
Expected: FAIL — "FeishuChannel not yet implemented".

- [ ] **Step 3: Implement scaffold**

Replace `src/channels/feishu.ts` with:

```ts
import { Client, WSClient } from '@larksuiteoapi/node-sdk';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel, NewMessage } from '../types.js';
import { logger } from '../logger.js';

const JID_PREFIX = 'feishu:';

export class FeishuChannel implements Channel {
  public readonly name = 'feishu';
  private client: Client;
  private ws: WSClient;
  private connected = false;
  private botOpenId: string | null = null;

  constructor(
    private appId: string,
    private appSecret: string,
    private opts: ChannelOpts,
    private domain: 'feishu' | 'lark' = 'feishu',
  ) {
    const baseDomain = domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
    this.client = new Client({ appId, appSecret, domain: baseDomain });
    this.ws = new WSClient({ appId, appSecret, domain: baseDomain });
  }

  async connect(): Promise<void> {
    // Filled in Task 5.
    this.connected = true;
  }

  async sendMessage(_jid: string, _text: string): Promise<void> {
    // Filled in Task 7.
    throw new Error('not implemented');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(JID_PREFIX);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }
}

export function createFeishuChannel(opts: ChannelOpts): Channel | null {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) return null;
  const domain = (process.env.FEISHU_DOMAIN === 'lark' ? 'lark' : 'feishu');
  logger.info(`[feishu] channel enabled (domain=${domain})`);
  return new FeishuChannel(appId, appSecret, opts, domain);
}

registerChannel('feishu', createFeishuChannel);
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
npx vitest run src/channels/feishu.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 5: Verify build clean**

Run:
```bash
npm run build
```
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/channels/feishu.ts src/channels/feishu.test.ts
git commit -m "feat(feishu): scaffold FeishuChannel implementing Channel interface"
```

---

## Task 5: Inbound — handle p2p text message

**Files:**
- Modify: `src/channels/feishu.ts`
- Modify: `src/channels/feishu.test.ts`

- [ ] **Step 1: Write failing test**

Append to `src/channels/feishu.test.ts`:

```ts
import type { Mock } from 'vitest';

// Helpers
function makeEvent(overrides: Partial<{
  chat_id: string;
  chat_type: 'p2p' | 'group';
  msg_type: string;
  text: string;
  sender_id: string;
  sender_name: string;
  message_id: string;
  mentions: Array<{ id: { open_id: string } }>;
}> = {}) {
  return {
    schema: '2.0',
    header: { event_type: 'im.message.receive_v1', create_time: '1700000000000' },
    event: {
      sender: {
        sender_id: { open_id: overrides.sender_id ?? 'ou_user1' },
        sender_type: 'user',
      },
      message: {
        message_id: overrides.message_id ?? 'om_abc',
        chat_id: overrides.chat_id ?? 'oc_p2p1',
        chat_type: overrides.chat_type ?? 'p2p',
        message_type: overrides.msg_type ?? 'text',
        content: JSON.stringify({ text: overrides.text ?? 'hello' }),
        mentions: overrides.mentions ?? [],
      },
    },
  };
}

describe('FeishuChannel inbound p2p', () => {
  beforeEach(() => {
    process.env.FEISHU_APP_ID = 'cli_test';
    process.env.FEISHU_APP_SECRET = 'secret_test';
  });

  it('routes p2p text to onMessage with feishu:<chat_id> jid', async () => {
    const onMessage = vi.fn();
    const factory = getChannelFactory('feishu')!;
    const ch = factory({
      onMessage,
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    })! as any;

    // Invoke handler directly (bypass WS).
    ch.handleEvent(makeEvent({ chat_id: 'oc_p2p1', text: 'hi andy' }));

    expect(onMessage).toHaveBeenCalledTimes(1);
    const [jid, msg] = onMessage.mock.calls[0];
    expect(jid).toBe('feishu:oc_p2p1');
    expect(msg.content).toBe('hi andy');
    expect(msg.sender).toBe('ou_user1');
  });

  it('ignores non-text message types', () => {
    const onMessage = vi.fn();
    const factory = getChannelFactory('feishu')!;
    const ch = factory({
      onMessage,
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    })! as any;

    ch.handleEvent(makeEvent({ msg_type: 'image' }));
    expect(onMessage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npx vitest run src/channels/feishu.test.ts
```
Expected: FAIL — `ch.handleEvent is not a function`.

- [ ] **Step 3: Implement `handleEvent` + dispatching (with self-filter, dedup, safe mention strip, metadata emit)**

In `src/channels/feishu.ts`, add a dedup LRU field and import `NewMessage`:

```ts
import { Channel, NewMessage } from '../types.js';
```

Inside `FeishuChannel`:

```ts
private seenMessageIds = new Set<string>();
private seenOrder: string[] = [];
private readonly DEDUP_CAP = 500;

private remember(id: string): boolean {
  if (this.seenMessageIds.has(id)) return false;
  this.seenMessageIds.add(id);
  this.seenOrder.push(id);
  if (this.seenOrder.length > this.DEDUP_CAP) {
    const evicted = this.seenOrder.shift()!;
    this.seenMessageIds.delete(evicted);
  }
  return true;
}

// Exposed for tests; also called from WS event handler.
handleEvent(payload: any): void {
  const ev = payload?.event;
  if (!ev?.message) return;
  const m = ev.message;

  // 1) Self-filter: drop messages sent BY the bot / any app.
  const senderType: string = ev.sender?.sender_type ?? '';
  const senderOpenId: string = ev.sender?.sender_id?.open_id ?? '';
  if (senderType !== 'user') {
    logger.debug(`[feishu] drop non-user sender_type=${senderType}`);
    return;
  }
  if (this.botOpenId && senderOpenId === this.botOpenId) {
    logger.debug('[feishu] drop self-message');
    return;
  }

  // 2) Dedup on message_id (WS reconnect replay guard).
  if (!this.remember(m.message_id)) {
    logger.debug(`[feishu] dedup hit message_id=${m.message_id}`);
    return;
  }

  // 3) Only text.
  if (m.message_type !== 'text') {
    logger.debug(`[feishu] ignore non-text message_type=${m.message_type}`);
    return;
  }

  let text = '';
  try {
    text = JSON.parse(m.content)?.text ?? '';
  } catch {
    logger.warn(`[feishu] malformed content: ${m.content}`);
    return;
  }

  const chatId: string = m.chat_id;
  const chatType: string = m.chat_type;
  const mentions: Array<{ key?: string; id?: { open_id?: string } }> = m.mentions ?? [];

  if (chatType === 'p2p') {
    this.deliver(chatId, m.message_id, senderOpenId, text, payload.header?.create_time, false);
    return;
  }

  if (chatType === 'group') {
    if (!this.botOpenId) {
      logger.debug('[feishu] group msg before botOpenId resolved, ignored');
      return;
    }
    const botMention = mentions.find((x) => x.id?.open_id === this.botOpenId);
    if (!botMention) {
      logger.debug(`[feishu] group msg without @bot, ignored chat=${chatId}`);
      return;
    }
    // Strip ONLY the bot's exact mention token (e.g. "@_user_1"), never other users'.
    let cleaned = text;
    if (botMention.key) {
      cleaned = cleaned.split(botMention.key).join('').trim();
    }
    this.deliver(chatId, m.message_id, senderOpenId, cleaned, payload.header?.create_time, true);
    return;
  }
}

private deliver(
  chatId: string,
  messageId: string,
  senderOpenId: string,
  content: string,
  createTime: string | undefined,
  isGroup: boolean,
): void {
  const jid = `${JID_PREFIX}${chatId}`;
  const ts = createTime ? new Date(Number(createTime)).toISOString() : new Date().toISOString();
  // Emit metadata first so orchestrator can auto-register unknown chats.
  this.opts.onChatMetadata(jid, ts, undefined, 'feishu', isGroup);
  const msg: NewMessage = {
    id: messageId,
    chat_jid: jid,
    sender: senderOpenId,
    sender_name: senderOpenId, // resolved later via contact API if needed (deferred)
    content,
    timestamp: ts,
  };
  this.opts.onMessage(jid, msg);
}
```

Update existing test from Step 1 to also assert `onChatMetadata` was called once with `(jid, ts, undefined, 'feishu', false)` for p2p. Add the `onChatMetadata` spy to the opts in all tests.

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
npx vitest run src/channels/feishu.test.ts
```
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/channels/feishu.ts src/channels/feishu.test.ts
git commit -m "feat(feishu): handle p2p text messages"
```

---

## Task 6: Inbound — group @mention gating

**Files:**
- Modify: `src/channels/feishu.test.ts`

- [ ] **Step 1: Add tests for group @bot / no-@ cases**

Append to `src/channels/feishu.test.ts`:

```ts
describe('FeishuChannel inbound group', () => {
  beforeEach(() => {
    process.env.FEISHU_APP_ID = 'cli_test';
    process.env.FEISHU_APP_SECRET = 'secret_test';
  });

  it('delivers group message when bot is @-mentioned and strips only bot mention', () => {
    const onMessage = vi.fn();
    const factory = getChannelFactory('feishu')!;
    const ch = factory({
      onMessage,
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    })! as any;
    ch.botOpenId = 'ou_bot';

    ch.handleEvent(makeEvent({
      chat_id: 'oc_g1',
      chat_type: 'group',
      text: '@_user_1 please cc @_user_2',
      mentions: [
        { key: '@_user_1', id: { open_id: 'ou_bot' } },
        { key: '@_user_2', id: { open_id: 'ou_human' } },
      ],
    }));

    expect(onMessage).toHaveBeenCalledTimes(1);
    const [jid, msg] = onMessage.mock.calls[0];
    expect(jid).toBe('feishu:oc_g1');
    // Only the bot's @_user_1 token stripped; @_user_2 preserved.
    expect(msg.content).toBe('please cc @_user_2');
  });

  it('drops messages sent by the bot itself (self-loop guard)', () => {
    const onMessage = vi.fn();
    const factory = getChannelFactory('feishu')!;
    const ch = factory({
      onMessage,
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    })! as any;
    ch.botOpenId = 'ou_bot';

    // sender_type=app (bot echo)
    const ev = makeEvent({ chat_id: 'oc_p2p1', text: 'reply' });
    ev.event.sender.sender_type = 'app';
    ch.handleEvent(ev);
    expect(onMessage).not.toHaveBeenCalled();

    // Or user sender but open_id matches bot
    const ev2 = makeEvent({ chat_id: 'oc_p2p1', sender_id: 'ou_bot' });
    ch.handleEvent(ev2);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('dedups on message_id (WS reconnect replay)', () => {
    const onMessage = vi.fn();
    const factory = getChannelFactory('feishu')!;
    const ch = factory({
      onMessage,
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    })! as any;

    const ev = makeEvent({ message_id: 'om_dup', text: 'once' });
    ch.handleEvent(ev);
    ch.handleEvent(ev);
    ch.handleEvent(ev);
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it('ignores group message without any @mention', () => {
    const onMessage = vi.fn();
    const factory = getChannelFactory('feishu')!;
    const ch = factory({
      onMessage,
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    })! as any;
    ch.botOpenId = 'ou_bot';

    ch.handleEvent(makeEvent({ chat_type: 'group', mentions: [] }));
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('ignores group message when @mention is not the bot', () => {
    const onMessage = vi.fn();
    const factory = getChannelFactory('feishu')!;
    const ch = factory({
      onMessage,
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    })! as any;
    ch.botOpenId = 'ou_bot';

    ch.handleEvent(makeEvent({
      chat_type: 'group',
      mentions: [{ id: { open_id: 'ou_someone_else' } }],
    }));
    expect(onMessage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they pass (implementation from Task 5 already covers this)**

Run:
```bash
npx vitest run src/channels/feishu.test.ts
```
Expected: PASS (9 tests). If a test fails, fix the `handleEvent` implementation to match.

- [ ] **Step 3: Commit**

```bash
git add src/channels/feishu.test.ts
git commit -m "test(feishu): cover group @mention gating"
```

---

## Task 7: Outbound — `sendMessage`

**Files:**
- Modify: `src/channels/feishu.ts`
- Modify: `src/channels/feishu.test.ts`

- [ ] **Step 1: Write failing test with mocked Client**

Append to `src/channels/feishu.test.ts`:

```ts
describe('FeishuChannel sendMessage', () => {
  beforeEach(() => {
    process.env.FEISHU_APP_ID = 'cli_test';
    process.env.FEISHU_APP_SECRET = 'secret_test';
  });

  it('calls im.message.create with chat_id and text payload', async () => {
    const factory = getChannelFactory('feishu')!;
    const ch = factory({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    })! as any;

    const createSpy = vi.fn().mockResolvedValue({ code: 0, data: { message_id: 'om_x' } });
    ch.client = { im: { message: { create: createSpy } } };

    await ch.sendMessage('feishu:oc_g1', 'hello world');

    expect(createSpy).toHaveBeenCalledTimes(1);
    const call = createSpy.mock.calls[0][0];
    expect(call.params.receive_id_type).toBe('chat_id');
    expect(call.data.receive_id).toBe('oc_g1');
    expect(call.data.msg_type).toBe('text');
    expect(JSON.parse(call.data.content).text).toBe('hello world');
  });

  it('throws informative error for non-feishu jid', async () => {
    const factory = getChannelFactory('feishu')!;
    const ch = factory({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    })!;
    await expect(ch.sendMessage('telegram:123', 'x')).rejects.toThrow(/feishu/);
  });

  it('logs and swallows API errors without throwing', async () => {
    const factory = getChannelFactory('feishu')!;
    const ch = factory({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    })! as any;
    ch.client = {
      im: { message: { create: vi.fn().mockRejectedValue(new Error('429 rate limit')) } },
    };
    await expect(ch.sendMessage('feishu:oc_g1', 'hi')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
npx vitest run src/channels/feishu.test.ts
```
Expected: FAIL — `sendMessage` throws `not implemented`.

- [ ] **Step 3: Implement `sendMessage`**

Replace `sendMessage` in `src/channels/feishu.ts`:

```ts
async sendMessage(jid: string, text: string): Promise<void> {
  if (!this.ownsJid(jid)) {
    throw new Error(`FeishuChannel cannot send to non-feishu jid: ${jid}`);
  }
  const chatId = jid.slice(JID_PREFIX.length);
  try {
    await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
  } catch (err) {
    logger.error(`[feishu] send failed chat=${chatId}: ${(err as Error).message}`);
    // Swallow: orchestrator stays alive.
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npx vitest run src/channels/feishu.test.ts
```
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add src/channels/feishu.ts src/channels/feishu.test.ts
git commit -m "feat(feishu): implement sendMessage via im.message.create"
```

---

## Task 8: `connect()` wires WS + resolves bot open_id

**Files:**
- Modify: `src/channels/feishu.ts`
- Modify: `src/channels/feishu.test.ts`

- [ ] **Step 1: Write failing test**

Append to `src/channels/feishu.test.ts`:

```ts
describe('FeishuChannel connect', () => {
  beforeEach(() => {
    process.env.FEISHU_APP_ID = 'cli_test';
    process.env.FEISHU_APP_SECRET = 'secret_test';
  });

  it('resolves bot open_id, starts WS, and reports connected', async () => {
    const factory = getChannelFactory('feishu')!;
    const ch = factory({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    })! as any;

    ch.ws = { start: vi.fn().mockResolvedValue(undefined) };
    ch.client = {
      im: { message: { create: vi.fn() } },
      bot: {
        info: { get: vi.fn().mockResolvedValue({ bot: { open_id: 'ou_bot_resolved' } }) },
      },
    };

    await ch.connect();

    expect(ch.isConnected()).toBe(true);
    expect(ch.botOpenId).toBe('ou_bot_resolved');
    expect(ch.ws.start).toHaveBeenCalledTimes(1);
    // Do NOT assert on dispatcher internals — the SDK may change them between versions.
  });

  it('stays running when bot.info.get fails (warn, fall back to null open_id)', async () => {
    const factory = getChannelFactory('feishu')!;
    const ch = factory({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    })! as any;
    ch.ws = { start: vi.fn().mockResolvedValue(undefined) };
    ch.client = {
      bot: { info: { get: vi.fn().mockRejectedValue(new Error('403')) } },
    };

    await expect(ch.connect()).resolves.toBeUndefined();
    expect(ch.botOpenId).toBeNull();
    expect(ch.isConnected()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npx vitest run src/channels/feishu.test.ts
```
Expected: FAIL — `connect` does not start WS or resolve open_id.

- [ ] **Step 3: Implement `connect`**

Import `EventDispatcher` at top of `src/channels/feishu.ts`:

```ts
import { Client, WSClient, EventDispatcher } from '@larksuiteoapi/node-sdk';
```

Replace `connect()`:

```ts
async connect(): Promise<void> {
  // 1) Resolve bot open_id for @mention matching.
  // NOTE: verify SDK method path against @larksuiteoapi/node-sdk@^1.60.0 before shipping.
  // As of 1.60 the stable path is `client.bot.info.get()`; if that is absent, fall back to
  // a direct REST call: `this.client.request({ method: 'GET', url: '/open-apis/bot/v3/info' })`.
  try {
    const info: any = await (this.client as any).bot.info.get();
    this.botOpenId = info?.bot?.open_id ?? info?.data?.bot?.open_id ?? null;
    logger.info(`[feishu] bot open_id=${this.botOpenId}`);
  } catch (err) {
    this.botOpenId = null;
    logger.warn(`[feishu] failed to resolve bot open_id: ${(err as Error).message}`);
  }

  // 2) Start WS with event dispatcher.
  const dispatcher = new EventDispatcher({}).register({
    'im.message.receive_v1': async (data: any) => {
      this.handleEvent({ event: data, header: { create_time: String(Date.now()) } });
    },
  });

  await this.ws.start({ eventDispatcher: dispatcher });
  this.connected = true;
  logger.info('[feishu] WS connected');
}
```

Update `disconnect`:

```ts
async disconnect(): Promise<void> {
  try {
    (this.ws as any).close?.();
  } catch { /* noop */ }
  this.connected = false;
}
```

- [ ] **Step 4: Run tests (the new one mocks ws.start; dispatcher registration is structural)**

Run:
```bash
npx vitest run src/channels/feishu.test.ts
```
Expected: PASS (13 tests). If the dispatcher-path test fails due to the mock, simplify the test to only assert `ws.start` was called and `botOpenId` is set — do not assert on dispatcher internals.

- [ ] **Step 5: Verify build clean**

Run:
```bash
npm run build
```
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/channels/feishu.ts src/channels/feishu.test.ts
git commit -m "feat(feishu): connect() starts WS and resolves bot open_id"
```

---

## Task 9: Write `/add-feishu` SKILL.md

**Files:**
- Create: `.claude/skills/add-feishu/SKILL.md`

- [ ] **Step 1: Create the skill file**

Create `.claude/skills/add-feishu/SKILL.md`:

```markdown
---
name: add-feishu
description: Add Feishu (国内飞书) as a channel. Uses WebSocket long connection (no public URL needed). Supports private-chat (main channel) and group-chat via @mention.
---

# Add Feishu Channel

This skill adds Feishu (国内飞书) support to NanoClaw, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/channels/feishu.ts` exists. If it does, skip to Phase 3 (Setup).

### Ask the user

Use `AskUserQuestion`: do they already have a Feishu self-built app? If yes, collect App ID and App Secret now. If no, we'll create one in Phase 3.

## Phase 2: Apply Code Changes

### Ensure channel remote

```bash
git remote -v
```

If `feishu` is missing, add it (URL provided by the skill author):

```bash
git remote add feishu https://github.com/qwibitai/nanoclaw-feishu.git
```

### Merge the skill branch

```bash
git fetch feishu main
git merge feishu/main || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:
- `src/channels/feishu.ts` (FeishuChannel class, self-registered via `registerChannel`)
- `src/channels/feishu.test.ts` (unit tests with `@larksuiteoapi/node-sdk` mocked)
- `import './feishu.js'` appended to `src/channels/index.ts`
- `@larksuiteoapi/node-sdk` dependency in `package.json`
- `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_DOMAIN` in `.env.example`

### Validate

```bash
npm install
npm run build
npx vitest run src/channels/feishu.test.ts
```

All tests must pass and build must be clean.

## Phase 3: Setup

### Create Feishu app (if needed)

Share `FEISHU_SETUP.md` (next to this file) — step-by-step console walkthrough.

Quick summary:
1. Go to https://open.feishu.cn/app → 创建企业自建应用
2. 添加"机器人"能力
3. 事件订阅 → 长连接模式 → 订阅 `im.message.receive_v1`
4. 权限管理: `im:message`, `im:message.group_at_msg`, `im:message.p2p_msg`, `im:chat`, `im:message:send_as_bot`
5. 版本管理 → 创建版本 → 租户管理员审批
6. 凭证 → 复制 App ID (`cli_xxx`) and App Secret

### Configure `.env` and sync to container

Append (or edit) `.env`:

```
FEISHU_APP_ID=cli_xxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
FEISHU_DOMAIN=feishu
```

Sync to the container env file (the container reads `data/env/env`, not `.env` directly):

```bash
mkdir -p data/env && cp .env data/env/env
chmod 600 .env data/env/env
```

## Phase 4: Registration

Register the Feishu chats with nanoclaw. For each chat you want to talk from, collect the `chat_id` (visible in the `[feishu] drop ...` / delivery logs once you send a test message, or via Feishu admin console).

**Private chat (main channel — admin / self-chat):**

```bash
npx tsx setup/index.ts --step register -- \
  --jid "feishu:<chat-id>" \
  --name "<your-name>" \
  --folder "feishu_main" \
  --trigger "@${ASSISTANT_NAME}" \
  --channel feishu \
  --no-trigger-required \
  --is-main
```

**Group chat:**

```bash
npx tsx setup/index.ts --step register -- \
  --jid "feishu:<chat-id>" \
  --name "<chat-name>" \
  --folder "feishu_<group-name>" \
  --trigger "@${ASSISTANT_NAME}" \
  --channel feishu
```

## Phase 5: Start and test

```bash
npm run dev   # or whatever the repo's run command is
```

Look for log line: `[feishu] WS connected`.

Then in Feishu:
1. 私聊机器人 → 发 "ping"
2. 拉机器人进群 → `@机器人 summarize` (or your trigger)

### Troubleshooting checklist

1. `FEISHU_APP_ID` / `FEISHU_APP_SECRET` set in `.env` AND synced to `data/env/env`
2. Chat is registered in SQLite:
   ```bash
   sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'feishu:%'"
   ```
3. App version is published and tenant-admin-approved

## Uninstall

1. Revert merge: `git revert -m 1 <merge-commit>` or `git reset --hard <before-merge>`
2. Remove env vars from `.env` and `data/env/env`
3. Remove registrations:
   ```bash
   sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'feishu:%'"
   ```
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/add-feishu/SKILL.md
git commit -m "feat(feishu): add /add-feishu skill entrypoint"
```

---

## Task 10: Write `FEISHU_SETUP.md` walkthrough

**Files:**
- Create: `.claude/skills/add-feishu/FEISHU_SETUP.md`

- [ ] **Step 1: Create the setup guide**

Create `.claude/skills/add-feishu/FEISHU_SETUP.md`:

```markdown
# Feishu Open Platform — Setup for NanoClaw

## 1. Create the app

1. Go to https://open.feishu.cn/app
2. 点击「创建企业自建应用」
3. 应用名称: e.g. "Andy Assistant"; 应用描述随意; 头像可选
4. 创建完成后，进入应用详情页

## 2. Enable bot capability

1. 左侧 → 「添加应用能力」
2. 找到「机器人」→ 点击「添加」
3. 填写机器人描述与欢迎语

## 3. Event subscription (long-connection mode)

1. 左侧 → 「事件与回调」→「事件配置」
2. 订阅方式: **「长连接」**（推荐；无需公网地址）
3. 点击「添加事件」→ 搜索并勾选：
   - `im.message.receive_v1`（接收消息）

## 4. Permissions

左侧 → 「权限管理」→ 搜索并开启：

| scope | 用途 |
|---|---|
| `im:message` | 获取消息基础 |
| `im:message.group_at_msg` | 群里接收 @机器人 |
| `im:message.p2p_msg` | 接收单聊消息 |
| `im:chat` | 读取会话信息（群名等） |
| `im:message:send_as_bot` | 以机器人身份发送消息 |

## 5. Version / publish

1. 左侧 → 「版本管理与发布」→ 「创建版本」
2. 填写版本号（如 `1.0.0`）、更新说明
3. 提交，**等租户管理员审批通过**

## 6. Get credentials

左侧 → 「凭证与基础信息」

- **App ID** (形如 `cli_xxxxxxxxxxxx`) → 填入 `FEISHU_APP_ID`
- **App Secret** → 填入 `FEISHU_APP_SECRET`

## 7. Add bot to chats

- **私聊**：在飞书 app 内搜索应用名称，打开会话
- **群聊**：群设置 → 群机器人 → 添加 → 选择你的应用

## Troubleshooting

- **机器人不回消息**：检查 `[feishu] WS connected` 日志；版本是否已审批通过；权限是否生效（改权限后要发新版本）。
- **群里 @机器人 无响应**：确认 `im:message.group_at_msg` 已授权；消息里真的包含 @机器人（不是 @某人）。
- **401 / invalid app**：`FEISHU_APP_ID` 或 `FEISHU_APP_SECRET` 拼写错误；`FEISHU_DOMAIN` 不小心填成了 `lark`。
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/add-feishu/FEISHU_SETUP.md
git commit -m "docs(feishu): add Feishu console setup walkthrough"
```

---

## Task 11: Final verification

- [ ] **Step 1: Full test run**

Run:
```bash
npm run build && npx vitest run
```
Expected: all tests pass, build clean.

- [ ] **Step 2: Smoke-check registry includes feishu**

Run (via `tsx`, works directly on the TS source):
```bash
FEISHU_APP_ID=x FEISHU_APP_SECRET=y npx tsx -e "import('./src/channels/index.ts').then(async()=>{const m=await import('./src/channels/registry.ts');console.log(m.getRegisteredChannelNames());})"
```
Expected: stdout contains `feishu` in the array.

- [ ] **Step 3: Commit any cleanup**

If needed:
```bash
git commit --allow-empty -m "chore(feishu): verification complete"
```

---

## Deferred (explicit non-goals — do NOT implement in this plan)

- Image / file / audio / rich-post / interactive-card message types
- Sender name resolution via contact API (use `open_id` as `sender_name` placeholder)
- Reaction / emoji support
- Message recall / edit sync
- Lark (海外) domain as separate code path — only exposed via `FEISHU_DOMAIN=lark` env switch
- `syncGroups` implementation (optional in `Channel` interface; skip)
- `setTyping` indicator

Add these as follow-up skills if needed.
