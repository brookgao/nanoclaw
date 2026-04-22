# Feishu Auto-Create Topic Group — Design Spec

**Date:** 2026-04-21
**Status:** Ready for plan
**Owner:** brookgao
**Affects:** `src/channels/feishu.ts`, `src/ipc.ts`, `src/ipc-sync-handlers.ts` (new), `container/agent-runner/src/ipc-mcp-stdio.ts`, `container/agent-runner/src/ipc-sync.ts` (new), `container/skills/capabilities/SKILL.md`, `container/skills/status/SKILL.md`

## Problem

When the user starts discussing a new topic in the main Feishu group (e.g. "pipeline 建设", "harness 框架搭建"), they currently have to manually:

1. Create a new Feishu group chat in the Feishu UI
2. Add Andy (the bot) to the group
3. Invite themselves (or confirm membership)
4. Get the new group's `chat_id` somehow (inspect URL, ask API)
5. Run `npx tsx setup/index.ts --step register ...` on the host (or invoke the `register_group` MCP with the right folder name / trigger / flags)

This is five manual steps for what should be "让阿飞新开一个聊 X 的群"。The existing `register_group` MCP only registers **existing** Feishu groups — it can't bootstrap a group from scratch.

The Feishu app (`oc_...` configured in `.env`) already has `im:chat` and `im:chat.member` permission scopes; the capability is unlocked, the code is missing.

## Scope

**In:**

- New MCP tool `create_topic_group(name, topic_description)` available to the Andy agent
- New synchronous IPC primitive (request/response file pattern) so the MCP call can return the created `chat_id`
- Host-side atomic handler: create Feishu chat → invite requester → register in DB → create group folder → initialize `CLAUDE.md` from `groups/global/` template with an appended `## Topic` section
- Permission gate: only callable from `feishu_main` or `feishu_dm` (matches Q5-C)
- Best-effort failure handling: chat creation is the only fatal step; invite / DB-write / folder-init failures produce warnings but do not roll back (Q3-B)

**Out:**

- Auto-dissolve / cleanup of orphan groups (user manually dissolves in Feishu UI per Q3 conversation)
- Multi-member invitation beyond the requester (Q2-A: only the user + bot)
- Auto-inference of topic name without user confirmation (Q1-C: Andy proposes, user can override)
- Topic context extraction from conversation history (Q4-B: user-supplied description only, not auto-summarized)
- Triggering from arbitrary registered groups (Q5-C: main + DM only)
- Reuse of the new sync IPC primitive for retrofitting existing fire-and-forget MCPs (scope limited to `create_topic_group`)

## Key Decisions (recorded Q&A)

| # | Decision |
|---|---|
| Q1 | **C** — Andy proposes a group name based on conversation context, user confirms or overrides before the tool is invoked |
| Q2 | **A** — Only the requester + bot are pulled into the new group; no multi-member invite |
| Q3 | **B** — Best-effort + report. Only `chat.create` failure aborts; later step failures produce warnings returned to the agent |
| Q4 | **B** — `CLAUDE.md` copied from `groups/global/` template, then a `## Topic\n\n<description>` block appended |
| Q5 | **C** — Main group (`feishu_main`) and DM (`feishu_dm`) can trigger; all other groups refused |
| Approach | **1** — Atomic host-side MCP with new sync IPC primitive (over two-step fire-and-forget or container-direct-API) |

## Architecture

