# Feishu Auto-Create Topic Group Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Andy agent in Feishu main/DM bootstrap a new Feishu topic group by name — create chat via Feishu API, pull the requester in, register in DB, initialize group folder + CLAUDE.md — via a single atomic MCP tool call.

**Architecture:** Container MCP tool `create_topic_group` → new synchronous IPC primitive (request/response JSON files under per-group namespace) → host handler calls `im.chat.create` + `im.chatMembers.create` via existing lark SDK → inserts `registered_groups` row + refreshes in-memory cache → writes `CLAUDE.md` from `groups/global/` template with appended `## Topic` section. Only `chat.create` failure aborts; later-step failures produce warnings.

**Tech Stack:** TypeScript, vitest, `@larksuiteoapi/node-sdk` (existing), `better-sqlite3` (existing), `@modelcontextprotocol/sdk` (existing), Node 20.

**Spec:** `docs/superpowers/specs/2026-04-21-feishu-auto-create-topic-group-design.md`

---

## File Map

| File | Role | Action |
|---|---|---|
| `src/db.ts` | Add `getLatestUserSenderForChat(chat_jid)` helper | Modify |
| `src/db.test.ts` | Test for new helper | Modify |
| `src/channels/feishu.ts` | Add `createChat()` + `inviteMembers()` methods | Modify |
| `src/channels/feishu.test.ts` | Unit tests for new methods | Modify |
| `src/types.ts` | `CreateTopicGroupReq` / `CreateTopicGroupResp` types | Modify |
| `src/ipc-sync-handlers.ts` | `handleCreateTopicGroup` (create chat → invite → DB → folder) | Create |
| `src/ipc-sync-handlers.test.ts` | Unit tests for handler | Create |
| `src/container-runner.ts` | mkdir `sync_requests/` + `sync_responses/` alongside existing IPC dirs | Modify |
| `src/ipc.ts` | Scan `sync_requests/` per group, dispatch, write responses | Modify |
| `src/index.ts` | Wire `handleCreateTopicGroup` into IPC deps | Modify |
| `container/agent-runner/src/ipc-sync.ts` | `callSync` request/response polling helper | Create |
| `container/agent-runner/src/ipc-sync.test.ts` | Unit tests | Create |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Add `create_topic_group` MCP tool | Modify |
| `container/skills/capabilities/SKILL.md` | Document tool | Modify |
| `container/skills/status/SKILL.md` | Document tool in MCP list | Modify |

---

## Task 1: Feature branch

**Why first:** Isolate work from main.

- [ ] **Step 1: Create and switch to feature branch**

```bash
git checkout -b feat/feishu-auto-create-topic-group
git branch --show-current
```

Expected: `feat/feishu-auto-create-topic-group`

---

## Task 2: `getLatestUserSenderForChat` DB helper (TDD)

**Why:** The host handler needs to resolve "who asked for the group" without relying on stale env vars. Query the most recent non-bot, non-self message's `sender` field for the source chat.

**Files:**
- Modify: `src/db.ts` (add helper near other exports)
- Modify: `src/db.test.ts` (add test)

- [ ] **Step 1: Read `src/db.ts:650-750` to locate where `setRegisteredGroup` lives, add new helper adjacent**

No file change yet.

- [ ] **Step 2: Write failing test in `src/db.test.ts`**

Add at the bottom of the file, inside or after existing describes:

