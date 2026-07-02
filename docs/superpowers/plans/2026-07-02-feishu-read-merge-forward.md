# 阿飞读合并转发聊天记录 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 NanoClaw 飞书通道把合并转发（merge_forward）消息展开成文字转录 + 内联图片，喂给 agent。

**Architecture:** 飞书「获取指定消息内容」接口在拉取 merge_forward 消息时，`data.items` 已返回 [容器 + N 条子消息]，现有代码只取 `items[0]` 丢掉了子消息。新增一个纯函数 `planForwardExpansion`（决定渲染哪些子消息、收哪些图，做上限裁剪）+ 一个类方法 `expandMergeForward`（解析发件人名、下载图片、拼装转录），在两个入口接上：群里回复 merge_forward 并 @阿飞（复用已返回的 items）、私聊直接转发（补一次 GET）。

**Tech Stack:** TypeScript, Node, vitest, `@larksuiteoapi/node-sdk`（`this.client`），`sharp`（经 `processImageKeys`）。

## Global Constraints

- 语言 TypeScript，测试用 vitest；测试文件 `src/channels/feishu.test.ts`，复用现有 `makeEvent` / `makeOpts` / mock 风格。
- 图片下载走现有 `downloadImage(messageId, imageKey)` + `processImageKeys`，产物类型 `ImageAttachment = { mediaType: 'image/jpeg'; base64: string; sourceKey: string }`。
- 上限（模块常量，写在 `src/channels/feishu.ts`）：`MAX_FORWARD_IMAGES = 10`、`MAX_FORWARD_MESSAGES = 200`、`MAX_FORWARD_CHARS = 8000`。
- 不改动非 merge_forward 消息的现有行为（回归测试保护 `p2p text` / `image` / `file` / `post` 路径）。
- 不引入新依赖。commit message 用 `feat(feishu):` / `test(feishu):` 前缀，中文描述可。
- 构建排除 `*.test.ts`（已配置），最终以 `npm run build` + `npx vitest run src/channels/feishu.test.ts` 为验证。

---

## Task 1: [硬门控] 实测阿飞对跨会话子消息的读权限（非 TDD，先验）

**这是唯一可能推翻整个方案的点。必须最先做。若失败 → 停下同步用户，不继续后续任务。**

**Files:** 无（纯验证，可把结论追加到 spec 文档末尾）。

- [ ] **Step 1: 找到那条合并转发消息的 message_id**

截图里用户「回复」了合并转发消息，回复消息已入库，其 `reply_to_message_id` 就是 merge_forward 的 id。

```bash
DB=$(find /Users/admin/Desktop/vibe-coding/nanoclaw -name 'messages.db' -not -path '*/node_modules/*' | head -1)
echo "DB=$DB"
sqlite3 "$DB" "SELECT id, sender_name, substr(content,1,40), reply_to_message_id FROM messages WHERE chat_jid LIKE 'feishu:%' AND reply_to_message_id IS NOT NULL ORDER BY timestamp DESC LIMIT 20;"
```
预期：能看到「你能读到这段聊天记录吗」这条，取它的 `reply_to_message_id`（形如 `om_xxx`）作为 `MF_ID`。
（若库里查不到，退而用 feishu 日志：`grep -r "merge_forward" <nanoclaw 日志目录>` 找 message_id。）

- [ ] **Step 2: 用阿飞机器人自己的 tenant token curl 该消息**

```bash
# 取阿飞 app 凭据（.env 或 onecli）——必须是 nanoclaw 飞书 bot 的 APP_ID/SECRET
APP_ID=$(grep -E '^FEISHU_APP_ID=' /Users/admin/Desktop/vibe-coding/nanoclaw/.env | cut -d= -f2)
APP_SECRET=$(grep -E '^FEISHU_APP_SECRET=' /Users/admin/Desktop/vibe-coding/nanoclaw/.env | cut -d= -f2)
TOKEN=$(curl -s -X POST 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal' \
  -H 'Content-Type: application/json' \
  -d "{\"app_id\":\"$APP_ID\",\"app_secret\":\"$APP_SECRET\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["tenant_access_token"])')
MF_ID=<上一步拿到的 om_xxx>
curl -s "https://open.feishu.cn/open-apis/im/v1/messages/$MF_ID" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```
（若 `.env` 已迁移到 OneCLI vault，用 `onecli` 取对应 secret 注入上面两个变量。）