```
┌────────────────────┐         ┌────────────────────┐         ┌─────────────────┐
│  Main / DM Group   │  消息   │  FeishuChannel     │  事件   │  Agent Container│
│                    │────────>│  (host)            │────────>│  (Andy)         │
└────────────────────┘         └────────────────────┘         └─────────────────┘
                                        │                              │
                                        │      ① MCP: create_topic_group(name, desc)
                                        │◀─────────────────────────────│
                                        │                              │
                                        │  ② 写 req.json + 等 resp     │
                                        │                              │
                                        ▼                              │
                              ┌────────────────────┐                   │
                              │ Sync IPC Handler   │                   │
                              │ ──────────────────│                   │
                              │ a. im.chat.create  │──飞书 API         │
                              │ b. invite user     │──飞书 API         │
                              │ c. insert DB row   │                   │
                              │ d. mkdir folder    │                   │
                              │ e. cp+append MD    │                   │
                              │ f. reload cache    │                   │
                              └────────────────────┘                   │
                                        │                              │
                                        │  ③ 写 resp.json              │
                                        │─────────────────────────────▶│
                                        │                              │
                                        ▼                              ▼
                              ┌────────────────────┐         ┌─────────────────┐
                              │  New topic group   │         │  Andy 回主群：   │
                              │  (feishu_<topic>)  │         │  "已开'X'群"    │
                              │  你 + 阿飞         │         │                 │
                              └────────────────────┘         └─────────────────┘
```

**4 changes:**

1. **Container MCP**: `container/agent-runner/src/ipc-mcp-stdio.ts` gains `create_topic_group` tool
2. **New sync IPC primitive**: `container/agent-runner/src/ipc-sync.ts` (new file) — request/response file pattern
3. **Host-side handler + Feishu API methods**: `src/ipc-sync-handlers.ts` (new), `src/channels/feishu.ts` exposes `createChat()` + `inviteMembers()`, `src/ipc.ts` watcher extends to route sync requests
4. **Capability documentation**: `container/skills/capabilities/SKILL.md` + `container/skills/status/SKILL.md` document the new tool

## Synchronous IPC Primitive

Existing IPC is pure fire-and-forget: container writes to `TASKS_DIR`, host watches and processes, never responds. The new primitive adds a matched request-response pair.

**File layout** — mirrors the existing per-group namespace convention (`src/ipc.ts:63-66`): `sourceGroup` is derived from the directory path and trusted as identity.

```
/workspace/ipc/
└── <sourceGroup>/          # e.g. feishu_main, feishu_dm
    ├── messages/           # existing
    ├── tasks/              # existing: fire-and-forget
    ├── sync_requests/      # new: requests needing response
    │   └── <reqid>.json
    └── sync_responses/     # new: host-written responses
        └── <reqid>.json
```

The host IPC watcher already scans all per-group directories; it will be extended to also watch each group's `sync_requests/` subdirectory.

**Container API** (`container/agent-runner/src/ipc-sync.ts`):

```ts
async function callSync<Req, Resp>(
  action: string,
  data: Req,
  timeoutMs = 15000
): Promise<Resp> {
  const reqid = `${Date.now()}-${randomHex(6)}`;
  const reqPath = path.join(IPC_DIR, 'sync_requests', `${reqid}.json`);
  const respPath = path.join(IPC_DIR, 'sync_responses', `${reqid}.json`);

  fs.mkdirSync(path.dirname(reqPath), { recursive: true });
  fs.mkdirSync(path.dirname(respPath), { recursive: true });
  fs.writeFileSync(reqPath, JSON.stringify({ action, ...data }));

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(respPath)) {
      const resp = JSON.parse(fs.readFileSync(respPath, 'utf-8'));
      try { fs.unlinkSync(respPath); } catch {}
      try { fs.unlinkSync(reqPath); } catch {}
      if (resp.error) throw new Error(resp.error);
      return resp.data;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  try { fs.unlinkSync(reqPath); } catch {}
  throw new Error(`sync IPC timeout: ${action}`);
}
```

**Host side** (`src/ipc.ts`): extend existing chokidar watcher to also observe `sync_requests/`. On new file:

1. Parse `action`, dispatch to handler (e.g. `handleCreateTopicGroup`)
2. Await handler result or error
3. Write `{data}` or `{error}` to `sync_responses/<reqid>.json` atomically (write to `.tmp` + rename)
4. Do not delete request file — the container cleans it up on successful read

**Timeout:** 15s (chat.create + invite typically < 3s end-to-end; 15s leaves headroom for Feishu API slowness)