```ts
describe('getLatestUserSenderForChat', () => {
  it('returns the open_id of the most recent non-bot, non-self user message', () => {
    const db = initDatabase();
    const jid = 'feishu:oc_test_chat';
    db.prepare(`INSERT INTO chats (jid, name) VALUES (?, ?)`).run(jid, 'Test');
    db.prepare(
      `INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('m1', jid, 'ou_alice', 'Alice', 'first', '2026-04-20T10:00:00Z', 0, 0);
    db.prepare(
      `INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('m2', jid, 'ou_bot', 'Andy', 'reply', '2026-04-20T10:01:00Z', 0, 1);
    db.prepare(
      `INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('m3', jid, 'ou_alice', 'Alice', 'second', '2026-04-20T10:02:00Z', 0, 0);

    expect(getLatestUserSenderForChat(jid)).toBe('ou_alice');
  });

  it('returns null when chat has no user messages', () => {
    initDatabase();
    expect(getLatestUserSenderForChat('feishu:oc_empty')).toBeNull();
  });

  it('ignores is_from_me=1 rows', () => {
    const db = initDatabase();
    const jid = 'feishu:oc_selfonly';
    db.prepare(`INSERT INTO chats (jid, name) VALUES (?, ?)`).run(jid, 'T');
    db.prepare(
      `INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('m1', jid, 'ou_me', 'Me', 'self', '2026-04-20T10:00:00Z', 1, 0);
    expect(getLatestUserSenderForChat(jid)).toBeNull();
  });
});
```

Add import at the top of the test file: `getLatestUserSenderForChat` in the existing import from `'./db.js'`.

- [ ] **Step 3: Run and verify it fails**

```bash
npm test -- src/db.test.ts -t getLatestUserSenderForChat
```

Expected: test not found or import error — `getLatestUserSenderForChat` not exported.

- [ ] **Step 4: Implement in `src/db.ts`**

Add after `setRegisteredGroup` (or near other message-table helpers). If no message helpers exist yet, add at the bottom of the file before the last `}` of the module scope:

```ts
export function getLatestUserSenderForChat(chatJid: string): string | null {
  const row = db
    .prepare(
      `SELECT sender FROM messages
       WHERE chat_jid = ? AND is_from_me = 0 AND is_bot_message = 0
       ORDER BY timestamp DESC LIMIT 1`,
    )
    .get(chatJid) as { sender: string } | undefined;
  return row?.sender ?? null;
}
```

- [ ] **Step 5: Run and verify it passes**

```bash
npm test -- src/db.test.ts -t getLatestUserSenderForChat
```

Expected: all 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "db: add getLatestUserSenderForChat for requester resolution"
```

---

## Task 3: `FeishuChannel.createChat` method (TDD)

**Why:** Wraps `client.im.chat.create` into a testable method that returns only the `chat_id` string we need.

**Files:**
- Modify: `src/channels/feishu.ts` (add method near other request helpers, e.g. near `sendMessage`)
- Modify: `src/channels/feishu.test.ts` (add describe block)

- [ ] **Step 1: Write failing test in `src/channels/feishu.test.ts`**

Add new describe block at the bottom of the file:

```ts
describe('FeishuChannel.createChat', () => {
  it('calls im.chat.create with correct payload and returns chat_id', async () => {
    const ch = new (await import('./feishu.js')).FeishuChannel(
      'app_id_test',
      'app_secret_test',
      makeOpts(),
    );
    const createSpy = vi
      .fn()
      .mockResolvedValue({ data: { chat_id: 'oc_new_chat_xyz' } });
    (ch as any).client = {
      im: { chat: { create: createSpy } },
    };
    (ch as any).botOpenId = 'ou_bot';

    const result = await ch.createChat({
      name: 'Pipeline 建设',
      description: '讨论 pipeline 的建设与改造',
    });

    expect(result).toEqual({ chat_id: 'oc_new_chat_xyz' });
    expect(createSpy).toHaveBeenCalledWith({
      data: {
        name: 'Pipeline 建设',
        description: '讨论 pipeline 的建设与改造',
        chat_mode: 'group',
        chat_type: 'private',
        owner_id: 'ou_bot',
      },
      params: { user_id_type: 'open_id' },
    });
  });

  it('throws if response has no chat_id', async () => {
    const ch = new (await import('./feishu.js')).FeishuChannel(
      'id',
      'secret',
      makeOpts(),
    );
    (ch as any).client = {
      im: { chat: { create: vi.fn().mockResolvedValue({ data: {} }) } },
    };
    (ch as any).botOpenId = 'ou_bot';

    await expect(
      ch.createChat({ name: 'x', description: 'y' }),
    ).rejects.toThrow(/no chat_id/);
  });
});
```

- [ ] **Step 2: Run and verify it fails**

```bash
npm test -- src/channels/feishu.test.ts -t 'FeishuChannel.createChat'
```

Expected: `createChat is not a function`.

- [ ] **Step 3: Implement in `src/channels/feishu.ts`**

Add after the existing `sendMessage` method inside `FeishuChannel` class:

```ts
async createChat(args: {
  name: string;
  description: string;
}): Promise<{ chat_id: string }> {
  const res: any = await this.client.im.chat.create({
    data: {
      name: args.name,
      description: args.description,
      chat_mode: 'group',
      chat_type: 'private',
      owner_id: this.botOpenId,
    },
    params: { user_id_type: 'open_id' },
  });
  const chat_id = res?.data?.chat_id ?? res?.chat_id;
  if (!chat_id) throw new Error('im.chat.create returned no chat_id');
  return { chat_id };
}
```

- [ ] **Step 4: Run and verify it passes**

```bash
npm test -- src/channels/feishu.test.ts -t 'FeishuChannel.createChat'
```

Expected: both tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/channels/feishu.ts src/channels/feishu.test.ts
git commit -m "feishu: add FeishuChannel.createChat wrapper"
```

---

## Task 4: `FeishuChannel.inviteMembers` method (TDD)

**Files:**
- Modify: `src/channels/feishu.ts`
- Modify: `src/channels/feishu.test.ts`

- [ ] **Step 1: Write failing test**

Append to `src/channels/feishu.test.ts`:

```ts
describe('FeishuChannel.inviteMembers', () => {
  it('calls im.chatMembers.create with correct payload', async () => {
    const ch = new (await import('./feishu.js')).FeishuChannel(
      'id',
      'secret',
      makeOpts(),
    );
    const inviteSpy = vi.fn().mockResolvedValue({ data: {} });
    (ch as any).client = {
      im: { chatMembers: { create: inviteSpy } },
    };

    await ch.inviteMembers('oc_target', ['ou_alice', 'ou_bob']);

    expect(inviteSpy).toHaveBeenCalledWith({
      path: { chat_id: 'oc_target' },
      params: { member_id_type: 'open_id' },
      data: { id_list: ['ou_alice', 'ou_bob'] },
    });
  });

  it('propagates API errors', async () => {
    const ch = new (await import('./feishu.js')).FeishuChannel(
      'id',
      'secret',
      makeOpts(),
    );
    (ch as any).client = {
      im: {
        chatMembers: {
          create: vi.fn().mockRejectedValue(new Error('permission denied')),
        },
      },
    };

    await expect(
      ch.inviteMembers('oc_x', ['ou_y']),
    ).rejects.toThrow(/permission denied/);
  });
});
```

- [ ] **Step 2: Run and verify it fails**

```bash
npm test -- src/channels/feishu.test.ts -t 'FeishuChannel.inviteMembers'
```

Expected: `inviteMembers is not a function`.

- [ ] **Step 3: Implement in `src/channels/feishu.ts`** (immediately after `createChat`)

```ts
async inviteMembers(chatId: string, openIds: string[]): Promise<void> {
  await this.client.im.chatMembers.create({
    path: { chat_id: chatId },
    params: { member_id_type: 'open_id' },
    data: { id_list: openIds },
  });
}
```

- [ ] **Step 4: Run and verify**

```bash
npm test -- src/channels/feishu.test.ts -t 'FeishuChannel.inviteMembers'
```

Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add src/channels/feishu.ts src/channels/feishu.test.ts
git commit -m "feishu: add FeishuChannel.inviteMembers wrapper"
```

---

## Task 5: Types for sync IPC request/response

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Append to `src/types.ts`**

```ts
// --- Sync IPC: create_topic_group ---

export type CreateTopicGroupReq = {
  name: string;
  folder: string;
  topic_description: string;
};

export type CreateTopicGroupResp = {
  chat_id: string;
  folder: string;
  user_invited: boolean;
  db_registered: boolean;
  folder_initialized: boolean;
  warnings: string[];
};
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors (just adding exported types, nothing consuming them yet).

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "types: add CreateTopicGroup{Req,Resp}"
```

---

## Task 6: `handleCreateTopicGroup` handler (TDD)

**Why:** The atomic host-side orchestration — the meat of the feature.

**Files:**
- Create: `src/ipc-sync-handlers.ts`
- Create: `src/ipc-sync-handlers.test.ts`

- [ ] **Step 1: Write failing tests in `src/ipc-sync-handlers.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { handleCreateTopicGroup } from './ipc-sync-handlers.js';
import type { RegisteredGroup } from './types.js';

function makeDeps(overrides: Partial<Parameters<typeof handleCreateTopicGroup>[2]> = {}) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-test-'));
  fs.mkdirSync(path.join(tmpRoot, 'groups', 'global'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpRoot, 'groups', 'global', 'CLAUDE.md'),
    '# Andy\n\nGlobal default.\n',
  );

  return {
    tmpRoot,
    deps: {
      feishuChannel: {
        createChat: vi.fn().mockResolvedValue({ chat_id: 'oc_new' }),
        inviteMembers: vi.fn().mockResolvedValue(undefined),
      } as any,
      setRegisteredGroup: vi.fn(),
      onGroupRegistered: vi.fn(),
      sourceGroupJid: vi.fn().mockReturnValue('feishu:oc_source'),
      lookupRequesterOpenId: vi.fn().mockReturnValue('ou_requester'),
      projectRoot: tmpRoot,
      ...overrides,
    },
  };
}

describe('handleCreateTopicGroup', () => {
  let tmpRoots: string[] = [];
  afterEach(() => {
    for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
    tmpRoots = [];
  });

  function setup(overrides?: any) {
    const out = makeDeps(overrides);
    tmpRoots.push(out.tmpRoot);
    return out;
  }

  it('happy path: all four flags true, no warnings, side effects correct', async () => {
    const { deps, tmpRoot } = setup();

    const resp = await handleCreateTopicGroup(
      { name: 'Pipeline 建设', folder: 'feishu_pipeline', topic_description: '讨论 pipeline 建设' },
      'feishu_main',
      deps,
    );

    expect(resp).toEqual({
      chat_id: 'oc_new',
      folder: 'feishu_pipeline',
      user_invited: true,
      db_registered: true,
      folder_initialized: true,
      warnings: [],
    });
    expect(deps.feishuChannel.createChat).toHaveBeenCalled();
    expect(deps.feishuChannel.inviteMembers).toHaveBeenCalledWith('oc_new', ['ou_requester']);
    expect(deps.setRegisteredGroup).toHaveBeenCalledWith(
      'feishu:oc_new',
      expect.objectContaining({ folder: 'feishu_pipeline', requiresTrigger: false }),
    );
    expect(deps.onGroupRegistered).toHaveBeenCalled();

    const md = fs.readFileSync(
      path.join(tmpRoot, 'groups', 'feishu_pipeline', 'CLAUDE.md'),
      'utf-8',
    );
    expect(md).toContain('Global default.');
    expect(md).toContain('## Topic');
    expect(md).toContain('讨论 pipeline 建设');
  });

  it('chat.create failure: throws, no side effects', async () => {
    const { deps } = setup();
    deps.feishuChannel.createChat = vi.fn().mockRejectedValue(new Error('api down'));

    await expect(
      handleCreateTopicGroup(
        { name: 'x', folder: 'feishu_x', topic_description: 'y' },
        'feishu_main',
        deps,
      ),
    ).rejects.toThrow(/api down/);

    expect(deps.feishuChannel.inviteMembers).not.toHaveBeenCalled();
    expect(deps.setRegisteredGroup).not.toHaveBeenCalled();
  });

  it('invite failure: user_invited=false with warning, DB + folder still created', async () => {
    const { deps, tmpRoot } = setup();
    deps.feishuChannel.inviteMembers = vi.fn().mockRejectedValue(new Error('no perm'));

    const resp = await handleCreateTopicGroup(
      { name: 'x', folder: 'feishu_x', topic_description: 'y' },
      'feishu_main',
      deps,
    );

    expect(resp.user_invited).toBe(false);
    expect(resp.db_registered).toBe(true);
    expect(resp.folder_initialized).toBe(true);
    expect(resp.warnings).toEqual([expect.stringContaining('invite_failed')]);
    expect(fs.existsSync(path.join(tmpRoot, 'groups', 'feishu_x', 'CLAUDE.md'))).toBe(true);
  });

  it('DB failure: db_registered=false with warning, folder still created', async () => {
    const { deps, tmpRoot } = setup();
    deps.setRegisteredGroup = vi.fn().mockImplementation(() => {
      throw new Error('sqlite locked');
    });

    const resp = await handleCreateTopicGroup(
      { name: 'x', folder: 'feishu_x', topic_description: 'y' },
      'feishu_main',
      deps,
    );

    expect(resp.db_registered).toBe(false);
    expect(resp.folder_initialized).toBe(true);
    expect(resp.warnings).toEqual([expect.stringContaining('db_register_failed')]);
    expect(fs.existsSync(path.join(tmpRoot, 'groups', 'feishu_x', 'CLAUDE.md'))).toBe(true);
  });

  it('does NOT overwrite existing CLAUDE.md', async () => {
    const { deps, tmpRoot } = setup();
    fs.mkdirSync(path.join(tmpRoot, 'groups', 'feishu_x'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, 'groups', 'feishu_x', 'CLAUDE.md'),
      'user-customized content',
    );

    await handleCreateTopicGroup(
      { name: 'x', folder: 'feishu_x', topic_description: 'new topic' },
      'feishu_main',
      deps,
    );

    const md = fs.readFileSync(path.join(tmpRoot, 'groups', 'feishu_x', 'CLAUDE.md'), 'utf-8');
    expect(md).toBe('user-customized content');
  });

  it('invalid folder rejects', async () => {
    const { deps } = setup();
    await expect(
      handleCreateTopicGroup(
        { name: 'x', folder: '../evil', topic_description: 'y' },
        'feishu_main',
        deps,
      ),
    ).rejects.toThrow(/invalid folder/i);
  });

  it('no source chat rejects', async () => {
    const { deps } = setup({ sourceGroupJid: vi.fn().mockReturnValue(null) });
    await expect(
      handleCreateTopicGroup(
        { name: 'x', folder: 'feishu_x', topic_description: 'y' },
        'feishu_main',
        deps,
      ),
    ).rejects.toThrow(/cannot resolve source chat/i);
  });

  it('no recent user message rejects', async () => {
    const { deps } = setup({ lookupRequesterOpenId: vi.fn().mockReturnValue(null) });
    await expect(
      handleCreateTopicGroup(
        { name: 'x', folder: 'feishu_x', topic_description: 'y' },
        'feishu_main',
        deps,
      ),
    ).rejects.toThrow(/no recent user message/i);
  });
});
```

- [ ] **Step 2: Run and verify it fails**

```bash
npm test -- src/ipc-sync-handlers.test.ts
```

Expected: module not found (`handleCreateTopicGroup`).

- [ ] **Step 3: Create `src/ipc-sync-handlers.ts`**

```ts
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import type {
  CreateTopicGroupReq,
  CreateTopicGroupResp,
  RegisteredGroup,
} from './types.js';

export interface CreateTopicGroupDeps {
  feishuChannel: {
    createChat(args: { name: string; description: string }): Promise<{ chat_id: string }>;
    inviteMembers(chatId: string, openIds: string[]): Promise<void>;
  };
  setRegisteredGroup: (jid: string, group: RegisteredGroup) => void;
  onGroupRegistered: (jid: string, group: RegisteredGroup) => void;
  sourceGroupJid: (folder: string) => string | null;
  lookupRequesterOpenId: (jid: string) => string | null;
  projectRoot: string;
}

export async function handleCreateTopicGroup(
  req: CreateTopicGroupReq,
  sourceGroupFolder: string,
  deps: CreateTopicGroupDeps,
): Promise<CreateTopicGroupResp> {
  if (!isValidGroupFolder(req.folder)) {
    throw new Error(`invalid folder: ${req.folder}`);
  }

  const srcJid = deps.sourceGroupJid(sourceGroupFolder);
  if (!srcJid) {
    throw new Error(`cannot resolve source chat for ${sourceGroupFolder}`);
  }
  const requesterOpenId = deps.lookupRequesterOpenId(srcJid);
  if (!requesterOpenId) {
    throw new Error('no recent user message found to identify requester');
  }

  const warnings: string[] = [];

  // Step a — fatal
  const { chat_id } = await deps.feishuChannel.createChat({
    name: req.name,
    description: req.topic_description,
  });

  // Step b — non-fatal
  let user_invited = false;
  try {
    await deps.feishuChannel.inviteMembers(chat_id, [requesterOpenId]);
    user_invited = true;
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    warnings.push(`invite_failed: ${m}`);
    logger.warn({ chat_id, err: m }, '[sync-ipc] inviteMembers failed');
  }

  // Step c — non-fatal
  let db_registered = false;
  try {
    const jid = `feishu:${chat_id}`;
    const group: RegisteredGroup = {
      name: req.name,
      folder: req.folder,
      trigger: `@${ASSISTANT_NAME}`,
      added_at: new Date().toISOString(),
      requiresTrigger: false,
    };
    deps.setRegisteredGroup(jid, group);
    deps.onGroupRegistered(jid, group);
    db_registered = true;
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    warnings.push(`db_register_failed: ${m}`);
    logger.warn({ chat_id, err: m }, '[sync-ipc] DB register failed');
  }

  // Steps d+e — non-fatal
  let folder_initialized = false;
  try {
    const groupDir = path.join(deps.projectRoot, 'groups', req.folder);
    fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
    const tmplPath = path.join(deps.projectRoot, 'groups', 'global', 'CLAUDE.md');
    const mdPath = path.join(groupDir, 'CLAUDE.md');
    if (!fs.existsSync(mdPath) && fs.existsSync(tmplPath)) {
      const tmpl = fs.readFileSync(tmplPath, 'utf-8');
      const appended = tmpl + `\n\n## Topic\n\n${req.topic_description}\n`;
      fs.writeFileSync(mdPath, appended);
    }
    folder_initialized = true;
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    warnings.push(`folder_init_failed: ${m}`);
    logger.warn({ folder: req.folder, err: m }, '[sync-ipc] folder init failed');
  }

  return {
    chat_id,
    folder: req.folder,
    user_invited,
    db_registered,
    folder_initialized,
    warnings,
  };
}
```

- [ ] **Step 4: Run and verify it passes**

```bash
npm test -- src/ipc-sync-handlers.test.ts
```

Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/ipc-sync-handlers.ts src/ipc-sync-handlers.test.ts
git commit -m "ipc-sync: add handleCreateTopicGroup orchestrator"
```

---

## Task 7: Container-runner creates sync IPC dirs

**Why:** Each group container needs `sync_requests/` and `sync_responses/` at startup alongside existing `messages/` / `tasks/` / `input/` (bind-mounted into `/workspace/ipc/`).

**Files:**
- Modify: `src/container-runner.ts` (around line 218-220 where existing IPC dirs are created)

- [ ] **Step 1: Locate existing IPC mkdir block**

In `src/container-runner.ts`, search for `messages` and `tasks` being `mkdirSync`'d:

```ts
fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
```

- [ ] **Step 2: Add two new mkdirs immediately after**

```ts
fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
fs.mkdirSync(path.join(groupIpcDir, 'sync_requests'), { recursive: true });
fs.mkdirSync(path.join(groupIpcDir, 'sync_responses'), { recursive: true });
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/container-runner.ts
git commit -m "container-runner: create sync_requests/sync_responses IPC dirs"
```

---

## Task 8: IPC watcher routes sync_requests (TDD for routing)

**Why:** Host must pick up `sync_requests/*.json`, dispatch to handlers, write `sync_responses/<reqid>.json` with result or error.

**Files:**
- Modify: `src/ipc.ts` (extend `processIpcFiles` loop and `IpcDeps`)
- Modify: `src/index.ts` (wire handler into deps)

- [ ] **Step 1: Add test file `src/ipc-sync-watcher.test.ts`**

This is an integration-ish test of the routing logic. Create:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { processSyncRequest } from './ipc.js';

describe('processSyncRequest', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-sync-'));
    fs.mkdirSync(path.join(tmp, 'sync_requests'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'sync_responses'), { recursive: true });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('dispatches create_topic_group and writes success response', async () => {
    const reqPath = path.join(tmp, 'sync_requests', 'abc.json');
    fs.writeFileSync(
      reqPath,
      JSON.stringify({
        action: 'create_topic_group',
        name: 'x',
        folder: 'feishu_x',
        topic_description: 'y',
      }),
    );

    const handler = vi.fn().mockResolvedValue({
      chat_id: 'oc_z',
      folder: 'feishu_x',
      user_invited: true,
      db_registered: true,
      folder_initialized: true,
      warnings: [],
    });

    await processSyncRequest(reqPath, tmp, 'feishu_main', {
      handleCreateTopicGroup: handler,
    } as any);

    const respPath = path.join(tmp, 'sync_responses', 'abc.json');
    expect(fs.existsSync(respPath)).toBe(true);
    const resp = JSON.parse(fs.readFileSync(respPath, 'utf-8'));
    expect(resp).toEqual({ data: expect.objectContaining({ chat_id: 'oc_z' }) });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'x', folder: 'feishu_x' }),
      'feishu_main',
      expect.anything(),
    );
    expect(fs.existsSync(reqPath)).toBe(false);
  });

  it('writes {error} response when handler throws', async () => {
    const reqPath = path.join(tmp, 'sync_requests', 'err.json');
    fs.writeFileSync(
      reqPath,
      JSON.stringify({ action: 'create_topic_group', name: 'x', folder: 'f', topic_description: 't' }),
    );

    const handler = vi.fn().mockRejectedValue(new Error('boom'));

    await processSyncRequest(reqPath, tmp, 'feishu_main', {
      handleCreateTopicGroup: handler,
    } as any);

    const respPath = path.join(tmp, 'sync_responses', 'err.json');
    const resp = JSON.parse(fs.readFileSync(respPath, 'utf-8'));
    expect(resp).toEqual({ error: 'boom' });
  });

  it('writes error for unknown action', async () => {
    const reqPath = path.join(tmp, 'sync_requests', 'unk.json');
    fs.writeFileSync(
      reqPath,
      JSON.stringify({ action: 'not_a_real_action' }),
    );

    await processSyncRequest(reqPath, tmp, 'feishu_main', {
      handleCreateTopicGroup: vi.fn(),
    } as any);

    const respPath = path.join(tmp, 'sync_responses', 'unk.json');
    const resp = JSON.parse(fs.readFileSync(respPath, 'utf-8'));
    expect(resp.error).toMatch(/unknown.*action/i);
  });

  it('rejects create_topic_group from non-main/dm source', async () => {
    const reqPath = path.join(tmp, 'sync_requests', 'p.json');
    fs.writeFileSync(
      reqPath,
      JSON.stringify({ action: 'create_topic_group', name: 'x', folder: 'f', topic_description: 't' }),
    );

    const handler = vi.fn();
    await processSyncRequest(reqPath, tmp, 'feishu_pipeline', {
      handleCreateTopicGroup: handler,
    } as any);

    const resp = JSON.parse(
      fs.readFileSync(path.join(tmp, 'sync_responses', 'p.json'), 'utf-8'),
    );
    expect(resp.error).toMatch(/not authorized/i);
    expect(handler).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run and verify it fails**

```bash
npm test -- src/ipc-sync-watcher.test.ts
```

Expected: `processSyncRequest` not exported.

- [ ] **Step 3: Implement in `src/ipc.ts`**

Add to the existing `IpcDeps` interface:

```ts
export interface IpcDeps {
  // ... existing fields ...
  handleCreateTopicGroup?: (
    req: CreateTopicGroupReq,
    sourceGroupFolder: string,
    deps: CreateTopicGroupDeps,
  ) => Promise<CreateTopicGroupResp>;
  createTopicGroupDeps?: CreateTopicGroupDeps;
}
```

Add imports at top of `src/ipc.ts`:

```ts
import type {
  CreateTopicGroupReq,
  CreateTopicGroupResp,
} from './types.js';
import type { CreateTopicGroupDeps } from './ipc-sync-handlers.js';
```

Add `processSyncRequest` as an exported async function (near the end of the file, outside `startIpcWatcher`):

```ts
export async function processSyncRequest(
  reqFilePath: string,
  groupIpcDir: string,
  sourceGroup: string,
  deps: {
    handleCreateTopicGroup: typeof import('./ipc-sync-handlers.js').handleCreateTopicGroup;
    createTopicGroupDeps?: import('./ipc-sync-handlers.js').CreateTopicGroupDeps;
  },
): Promise<void> {
  const reqId = path.basename(reqFilePath, '.json');
  const respPath = path.join(groupIpcDir, 'sync_responses', `${reqId}.json`);
  let payload: any;
  try {
    payload = JSON.parse(fs.readFileSync(reqFilePath, 'utf-8'));
  } catch (err) {
    writeSyncResponseAtomic(respPath, { error: `invalid_json: ${(err as Error).message}` });
    try { fs.unlinkSync(reqFilePath); } catch {}
    return;
  }

  try {
    let data: unknown;
    if (payload.action === 'create_topic_group') {
      if (sourceGroup !== 'feishu_main' && sourceGroup !== 'feishu_dm') {
        throw new Error('not authorized: create_topic_group only from main or DM');
      }
      if (!deps.createTopicGroupDeps) {
        throw new Error('createTopicGroupDeps not wired up');
      }
      data = await deps.handleCreateTopicGroup(
        {
          name: payload.name,
          folder: payload.folder,
          topic_description: payload.topic_description,
        },
        sourceGroup,
        deps.createTopicGroupDeps,
      );
    } else {
      throw new Error(`unknown sync action: ${payload.action}`);
    }
    writeSyncResponseAtomic(respPath, { data });
  } catch (err) {
    writeSyncResponseAtomic(respPath, {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    try { fs.unlinkSync(reqFilePath); } catch {}
  }
}

function writeSyncResponseAtomic(respPath: string, body: object): void {
  fs.mkdirSync(path.dirname(respPath), { recursive: true });
  const tmp = `${respPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body));
  fs.renameSync(tmp, respPath);
}
```

Then extend the existing `processIpcFiles` loop to scan sync_requests. In the inner per-group loop where `messagesDir` / `tasksDir` are handled (around line 65-90), add a block:

```ts
const syncReqDir = path.join(ipcBaseDir, sourceGroup, 'sync_requests');
try {
  if (
    fs.existsSync(syncReqDir) &&
    deps.handleCreateTopicGroup &&
    deps.createTopicGroupDeps
  ) {
    const syncFiles = fs.readdirSync(syncReqDir).filter((f) => f.endsWith('.json'));
    for (const file of syncFiles) {
      const fp = path.join(syncReqDir, file);
      await processSyncRequest(fp, path.join(ipcBaseDir, sourceGroup), sourceGroup, {
        handleCreateTopicGroup: deps.handleCreateTopicGroup,
        createTopicGroupDeps: deps.createTopicGroupDeps,
      });
    }
  }
} catch (err) {
  logger.error({ err, sourceGroup }, '[ipc] sync_requests scan error');
}
```

- [ ] **Step 4: Run and verify tests pass**

```bash
npm test -- src/ipc-sync-watcher.test.ts
```

Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/ipc.ts src/ipc-sync-watcher.test.ts
git commit -m "ipc: route sync_requests to create_topic_group handler"
```