- [ ] **Step 3: 判读结果 — 门控**

检查返回的 `data.items`：
- ✅ **通过**：`items` 有多条（1 条 `msg_type:merge_forward` 容器 + N 条子消息），且子消息 `body.content` 是**真实内容**（不是占位符），字段 `sender.id`、`create_time`、`upper_message_id`、`msg_type` 齐全 → 记录到 spec，继续 Task 2。
- ❌ **失败**：只返回容器占位符 / 报权限错（`code != 0`，如 230002/permission denied）/ 子消息内容为空 → **立即停下，把返回原文同步用户**，走 spec 里的降级（保持现状，提示用户粘贴文字/截图）。不做后续任务。

---

## Task 2: 常量 + 纯函数 `planForwardExpansion`

**Files:**
- Modify: `src/channels/feishu.ts`（新增常量 + `ForwardItem`/`ForwardPlan` 类型 + `planForwardExpansion` 导出函数；紧跟在 `formatQuotedParent` 之后，约 `:507` 后）
- Test: `src/channels/feishu.test.ts`（新增 `describe('planForwardExpansion')`）

**Interfaces:**
- Consumes: `parseInbound`（已存在，用于 post/text 复用）、`FeishuMention`（已存在，`:350`）。
- Produces:
  ```ts
  export const MAX_FORWARD_IMAGES = 10;
  export const MAX_FORWARD_MESSAGES = 200;
  export const MAX_FORWARD_CHARS = 8000;

  export type ForwardItem = {
    message_id?: string;
    msg_type?: string;
    create_time?: string;
    sender?: { id?: string };
    body?: { content?: string };
    mentions?: FeishuMention[];
  };

  export type ForwardPlan = {
    lines: Array<{ senderOpenId: string; text: string }>;
    imageRequests: Array<{ messageId: string; imageKey: string }>;
    truncated: { messages: boolean; imagesDropped: number };
  };

  export function planForwardExpansion(
    items: ForwardItem[],
    botOpenId: string | null,
    limits?: { maxMessages?: number; maxChars?: number; maxImages?: number },
  ): ForwardPlan;
  ```

- [ ] **Step 1: 写失败测试**

在 `feishu.test.ts` 顶部 import 处加入 `planForwardExpansion`（与现有 `parseInbound, formatQuotedParent` 同一行 import）。新增：