**Cleanup safety:** Container deletes its own request+response files after reading; if container crashes mid-read, residue is harmless (next startup can ignore stale files by comparing timestamps, or a periodic sweep deletes anything > 1h old — **out of scope for v1**).

## MCP Tool Signature

Added to `container/agent-runner/src/ipc-mcp-stdio.ts`:

```ts
server.tool(
  'create_topic_group',
  `Create a new Feishu topic group and pull the user in. Main group or feishu_dm only.

Use this when the user wants to spin off a dedicated discussion space for a new topic
(e.g., "开个聊 X 的群", "这块另起一个群聊"). You should:
1. Propose a group name based on conversation context
2. Confirm with the user (show the proposed name, let them override)
3. Call this tool with the confirmed name + a short topic description

Returns the created chat_id, folder path, and status summary.`,
  {
    name: z.string().describe(
      'Display name for the new group (e.g., "pipeline 建设"). User-confirmed.'
    ),
    folder: z.string().describe(
      'Channel-prefixed folder name (e.g., "feishu_pipeline", "feishu_harness"). ' +
      'Use lowercase Latin + hyphens for the suffix; short and memorable. ' +
      'Matches the naming convention of existing groups like feishu_langgraph-fix.'
    ),
    topic_description: z.string().describe(
      'One-line topic summary appended to the new group\'s CLAUDE.md.'
    ),
  },
  async (args) => {
    if (!isMain && groupFolder !== 'feishu_dm') {
      return {
        content: [{
          type: 'text' as const,
          text: '只有主群和阿飞 DM 能建话题群。',
        }],
        isError: true,
      };
    }

    try {
      const result = await callSync<CreateTopicGroupReq, CreateTopicGroupResp>(
        'create_topic_group',
        { name: args.name, topic_description: args.topic_description },
      );
      return { content: [{ type: 'text' as const, text: formatResult(result) }] };
    } catch (err) {
      return {
        content: [{
          type: 'text' as const,
          text: `建群失败：${(err as Error).message}`,
        }],
        isError: true,
      };
    }
  },
);
```

**Response type:**

```ts
type CreateTopicGroupResp = {
  chat_id: string;                  // always present (chat.create succeeded)
  folder: string;                   // "feishu_<slugified-name>"
  user_invited: boolean;
  db_registered: boolean;
  folder_initialized: boolean;
  warnings: string[];
};
```

**Success text (all four true):**

```
已开群「pipeline 建设」✅
• chat_id: oc_xxx
• 你已被拉入
• 已注册为 feishu_pipeline
• CLAUDE.md 已初始化
```

**Partial failure text (any false; Q3-B):**

```
群「pipeline 建设」已建好 ⚠️ 部分失败
• chat_id: oc_xxx
• ❌ 拉你失败：permission_denied
• ✅ DB 已注册
• ✅ CLAUDE.md 已初始化
你手动在飞书里加入群就行。
```

## Host Handler Logic

New file `src/ipc-sync-handlers.ts` (single-responsibility: sync IPC handlers, not mixed into `ipc.ts`):