---

## Task 9: Wire handler into orchestrator `src/index.ts`

**Why:** Now the IPC deps must actually be populated at runtime.

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Locate the `startIpcWatcher` call**

In `src/index.ts` around line 761, `startIpcWatcher({ ... })` is invoked after all channels are connected. This is where the new deps are added.

- [ ] **Step 2: Add imports at top of `src/index.ts`**

Add to existing imports:

```ts
import { handleCreateTopicGroup } from './ipc-sync-handlers.js';
import { getLatestUserSenderForChat, setRegisteredGroup } from './db.js';
import { FeishuChannel } from './channels/feishu.js';
```

(`setRegisteredGroup` may already be imported — verify and skip if so.)

- [ ] **Step 3: Resolve the FeishuChannel instance**

Immediately after the `for (const channelName of getRegisteredChannelNames())` loop (around line 726–738, where `channels.push(channel)` happens), add:

```ts
const feishuChannel = channels.find(
  (c): c is FeishuChannel => c.name === 'feishu',
);
```

`feishuChannel` is `undefined` if Feishu isn't configured.

- [ ] **Step 4: Add deps to `startIpcWatcher` call**

Extend the object passed to `startIpcWatcher({ ... })` (around line 761) with:

```ts
handleCreateTopicGroup,
createTopicGroupDeps: feishuChannel
  ? {
      feishuChannel,
      setRegisteredGroup: (jid, group) => {
        setRegisteredGroup(jid, group);
      },
      onGroupRegistered: (jid, group) => {
        registeredGroups[jid] = group;
      },
      sourceGroupJid: (folder) => {
        for (const [jid, g] of Object.entries(registeredGroups)) {
          if (g.folder === folder) return jid;
        }
        return null;
      },
      lookupRequesterOpenId: getLatestUserSenderForChat,
      projectRoot: process.cwd(),
    }
  : undefined,
```