```ts
import {
  parseInbound,
  formatQuotedParent,
  planForwardExpansion,
} from './feishu.js';

describe('planForwardExpansion', () => {
  const txt = (id: string, ct: string, sender: string, text: string) => ({
    message_id: id,
    msg_type: 'text',
    create_time: ct,
    sender: { id: sender },
    body: { content: JSON.stringify({ text }) },
  });

  it('drops the merge_forward container, keeps children sorted by create_time', () => {
    const plan = planForwardExpansion(
      [
        { message_id: 'mf', msg_type: 'merge_forward', create_time: '1', body: { content: '{"content":"Merged and Forwarded Message"}' } },
        txt('c2', '3', 'ou_b', '第二条'),
        txt('c1', '2', 'ou_a', '第一条'),
      ],
      null,
    );
    expect(plan.lines).toEqual([
      { senderOpenId: 'ou_a', text: '第一条' },
      { senderOpenId: 'ou_b', text: '第二条' },
    ]);
    expect(plan.truncated).toEqual({ messages: false, imagesDropped: 0 });
  });

  it('collects image requests with child message_id and marks [图片]', () => {
    const plan = planForwardExpansion(
      [
        { message_id: 'mf', msg_type: 'merge_forward', create_time: '1' },
        { message_id: 'ci', msg_type: 'image', create_time: '2', sender: { id: 'ou_a' }, body: { content: JSON.stringify({ image_key: 'img_1' }) } },
      ],
      null,
    );
    expect(plan.lines[0]).toEqual({ senderOpenId: 'ou_a', text: '[图片]' });
    expect(plan.imageRequests).toEqual([{ messageId: 'ci', imageKey: 'img_1' }]);
  });

  it('renders file and unknown types as placeholders', () => {
    const plan = planForwardExpansion(
      [
        { message_id: 'cf', msg_type: 'file', create_time: '2', sender: { id: 'ou_a' }, body: { content: JSON.stringify({ file_name: 'spec.pdf' }) } },
        { message_id: 'cs', msg_type: 'share_chat', create_time: '3', sender: { id: 'ou_b' }, body: { content: '{}' } },
      ],
      null,
    );
    expect(plan.lines[0].text).toBe('[文件: spec.pdf]');
    expect(plan.lines[1].text).toBe('[share_chat]');
  });

  it('caps image downloads at maxImages and reports imagesDropped', () => {
    const items = [{ message_id: 'mf', msg_type: 'merge_forward', create_time: '0' } as any];
    for (let i = 0; i < 5; i++)
      items.push({ message_id: `ci${i}`, msg_type: 'image', create_time: String(i + 1), sender: { id: 'ou_a' }, body: { content: JSON.stringify({ image_key: `k${i}` }) } });
    const plan = planForwardExpansion(items, null, { maxImages: 2 });
    expect(plan.imageRequests).toHaveLength(2);
    expect(plan.truncated.imagesDropped).toBe(3);
  });

  it('caps message count at maxMessages and marks truncated', () => {
    const items = [{ message_id: 'mf', msg_type: 'merge_forward', create_time: '0' } as any];
    for (let i = 0; i < 5; i++) items.push(txt(`c${i}`, String(i + 1), 'ou_a', `m${i}`));
    const plan = planForwardExpansion(items, null, { maxMessages: 3 });
    expect(plan.lines).toHaveLength(3);
    expect(plan.truncated.messages).toBe(true);
  });

  it('returns empty for container-only / empty items', () => {
    expect(planForwardExpansion([], null).lines).toEqual([]);
    expect(
      planForwardExpansion([{ message_id: 'mf', msg_type: 'merge_forward', create_time: '1' }], null).lines,
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/channels/feishu.test.ts -t planForwardExpansion`
Expected: FAIL —「planForwardExpansion is not a function / not exported」。

- [ ] **Step 3: 实现纯函数**

在 `src/channels/feishu.ts` 中 `formatQuotedParent` 函数结束之后（约 `:507`）插入：

```ts
export const MAX_FORWARD_IMAGES = 10;
export const MAX_FORWARD_MESSAGES = 200;
export const MAX_FORWARD_CHARS = 8000;

export type ForwardItem = {
  message_id?: string;
  msg_type?: string;
  create_time?: string;
  sender?: { id?: string };
  body?: { content?: string };
  mentions?: FeishuMention[];
};

export type ForwardPlan = {
  lines: Array<{ senderOpenId: string; text: string }>;
  imageRequests: Array<{ messageId: string; imageKey: string }>;
  truncated: { messages: boolean; imagesDropped: number };
};

// Pure: decide which forwarded children to render, which images to fetch, and
// apply size caps. No I/O — name resolution & image download happen in the
// class method expandMergeForward().
export function planForwardExpansion(
  items: ForwardItem[],
  botOpenId: string | null,
  limits?: { maxMessages?: number; maxChars?: number; maxImages?: number },
): ForwardPlan {
  const maxMessages = limits?.maxMessages ?? MAX_FORWARD_MESSAGES;
  const maxChars = limits?.maxChars ?? MAX_FORWARD_CHARS;
  const maxImages = limits?.maxImages ?? MAX_FORWARD_IMAGES;

  // Drop all merge_forward containers (outer + any nested) → leaf messages only.
  const children = (items ?? [])
    .filter((it) => it && it.msg_type !== 'merge_forward')
    .sort((a, b) => Number(a.create_time ?? 0) - Number(b.create_time ?? 0));

  const lines: ForwardPlan['lines'] = [];
  const imageRequests: ForwardPlan['imageRequests'] = [];
  let imagesDropped = 0;
  let chars = 0;
  let messagesTruncated = false;

  const collectImage = (messageId: string | undefined, key: string) => {
    if (imageRequests.length < maxImages && messageId) {
      imageRequests.push({ messageId, imageKey: key });
    } else {
      imagesDropped++;
    }
  };

  for (const child of children) {
    if (lines.length >= maxMessages) {
      messagesTruncated = true;
      break;
    }
    const senderOpenId = child.sender?.id ?? '';
    const msgType = child.msg_type ?? '';
    const content = child.body?.content ?? '';
    let text: string;

    if (msgType === 'text' || msgType === 'post') {
      const parsed = parseInbound({ message_type: msgType, content, mentions: child.mentions ?? [] }, botOpenId);
      text = parsed?.text || `[${msgType}]`;
      for (const key of parsed?.imageKeys ?? []) collectImage(child.message_id, key);
    } else if (msgType === 'image') {
      text = '[图片]';
      try {
        const key = JSON.parse(content)?.image_key;
        if (key) collectImage(child.message_id, key);
      } catch {
        /* keep placeholder */
      }
    } else if (msgType === 'file') {
      let name = 'unknown';
      try {
        name = JSON.parse(content)?.file_name ?? 'unknown';
      } catch {
        /* keep default */
      }
      text = `[文件: ${name}]`;
    } else {
      text = `[${msgType}]`;
    }

    if (chars + text.length > maxChars && lines.length > 0) {
      messagesTruncated = true;
      break;
    }
    chars += text.length;
    lines.push({ senderOpenId, text });
  }

  return { lines, imageRequests, truncated: { messages: messagesTruncated, imagesDropped } };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/channels/feishu.test.ts -t planForwardExpansion`