```ts
export async function handleCreateTopicGroup(
  req: { name: string; folder: string; topic_description: string },
  sourceGroupFolder: string, // trusted from sync_requests/ directory path
  deps: {
    feishuChannel: FeishuChannel;
    setRegisteredGroup: typeof setRegisteredGroup;
    onGroupRegistered: (jid: string, group: RegisteredGroup) => void;
    lookupRequesterOpenId: (sourceGroupJid: string) => string | null;
    sourceGroupJid: (folder: string) => string | null;
    projectRoot: string;
  },
): Promise<CreateTopicGroupResp> {
  if (!isValidGroupFolder(req.folder)) {
    throw new Error(`invalid folder name: ${req.folder}`);
  }

  // Resolve who asked (DB lookup on source group's latest non-bot sender)
  const srcJid = deps.sourceGroupJid(sourceGroupFolder);
  if (!srcJid) throw new Error(`cannot resolve source chat for ${sourceGroupFolder}`);
  const requester_open_id = deps.lookupRequesterOpenId(srcJid);
  if (!requester_open_id) throw new Error('no recent user message found to identify requester');

  const warnings: string[] = [];
  const folder = req.folder;

  // Step a — fatal if it fails
  const { chat_id } = await deps.feishuChannel.createChat({
    name: req.name,
    description: req.topic_description,
  });

  // Step b — non-fatal
  let user_invited = false;
  try {
    await deps.feishuChannel.inviteMembers(chat_id, [requester_open_id]);
    user_invited = true;
  } catch (err) {
    warnings.push(`invite_failed: ${(err as Error).message}`);
  }

  // Step c — non-fatal
  let db_registered = false;
  try {
    const jid = `feishu:${chat_id}`;
    const group: RegisteredGroup = {
      name: req.name,
      folder,
      trigger: `@${ASSISTANT_NAME}`,
      added_at: new Date().toISOString(),
      requiresTrigger: false,
    };
    deps.setRegisteredGroup(jid, group);
    deps.onGroupRegistered(jid, group);
    db_registered = true;
  } catch (err) {
    warnings.push(`db_register_failed: ${(err as Error).message}`);
  }

  // Steps d + e — non-fatal
  let folder_initialized = false;
  try {
    const groupDir = path.join(deps.projectRoot, 'groups', folder);
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
    warnings.push(`folder_init_failed: ${(err as Error).message}`);
  }

  return { chat_id, folder, user_invited, db_registered, folder_initialized, warnings };
}
```

**New methods on `FeishuChannel`:**

```ts
async createChat(args: { name: string; description: string }): Promise<{ chat_id: string }> {
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
  if (!chat_id) throw new Error('chat.create returned no chat_id');
  return { chat_id };
}

async inviteMembers(chatId: string, openIds: string[]): Promise<void> {
  await this.client.im.chatMembers.create({
    path: { chat_id: chatId },
    params: { member_id_type: 'open_id' },
    data: { id_list: openIds },
  });
}
```

## Requester Open ID Resolution