When `feishuChannel` is undefined (no Feishu configured), `createTopicGroupDeps` is undefined and the watcher block in Task 8 will skip sync-request scanning safely (its guard is `deps.handleCreateTopicGroup && deps.createTopicGroupDeps`).

- [ ] **Step 4: Run the full test suite**

```bash
npm test
```

Expected: all pre-existing tests plus the new ones pass.

- [ ] **Step 5: Type-check + build**

```bash
npx tsc --noEmit && npm run build
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "index: wire handleCreateTopicGroup into IPC watcher"
```

---

## Task 10: Container-side `callSync` helper (TDD)

**Files:**
- Create: `container/agent-runner/src/ipc-sync.ts`
- Create: `container/agent-runner/src/ipc-sync.test.ts`

Note: the container-side tests use vitest too (see `container/agent-runner/src/index.test.ts` as reference).

- [ ] **Step 1: Write failing test in `container/agent-runner/src/ipc-sync.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { callSync } from './ipc-sync.js';

describe('callSync', () => {
  let tmp: string;
  let origEnv: typeof process.env;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-sync-test-'));
    fs.mkdirSync(path.join(tmp, 'sync_requests'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'sync_responses'), { recursive: true });
    origEnv = { ...process.env };
    process.env.NANOCLAW_IPC_DIR = tmp;
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env = origEnv;
  });

  it('writes request, reads matching response, cleans up both files', async () => {
    // Simulate a host replier
    const replier = setInterval(() => {
      const files = fs.readdirSync(path.join(tmp, 'sync_requests'));
      for (const f of files) {
        const body = JSON.parse(
          fs.readFileSync(path.join(tmp, 'sync_requests', f), 'utf-8'),
        );
        fs.writeFileSync(
          path.join(tmp, 'sync_responses', f),
          JSON.stringify({ data: { echo: body.action + ':' + body.x } }),
        );
      }
    }, 20);

    try {
      const resp = await callSync<{ x: number }, { echo: string }>(
        'ping',
        { x: 42 },
        2000,
      );
      expect(resp).toEqual({ echo: 'ping:42' });
      // Files cleaned up
      expect(fs.readdirSync(path.join(tmp, 'sync_requests'))).toHaveLength(0);
      expect(fs.readdirSync(path.join(tmp, 'sync_responses'))).toHaveLength(0);
    } finally {
      clearInterval(replier);
    }
  });

  it('throws on error response', async () => {
    const replier = setInterval(() => {
      const files = fs.readdirSync(path.join(tmp, 'sync_requests'));
      for (const f of files) {
        fs.writeFileSync(
          path.join(tmp, 'sync_responses', f),
          JSON.stringify({ error: 'something broke' }),
        );
      }
    }, 20);

    try {
      await expect(
        callSync('boom', { x: 1 }, 2000),
      ).rejects.toThrow(/something broke/);
    } finally {
      clearInterval(replier);
    }
  });

  it('throws on timeout', async () => {
    await expect(
      callSync('timeout_case', { x: 1 }, 300),
    ).rejects.toThrow(/timeout/);
  });

  it('concurrent calls use distinct reqid and do not cross-talk', async () => {
    const replier = setInterval(() => {
      const files = fs.readdirSync(path.join(tmp, 'sync_requests'));
      for (const f of files) {
        const body = JSON.parse(
          fs.readFileSync(path.join(tmp, 'sync_requests', f), 'utf-8'),
        );
        fs.writeFileSync(
          path.join(tmp, 'sync_responses', f),
          JSON.stringify({ data: { id: body.id } }),
        );
      }
    }, 20);

    try {
      const [a, b] = await Promise.all([
        callSync<{ id: string }, { id: string }>('x', { id: 'A' }, 2000),
        callSync<{ id: string }, { id: string }>('x', { id: 'B' }, 2000),
      ]);
      expect(a.id).toBe('A');
      expect(b.id).toBe('B');
    } finally {
      clearInterval(replier);
    }
  });
});
```