Expected: PASS（6 个用例全绿）。

- [ ] **Step 5: 提交**

```bash
git add src/channels/feishu.ts src/channels/feishu.test.ts
git commit -m "feat(feishu): planForwardExpansion — pure core for merge_forward expansion"
```

---

## Task 3: 类方法 `fetchMergeForwardItems` + `expandMergeForward`

**Files:**
- Modify: `src/channels/feishu.ts`（在 `resolveSenderName` 附近新增两个私有方法；确认 `processImageKeys` 已 import — `:16` 已有）
- Test: `src/channels/feishu.test.ts`（新增 `describe('expandMergeForward')`）

**Interfaces:**
- Consumes: `planForwardExpansion`（Task 2）、`this.resolveSenderName`（`:582`）、`this.downloadImage`（`:927`）、`processImageKeys`（`../image.js`）、`logger`。
- Produces:
  ```ts
  private async fetchMergeForwardItems(messageId: string): Promise<ForwardItem[]>;
  private async expandMergeForward(items: ForwardItem[]): Promise<{
    transcript: string;
    imageAttachments: ImageAttachment[];
    truncated: { messages: boolean; imagesDropped: number };
  }>;
  ```

- [ ] **Step 1: 写失败测试**

```ts
describe('expandMergeForward', () => {
  beforeEach(() => {
    process.env.FEISHU_APP_ID = 'cli_test';
    process.env.FEISHU_APP_SECRET = 'secret_test';
  });
  afterEach(() => restoreEnv(origEnv));

  it('assembles transcript with resolved names and downloaded images', async () => {
    const ch = getChannelFactory('feishu')!(makeOpts())! as any;
    ch.botOpenId = 'ou_bot';
    ch.resolveSenderName = vi.fn(async (id: string) =>
      (({ ou_a: '建波', ou_b: 'Nine-dev' } as Record<string, string>)[id] ?? id));
    ch.downloadImage = vi.fn(async () =>
      readFileSync('/Users/admin/Desktop/vibe-coding/nanoclaw/tests/fixtures/image-normal.png'));

    const items = [
      { message_id: 'mf', msg_type: 'merge_forward', create_time: '1', body: { content: '{"content":"Merged and Forwarded Message"}' } },
      { message_id: 'c1', msg_type: 'text', create_time: '2', sender: { id: 'ou_a' }, body: { content: JSON.stringify({ text: '生成一个prd' }) } },
      { message_id: 'c2', msg_type: 'image', create_time: '3', sender: { id: 'ou_b' }, body: { content: JSON.stringify({ image_key: 'img_1' }) } },
    ];
    const out = await ch.expandMergeForward(items);
    expect(out.transcript).toContain('[合并转发的聊天记录 · 共 2 条]');
    expect(out.transcript).toContain('建波: 生成一个prd');
    expect(out.transcript).toContain('Nine-dev: [图片]');
    expect(out.imageAttachments).toHaveLength(1);
    expect(out.imageAttachments[0].sourceKey).toBe('img_1');
    // image downloaded with the CHILD message_id, not the container's
    expect(ch.downloadImage).toHaveBeenCalledWith('c2', 'img_1');
  });

  it('fetchMergeForwardItems returns data.items from GET', async () => {
    const ch = getChannelFactory('feishu')!(makeOpts())! as any;
    ch.client = { request: vi.fn(async () => ({ data: { items: [{ message_id: 'x' }] } })) };
    const items = await ch.fetchMergeForwardItems('om_mf');
    expect(items).toEqual([{ message_id: 'x' }]);
    expect(ch.client.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'GET', url: '/open-apis/im/v1/messages/om_mf' }),
    );
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/channels/feishu.test.ts -t expandMergeForward`
Expected: FAIL —「ch.expandMergeForward is not a function」。