The MCP tool must know which user to invite. Container-side the agent has no reliable way to supply this (`REQUESTER_OPEN_ID` env var set at container start is stale for subsequent messages within the same container's 30-minute idle window, and multi-user main groups would invite the wrong person).

**Chosen: DB lookup in host handler.**

When the sync handler fires, it:

1. Reads `sourceGroupFolder` from the sync_requests directory path (trusted, same pattern as existing IPC)
2. Maps folder → `chat_jid` via `registeredGroups`
3. Queries `messages` table for the most recent row where `chat_jid = <source> AND is_from_me = 0 AND is_bot_message = 0`, returns `sender` (which is the open_id for Feishu messages — see `src/channels/feishu.ts:551-554`)
4. If no recent user message exists (e.g. first-ever message, or container reboot wiped context), returns an error — the agent cannot create a group on behalf of nobody

This matches the "just-ran-a-command" model: the user who asked for the group is always the one who sent the most recent human message in that chat.

## Failure Matrix

| Step | Failure effect | Response |
|------|---------------|----------|
| a. `chat.create` | Nothing created anywhere | Throw in handler → sync IPC returns `{error}` → MCP returns `isError: true` → Andy sends "建群失败：xxx" |
| b. `inviteMembers` | Chat exists, bot only | `user_invited=false` + warning; continue to c |
| c. `setRegisteredGroup` | Chat exists, bot + user, but nanoclaw doesn't know | `db_registered=false` + warning; continue to d/e |
| d/e. folder / CLAUDE.md | DB has row but agent has no home directory | `folder_initialized=false` + warning. On first message to the group, the agent-runner's default fallback (`CWD=/workspace/group` but no group dir) would error — **so if d fails, user should re-run manually via `register_group` or fix the filesystem** |

**No rollback** for any step (Q3-B). The partial state is user-visible in the response text so they can act.

## Permission Gate

Enforced at **two levels**:

1. **MCP-level** (`ipc-mcp-stdio.ts`): checks `isMain || groupFolder === 'feishu_dm'` before writing sync request — gives the agent a clear error so it doesn't even attempt the call from other groups
2. **Host-level** (`ipc-sync-handlers.ts`): the sync IPC router reads the request's source group folder (from the `sync_requests/<reqid>.json` path or embedded metadata) and re-validates before invoking the handler — defense-in-depth against a misbehaving container

Reuses the existing `isMain` flag pattern from `schedule_task` / `register_group`.

## Testing Strategy

**Unit tests (host, vitest):**

- `src/ipc-sync-handlers.test.ts` (new) — mock `feishuChannel.createChat` + `inviteMembers`, verify:
  - Happy path: all four flags true, no warnings, correct DB row + folder
  - `chat.create` fails: throws, no side effects
  - `inviteMembers` fails: `user_invited=false`, warning logged, DB + folder still created
  - `setRegisteredGroup` fails: `db_registered=false`, warning, folder still created
  - Folder already exists: does NOT overwrite existing `CLAUDE.md` (user-customization safety)
  - Invalid folder name (e.g. contains `/`, `..`, empty): rejects via `isValidGroupFolder`
  - No recent user message in source chat: rejects with clear error (requester can't be resolved)
- `src/channels/feishu.test.ts` extended — mock lark client, verify `createChat` and `inviteMembers` request shape

**Unit tests (container, vitest):**

- `container/agent-runner/src/ipc-sync.test.ts` (new) — mock `fs`, verify:
  - Success: writes request, reads response, cleans up both
  - Timeout: throws `sync IPC timeout` after `timeoutMs`
  - Response with `error` field: throws that error
  - Concurrent calls: distinct `reqid` per call, no cross-talk

**Integration tests: skipped** — Feishu API can't be mocked at the wire level without more infrastructure than this feature warrants. Manual verification suffices.

**Manual verification checklist:**

1. In main group, say "新开个聊 X 的群" → Andy proposes name
2. Confirm name → `create_topic_group` invoked
3. New group appears in Feishu, user is pulled in, `registered_groups` DB has new row, `groups/feishu_<slug>/` folder exists with `CLAUDE.md` containing `## Topic` block
4. Send a message to the new group → Andy responds (no @ needed)
5. Simulate invite failure (e.g. revoke user permission temporarily): Andy reports partial failure, group still created

## Deployment

Three layers per NanoClaw's convention:

1. **Host service** — `npm run build` + `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
2. **Container image** — `./container/build.sh --no-cache --pull` (BuildKit COPY cache trap means `--no-cache` alone is insufficient; need to prune or use `--pull`)
3. **Capability docs** — `container/skills/capabilities/SKILL.md` updates take effect on next container start (bind-mounted)

## Rollback

- All additions are net-new files or net-new methods
- To disable: revert the capability docs (agent won't know the tool exists), even if code stays compiled
- To fully remove: `git revert` the implementation commits; new sync-IPC directories (`sync_requests/`, `sync_responses/`) are empty at rest and cost nothing
- No schema migration: `registered_groups` table reuses existing columns

## Not In This Iteration (YAGNI)

- Multi-member invitation beyond the requester (Q2-A)
- Topic inference from chat history without user confirmation (Q1-C)
- Automatic orphan-group cleanup / scheduled archival scan (user manually dissolves)
- Triggering from arbitrary registered groups (Q5-C gate is strict)
- Rollback on intermediate failures (Q3-B best-effort)
- Retrofit of existing `register_group` / `schedule_task` to use the new sync IPC (they work fine fire-and-forget)

## Related

- [2026-04-14-add-feishu-channel-design.md](2026-04-14-add-feishu-channel-design.md) — base Feishu channel that this builds on
- [2026-04-20-feishu-image-vision-design.md](2026-04-20-feishu-image-vision-design.md) — most recent Feishu extension, reference for spec style
- `container/agent-runner/src/ipc-mcp-stdio.ts:445` — existing `register_group` MCP tool (fire-and-forget reference)
- `groups/feishu_main/wiki/operations/managing-groups.md` — group management operations doc