- [ ] **Step 2: Run and verify it fails**

```bash
cd container/agent-runner && npx vitest run src/ipc-sync.test.ts
```

Expected: module not found.

- [ ] **Step 3: Create `container/agent-runner/src/ipc-sync.ts`**

```ts
import fs from 'fs';
import path from 'path';

const DEFAULT_IPC_DIR = '/workspace/ipc';

function ipcDir(): string {
  return process.env.NANOCLAW_IPC_DIR || DEFAULT_IPC_DIR;
}

function randomHex(n: number): string {
  const chars = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * 16)];
  return s;
}

export async function callSync<Req extends object, Resp>(
  action: string,
  data: Req,
  timeoutMs = 15000,
): Promise<Resp> {
  const base = ipcDir();
  const reqDir = path.join(base, 'sync_requests');
  const respDir = path.join(base, 'sync_responses');
  fs.mkdirSync(reqDir, { recursive: true });
  fs.mkdirSync(respDir, { recursive: true });

  const reqid = `${Date.now()}-${randomHex(8)}`;
  const reqPath = path.join(reqDir, `${reqid}.json`);
  const respPath = path.join(respDir, `${reqid}.json`);

  const tmpPath = `${reqPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify({ action, ...data }));
  fs.renameSync(tmpPath, reqPath);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(respPath)) {
      const raw = fs.readFileSync(respPath, 'utf-8');
      try { fs.unlinkSync(respPath); } catch {}
      try { fs.unlinkSync(reqPath); } catch {}
      const body = JSON.parse(raw);
      if (body.error) throw new Error(body.error);
      return body.data as Resp;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  try { fs.unlinkSync(reqPath); } catch {}
  throw new Error(`sync IPC timeout after ${timeoutMs}ms: ${action}`);
}
```

- [ ] **Step 4: Run and verify tests pass**

```bash
cd container/agent-runner && npx vitest run src/ipc-sync.test.ts
```

Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/Desktop/vibe-coding/nanoclaw
git add container/agent-runner/src/ipc-sync.ts container/agent-runner/src/ipc-sync.test.ts
git commit -m "container: add callSync helper for sync IPC"
```