- [ ] **Step 3: 实现两个方法**

在 `src/channels/feishu.ts` 的 `resolveSenderName` 方法之后（约 `:602`）插入：

```ts
private async fetchMergeForwardItems(messageId: string): Promise<ForwardItem[]> {
  const res: any = await this.client.request({
    method: 'GET',
    url: `/open-apis/im/v1/messages/${messageId}`,
  });
  return res?.data?.items ?? [];
}

// Expand a merge_forward message's items[] into a readable transcript + inline
// images (both capped). Shared by the reply-path and the direct-forward path.
private async expandMergeForward(items: ForwardItem[]): Promise<{
  transcript: string;
  imageAttachments: ImageAttachment[];
  truncated: { messages: boolean; imagesDropped: number };
}> {
  const plan = planForwardExpansion(items, this.botOpenId, {
    maxMessages: MAX_FORWARD_MESSAGES,
    maxChars: MAX_FORWARD_CHARS,
    maxImages: MAX_FORWARD_IMAGES,
  });

  // Resolve unique sender names (cached in nameCache, dedup by open_id).
  const nameMap = new Map<string, string>();
  const uniqueIds = [...new Set(plan.lines.map((l) => l.senderOpenId).filter(Boolean))];
  await Promise.all(
    uniqueIds.map(async (id) => {
      nameMap.set(id, await this.resolveSenderName(id).catch(() => id));
    }),
  );

  // Download images: each key must be fetched with its own child message_id.
  const keyToMsg = new Map(plan.imageRequests.map((r) => [r.imageKey, r.messageId]));
  const keys = plan.imageRequests.map((r) => r.imageKey);
  const imageAttachments: ImageAttachment[] = keys.length
    ? (await processImageKeys(keys, (k) => this.downloadImage(keyToMsg.get(k) ?? '', k), logger)).attachments
    : [];

  const bodyLines = plan.lines.map((l) => {
    const name = l.senderOpenId ? nameMap.get(l.senderOpenId) ?? l.senderOpenId : '';
    return name ? `${name}: ${l.text}` : l.text;
  });

  const notes: string[] = [];
  if (plan.truncated.messages) notes.push('记录较长，仅展开前部分消息');
  if (plan.truncated.imagesDropped > 0) notes.push(`含较多图片，仅处理前 ${MAX_FORWARD_IMAGES} 张`);

  const header = `[合并转发的聊天记录 · 共 ${plan.lines.length} 条]`;
  const transcript = [header, ...bodyLines, ...(notes.length ? [`[系统: ${notes.join('；')}]`] : [])].join('\n');

  return { transcript, imageAttachments, truncated: plan.truncated };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/channels/feishu.test.ts -t expandMergeForward`
Expected: PASS（2 个用例绿）。

- [ ] **Step 5: 提交**

```bash
git add src/channels/feishu.ts src/channels/feishu.test.ts
git commit -m "feat(feishu): expandMergeForward — resolve names + download inline images"
```

---

## Task 4: 接入群/回复路径（parent 是 merge_forward）

**Files:**
- Modify: `src/channels/feishu.ts:728-791`（`if (m.parent_id)` 块内，`parentMsg.msg_type !== 'file'` 分支改为先判 merge_forward）
- Test: `src/channels/feishu.test.ts`（新增用例）

**Interfaces:**
- Consumes: `this.expandMergeForward`（Task 3）；在该作用域内 `attachments`（`:673` `let`）、`cleanedText`（`:662` `let`）、`replyToInfo`（`:724` `let`）均可写。

- [ ] **Step 1: 写失败测试**

```ts
it('group reply to merge_forward + @bot → transcript appended, image attached', async () => {
  const onMessage = vi.fn();
  const ch = getChannelFactory('feishu')!(makeOpts({ onMessage }))! as any;
  ch.botOpenId = 'ou_bot';
  ch.resolveSenderName = vi.fn(async (id: string) =>
    (({ ou_a: '建波' } as Record<string, string>)[id] ?? id));
  ch.downloadImage = vi.fn(async () =>
    readFileSync('/Users/admin/Desktop/vibe-coding/nanoclaw/tests/fixtures/image-normal.png'));
  ch.client = {
    request: vi.fn(async () => ({
      data: {
        items: [
          { message_id: 'mf', msg_type: 'merge_forward', create_time: '1', body: { content: '{"content":"Merged and Forwarded Message"}' } },
          { message_id: 'c1', msg_type: 'text', create_time: '2', sender: { id: 'ou_a' }, body: { content: JSON.stringify({ text: '会话内容一' }) } },
          { message_id: 'c2', msg_type: 'image', create_time: '3', sender: { id: 'ou_a' }, body: { content: JSON.stringify({ image_key: 'img_1' }) } },
        ],
      },
    })),
    im: { messageReaction: { create: vi.fn().mockResolvedValue({}) } },
  };

  await ch.handleEvent(
    makeEvent({
      chat_type: 'group',
      chat_id: 'oc_g1',
      msg_type: 'text',
      content: JSON.stringify({ text: '@_user_1 你能读到这段记录吗' }),
      parent_id: 'mf',
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }],
    }),
  );

  expect(onMessage).toHaveBeenCalledTimes(1);
  const msg = onMessage.mock.calls[0][1];
  expect(msg.content).toContain('建波: 会话内容一');
  expect(msg.content).toContain('建波: [图片]');
  expect(msg.images).toHaveLength(1);
  expect(msg.reply_to_message_content).toContain('会话内容一');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/channels/feishu.test.ts -t 'group reply to merge_forward'`
Expected: FAIL — content 里没有 transcript（当前只会得到 `(merge_forward) ...` 占位符或不含子消息内容）。

- [ ] **Step 3: 改接入点**

把 `src/channels/feishu.ts` 现有 `if (parentMsg.msg_type !== 'file') {` 这一整块（约 `:752-783`）替换为下面的 if/else-if（先判 merge_forward，再走原有 quoted-parent 逻辑）。用 `items.find(message_id === m.parent_id)` 稳健识别容器（不依赖 items 顺序）：

```ts
          const container = parentRes?.data?.items?.find(
            (it: any) => it.message_id === m.parent_id,
          );
          if (container?.msg_type === 'merge_forward') {
            // Replied-to a merged-forward chat record: expand its children.
            const expanded = await this.expandMergeForward(
              parentRes.data.items,
            );
            cleanedText += `\n\n[引用的合并转发记录]\n${expanded.transcript}`;
            attachments = attachments.concat(expanded.imageAttachments);
            replyToInfo = {
              messageId: m.parent_id,
              content: expanded.transcript.slice(0, 500),
              senderName: '',
            };
          } else if (parentMsg.msg_type !== 'file') {
            const parentSenderId = parentMsg.sender?.id ?? '';
            const parentSenderName = parentSenderId
              ? await this.resolveSenderName(parentSenderId).catch(
                  () => parentSenderId,
                )
              : '';
            const block = formatQuotedParent(
              parentMsg,
              parentSenderName,
              this.botOpenId,
            );
            if (block) {
              cleanedText += block;
              const innerParsed = parseInbound(
                {
                  message_type: parentMsg.msg_type ?? '',
                  content: parentMsg.body?.content ?? '',
                  mentions: parentMsg.mentions ?? [],
                },
                this.botOpenId,
              );
              const innerText =
                innerParsed?.text ||
                `(${parentMsg.msg_type ?? 'unknown'}) ${parentMsg.body?.content ?? ''}`;
              replyToInfo = {
                messageId: m.parent_id,
                content: innerText,
                senderName: parentSenderName,
              };
            }
          }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/channels/feishu.test.ts -t 'group reply to merge_forward'`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/channels/feishu.ts src/channels/feishu.test.ts