---

## Task 11: Add `create_topic_group` MCP tool in container

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts`

- [ ] **Step 1: Add imports at top** (after existing imports)

```ts
import { callSync } from './ipc-sync.js';

type CreateTopicGroupResp = {
  chat_id: string;
  folder: string;
  user_invited: boolean;
  db_registered: boolean;
  folder_initialized: boolean;
  warnings: string[];
};
```

- [ ] **Step 2: Add the tool registration** (at the end of `server.tool(...)` chain, just before the `StdioServerTransport` block)

```ts
server.tool(
  'create_topic_group',
  `Create a new Feishu topic group and pull the user in. Main group or feishu_dm only.

Use this when the user wants to spin off a dedicated discussion space for a new topic
(e.g., "开个聊 X 的群", "这块另起一个群聊"). You should:
1. Propose a group name based on conversation context
2. Confirm with the user (show the proposed name, let them override)
3. Call this tool with the confirmed name, a folder (e.g. "feishu_pipeline"), and a short topic description

Returns a status summary including the new chat_id.`,
  {
    name: z.string().describe(
      'Display name for the new group (e.g., "pipeline 建设"). User-confirmed.',
    ),
    folder: z.string().describe(
      'Channel-prefixed folder name, lowercase Latin + hyphens for suffix (e.g., "feishu_pipeline", "feishu_harness"). Matches existing naming like feishu_langgraph-fix.',
    ),
    topic_description: z.string().describe(
      "One-line topic summary appended to the new group's CLAUDE.md.",
    ),
  },
  async (args) => {
    if (!isMain && groupFolder !== 'feishu_dm') {
      return {
        content: [
          {
            type: 'text' as const,
            text: '只有主群和阿飞 DM 能建话题群。',
          },
        ],
        isError: true,
      };
    }

    try {
      const result = await callSync<
        { name: string; folder: string; topic_description: string },
        CreateTopicGroupResp
      >(
        'create_topic_group',
        {
          name: args.name,
          folder: args.folder,
          topic_description: args.topic_description,
        },
        20000,
      );

      const allOk =
        result.user_invited && result.db_registered && result.folder_initialized;
      const text = allOk
        ? `已开群「${args.name}」✅\n• chat_id: ${result.chat_id}\n• 你已被拉入\n• 已注册为 ${result.folder}\n• CLAUDE.md 已初始化`
        : `群「${args.name}」已建好 ⚠️ 部分失败\n• chat_id: ${result.chat_id}\n• ${result.user_invited ? '✅' : '❌'} 拉你${result.user_invited ? '成功' : '失败'}\n• ${result.db_registered ? '✅' : '❌'} DB ${result.db_registered ? '已注册' : '注册失败'}\n• ${result.folder_initialized ? '✅' : '❌'} CLAUDE.md ${result.folder_initialized ? '已初始化' : '初始化失败'}${result.warnings.length ? '\n• warnings: ' + result.warnings.join('; ') : ''}\n你可能需要手动处理没打勾的部分。`;

      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `建群失败：${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);
```

- [ ] **Step 3: Type-check container build**

```bash
cd container/agent-runner && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/admin/Desktop/vibe-coding/nanoclaw
git add container/agent-runner/src/ipc-mcp-stdio.ts
git commit -m "container-mcp: add create_topic_group tool"
```

---

## Task 12: Update capability docs

**Files:**
- Modify: `container/skills/capabilities/SKILL.md`
- Modify: `container/skills/status/SKILL.md`

- [ ] **Step 1: Edit `container/skills/capabilities/SKILL.md`**

Find the section listing MCP tools (there's a line near `- register_group — register a new chat/group (main only)`). Add a line below it:

```
- `create_topic_group` — create a brand-new Feishu topic group + auto-register (main/DM only). Use when user wants to spin off a new discussion space. Propose name → confirm with user → call with name, folder, topic_description.
```

Also find the summary line `• MCP: send_message, schedule_task, ..., register_group` and append:

```
• MCP: send_message, schedule_task, list_tasks, pause/resume/cancel/update_task, register_group, create_topic_group
```

- [ ] **Step 2: Edit `container/skills/status/SKILL.md`**

Find the line `- **MCP:** mcp__nanoclaw__* (send_message, ..., register_group)` and append `, create_topic_group`:

```
- **MCP:** mcp__nanoclaw__* (send_message, schedule_task, list_tasks, pause_task, resume_task, cancel_task, update_task, register_group, create_topic_group)
```

- [ ] **Step 3: Commit**

```bash
git add container/skills/capabilities/SKILL.md container/skills/status/SKILL.md
git commit -m "docs(skills): document create_topic_group MCP tool"
```

---

## Task 13: Build + deploy + manual verification

**Files:** none

- [ ] **Step 1: Build host**

```bash
npm run build
```

Expected: dist/ regenerated, no errors.

- [ ] **Step 2: Full test sweep**

```bash
npm test
```

Expected: all tests pass (including the new ones from Tasks 2, 6, 8, 10).

- [ ] **Step 3: Rebuild container image**

```bash
./container/build.sh --no-cache --pull
```

Expected: `nanoclaw-agent:latest` rebuilt. Note the BuildKit COPY cache trap — `--no-cache --pull` is essential (ref: memory `reference_buildkit_copy_cache_trap.md`).

- [ ] **Step 4: Restart host service**

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
sleep 3
launchctl list | grep com.nanoclaw
```

Expected: a new PID for `com.nanoclaw`. Tail log:

```bash
tail -30 logs/nanoclaw.log
```

Expected: no crash, `[feishu] WS connected`, `IPC watcher started (per-group namespaces)`.

- [ ] **Step 5: Manual verification (main group)**

In the Feishu main group ("开发群"), say something like:
- "新开一个聊 LangGraph 底层改造的群"

Andy should:
1. Propose a name (e.g. "LangGraph 底层改造") and a folder (e.g. "feishu_langgraph-core"), ask for confirmation.
2. After confirmation, invoke `create_topic_group`.
3. Within ~5s, reply with the success format.

Verify on host:

```bash
sqlite3 store/messages.db "SELECT jid, name, folder, requires_trigger FROM registered_groups WHERE folder='feishu_langgraph-core';"
ls groups/feishu_langgraph-core/
head groups/feishu_langgraph-core/CLAUDE.md
```

Expected: DB row present with `requires_trigger=0`; folder + `CLAUDE.md` exist; `CLAUDE.md` ends with a `## Topic` section containing the topic_description.

Verify on Feishu: the new group is listed in your chat sidebar, you are a member, bot is a member.

- [ ] **Step 6: Manual verification (partial failure)**

Temporarily revoke the bot's `im:chat.member` scope in Feishu dev console (or use a user_id the bot can't invite) and repeat the request. Andy should reply with the "⚠️ 部分失败" format.

Restore the scope afterwards.

- [ ] **Step 7: Manual verification (permission gate)**

In a non-main, non-DM registered group (e.g. `feishu_pipeline`), ask Andy to create a topic group. Andy should refuse with: `只有主群和阿飞 DM 能建话题群。`

- [ ] **Step 8: No commit** — this task produces no code changes, only verification artifacts.

---

## Task 14: PR prep

- [ ] **Step 1: Push branch**

```bash
git push -u origin feat/feishu-auto-create-topic-group
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --title "feat(feishu): auto-create topic group via create_topic_group MCP" --body "$(cat <<'EOF'
## Summary
- New `create_topic_group` MCP tool for Andy (Feishu main/DM only) that bootstraps a new Feishu topic group end-to-end: `im.chat.create` → invite requester → register in DB → init group folder + `CLAUDE.md` with appended `## Topic` section.
- First synchronous IPC primitive (per-group `sync_requests/` → `sync_responses/`) so the MCP can return the created `chat_id` atomically.
- Best-effort failure handling per spec: only `chat.create` failure aborts; later steps report warnings.

## Spec + Plan
- Spec: `docs/superpowers/specs/2026-04-21-feishu-auto-create-topic-group-design.md`
- Plan: `docs/superpowers/plans/2026-04-21-feishu-auto-create-topic-group.md`

## Test plan
- [ ] `npm test` green (new: `ipc-sync-handlers.test.ts`, `ipc-sync-watcher.test.ts`, extended `feishu.test.ts`, `db.test.ts`, container `ipc-sync.test.ts`)
- [ ] Manual: main group → Andy proposes name → confirm → group created, you invited, DB row inserted, folder + CLAUDE.md initialized
- [ ] Manual: partial failure (revoke invite scope) → "⚠️ 部分失败" response
- [ ] Manual: permission gate — non-main/DM group request refused

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review Notes

Covered against spec:

- ✅ Scope In: `create_topic_group` MCP, sync IPC primitive, atomic host handler, CLAUDE.md init with appended Topic, permission gate (main/DM), best-effort failures → Tasks 3–11
- ✅ Scope Out: no cleanup automation, no multi-member invite, no topic inference, no trigger from other groups, no sync-IPC retrofit of existing MCPs → no tasks for these
- ✅ Q1-C (proposes name, user confirms): handled in tool description (Task 11 step 2, instructs agent to propose then confirm)
- ✅ Q2-A (only requester + bot): single `inviteMembers` call with one open_id
- ✅ Q3-B (best-effort + report): Task 6 handler, Task 11 response formatter
- ✅ Q4-B (template + appended `## Topic`): Task 6 step 3 handler code
- ✅ Q5-C (main + DM only): gated in Task 11 MCP, re-validated in Task 8 handler
- ✅ Approach 1 (sync IPC): primitive in Tasks 7, 8, 10; handler in Task 6

Field-name consistency: `chat_id`, `folder`, `user_invited`, `db_registered`, `folder_initialized`, `warnings` — used uniformly across types (Task 5), handler (Task 6), watcher (Task 8), container helper (Task 10), and tool (Task 11).