git commit -m "feat(feishu): expand merge_forward when user replies to it in a group"
```

---

## Task 5: 接入私聊/直接转发路径（收到的消息本身是 merge_forward）

**Files:**
- Modify: `src/channels/feishu.ts:628-636`（parse 步骤）与 `:672-701`（图片处理块）
- Test: `src/channels/feishu.test.ts`（新增用例）

**Interfaces:**
- Consumes: `this.fetchMergeForwardItems` + `this.expandMergeForward`（Task 3）。
- Produces: 无新导出；改 `handleEvent` 内部控制流。

- [ ] **Step 1: 写失败测试**

```ts
it('p2p direct merge_forward → not dropped, expanded transcript delivered', async () => {
  const onMessage = vi.fn();
  const ch = getChannelFactory('feishu')!(makeOpts({ onMessage }))! as any;
  ch.botOpenId = 'ou_bot';
  ch.resolveSenderName = vi.fn(async (id: string) =>
    (({ ou_a: '建波', ou_b: 'Nine-dev' } as Record<string, string>)[id] ?? id));
  ch.client = {
    request: vi.fn(async () => ({
      data: {
        items: [
          { message_id: 'mf', msg_type: 'merge_forward', create_time: '1', body: { content: '{"content":"Merged and Forwarded Message"}' } },
          { message_id: 'c1', msg_type: 'text', create_time: '2', sender: { id: 'ou_a' }, body: { content: JSON.stringify({ text: '生成一个prd' }) } },
          { message_id: 'c2', msg_type: 'text', create_time: '3', sender: { id: 'ou_b' }, body: { content: JSON.stringify({ text: 'MRD 已完整读取' }) } },
        ],
      },
    })),
    im: { messageReaction: { create: vi.fn().mockResolvedValue({}) } },
  };

  await ch.handleEvent(
    makeEvent({
      msg_type: 'merge_forward',
      message_id: 'mf',
      content: '{"content":"Merged and Forwarded Message"}',
    }),
  );

  expect(onMessage).toHaveBeenCalledTimes(1);
  const msg = onMessage.mock.calls[0][1];
  expect(msg.content).toContain('建波: 生成一个prd');
  expect(msg.content).toContain('Nine-dev: MRD 已完整读取');
  // fetched the container's items via GET
  expect(ch.client.request).toHaveBeenCalledWith(
    expect.objectContaining({ url: '/open-apis/im/v1/messages/mf' }),
  );
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/channels/feishu.test.ts -t 'p2p direct merge_forward'`
Expected: FAIL — `onMessage` 未被调用（当前 merge_forward 被 `parseInbound` 判空后在 `:630` drop）。

- [ ] **Step 3a: 改 parse 步骤（`:628-636`）**

把现有：

```ts
    // 3) Parse
    const parsed = parseInbound(m, this.botOpenId);
    if (!parsed) {
      logger.debug(
        { message_type: m.message_type },
        '[feishu] parseInbound dropped',
      );
      return;
    }
```

替换为：

```ts
    // 3) Parse — merge_forward expands into a transcript instead of being dropped.
    let parsed: ParsedInbound | null;
    let forwardAttachments: ImageAttachment[] | undefined;
    if (m.message_type === 'merge_forward') {
      const items = await this.fetchMergeForwardItems(m.message_id);
      const expanded = await this.expandMergeForward(items);
      const botMentioned =
        !!this.botOpenId &&
        (m.mentions ?? []).some(
          (x: FeishuMention) => x.id?.open_id === this.botOpenId,
        );
      parsed = { text: expanded.transcript, imageKeys: [], botMentioned };
      forwardAttachments = expanded.imageAttachments;
    } else {
      parsed = parseInbound(m, this.botOpenId);
    }
    if (!parsed) {
      logger.debug(
        { message_type: m.message_type },
        '[feishu] parseInbound dropped',
      );
      return;
    }
```

- [ ] **Step 3b: 改图片处理块（`:672-717`）让转发图片直接落到 attachments**

把现有 `let attachments: ImageAttachment[] = [];` 起、到该 `if/else` 结束（含 `else { this.reactAck(...) }`）改为：

```ts
    // 6) Process images if present (merge_forward images already downloaded)
    let attachments: ImageAttachment[] = forwardAttachments ?? [];
    if (forwardAttachments) {
      this.reactAck(m.message_id); // ack the forwarded record
    } else if (parsed.imageKeys.length > 0) {
      // ... 保留原有 processImageKeys 分支整段不动 ...
    } else {
      this.reactAck(m.message_id); // 👀 for pure-text path (existing behavior preserved)
    }
```

（即：仅把原 `let attachments` 初值改为 `forwardAttachments ?? []`，并在最外层 `if` 前加 `if (forwardAttachments) { this.reactAck(...); } else if (...` 包住原有两分支。原 `processImageKeys` 分支内部逻辑一字不改。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/channels/feishu.test.ts -t 'p2p direct merge_forward'`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/channels/feishu.ts src/channels/feishu.test.ts
git commit -m "feat(feishu): expand merge_forward forwarded directly to bot (p2p)"
```

---

## Task 6: 全量构建 + 回归验证（Phase 7 证据准备）

**Files:** 无新代码（若下列任一失败则回到对应 Task 修）。

- [ ] **Step 1: 类型检查 + 构建**

Run: `npm run build`
Expected: 无 TS 错误，`dist/` 产出。

- [ ] **Step 2: 跑通 feishu 全量单测（回归）**

Run: `npx vitest run src/channels/feishu.test.ts`
Expected: 全绿 —— 新增 merge_forward 用例通过，且 `p2p text` / `image` / `file` / `post` / `group @bot` 等既有用例无回归。

- [ ] **Step 3: 跑全仓单测**

Run: `npx vitest run`
Expected: 全绿。

- [ ] **Step 4: 提交（若前述步骤有微调）**

```bash
git add -A
git commit -m "test(feishu): merge_forward expansion — build + full suite green"
```

---

## 计划修订（Phase 3.5 计划审查 + Task 1 门控实测后，2026-07-02）

实测门控通过（权限 OK），但发现 **interactive 卡片子消息不可读**（飞书硬限制，只回 “请升级客户端” 占位）。
计划审查又抓到 2 个中等缺陷。据此对上面的任务做如下修订，**实现以本节为准**：

- **【卡片处理】** `ForwardPlan` 增加字段 `unreadableCards: number`。`planForwardExpansion` 中
  `msg_type === 'interactive'` → 渲染 `[卡片消息]`、`unreadableCards++`、**不**收其图片（避免把 “请升级客户端”
  噪声与卡片图标塞给模型，也顺带化解了重复 image_key 下载的边界）。`expandMergeForward` 在 `unreadableCards > 0`
  时于 transcript 末尾追加 `[系统: 含 N 条卡片消息，飞书 API 无法读取其内容]`。Task 2 增一条卡片单测。
- **【Task 5 修 1 · p2p 限定】** parse 步的 merge_forward 展开**仅当 `m.chat_type === 'p2p'`** 才做；
  群消息仍走 `parseInbound`（返回 null 被丢），群场景由 Task 4 的回复+@ 路径处理。避免群里未 @ 的裸转发白跑
  GET + 下图。
- **【Task 5 修 2 · try/catch 兜底】** `fetchMergeForwardItems` + `expandMergeForward` 用 try/catch 包裹；
  失败或 `plan.lines` 为空时，`parsed.text` 兜底为 `[合并转发消息 — 暂时读不到内容，可把文字或截图发我]`
  （p2p 下阿飞仍会回话，不静默吞掉）。
- **【Task 5 修 3 · 行号】** Task 5 Files 行 `:672-701` 更正为 `:672-717`。

## Self-Review（写完计划的自查结论）

- **Spec 覆盖**：纯文字转录 → Task 2/3；内联图片(设上限) → Task 2(imageRequests cap)/Task 3(下载)；群回复@入口 → Task 4；私聊直发入口 → Task 5；权限实测门控 → Task 1；边界(条数/字符/图片上限) → Task 2 常量 + 裁剪逻辑；测试 → 各 Task Step1 + Task 6。全部有对应 Task。
- **占位符扫描**：无 TBD/TODO；每个改代码的 Step 都给了完整代码。
- **类型一致**：`ForwardItem`/`ForwardPlan`/`planForwardExpansion`/`expandMergeForward`/`fetchMergeForwardItems` 签名在 Task 2/3 定义，Task 4/5 按此调用；`ImageAttachment` 沿用 `../image.js` 既有定义；`ParsedInbound`/`FeishuMention` 沿用文件内既有定义。
```
