# Design: `/add-feishu` — Feishu (飞书) Channel for NanoClaw

**Date:** 2026-04-14
**Status:** Approved (design)
**Scope:** Add Feishu (国内版, open.feishu.cn) as a NanoClaw channel, following the `/add-telegram` and `/add-slack` skill-as-branch pattern.

---

## 1. Goal

Let a user talk to their NanoClaw assistant from a Feishu (国内飞书) bot — both in **private chat** (as the main/admin channel) and in **group chat via @mention** (each group isolated with its own `CLAUDE.md` and container).

Non-goals (explicit YAGNI):
- Lark (海外) support — domain selector only, not a separate code path in v1
- Image / file / audio / rich-post / interactive-card messages
- Message recall / edit sync
- Multi-tenant / multi-app deployment

---

## 2. Architecture

```
Feishu Open Platform (open.feishu.cn)
  └─ Self-built app (app_id + app_secret)
       └─ WebSocket long connection (no public URL needed)
              │
              ▼
  src/channels/feishu.ts  ──registerChannel('feishu', factory)──►  channel registry
              │
              ▼
  NanoClaw orchestrator (src/index.ts)
              │
              ▼
  Per-group container (Claude Agent SDK) ─► reply via im.message.create
```

Single Node.js process. No public ingress. Mirrors the Slack (Socket Mode) and Telegram (long-polling via grammy) shape already in the codebase.

---

## 3. Components

### 3.1 New files

- `src/channels/feishu.ts` — `FeishuChannel` class, self-registers via `registerChannel('feishu', factory)`. Returns `null` if `FEISHU_APP_ID` or `FEISHU_APP_SECRET` missing.
- `src/channels/feishu.test.ts` — unit tests (mock `@larksuiteoapi/node-sdk`).
- `.claude/skills/add-feishu/SKILL.md` — skill entrypoint (install flow).
- `.claude/skills/add-feishu/FEISHU_SETUP.md` — step-by-step console walkthrough.

### 3.2 Modified files

- `src/channels/index.ts` — append `import './feishu.js';`
- `package.json` — add dependency `@larksuiteoapi/node-sdk`
- `.env.example` — add `FEISHU_APP_ID=`, `FEISHU_APP_SECRET=`, `FEISHU_DOMAIN=feishu` (optional, `feishu|lark`, default `feishu`)

### 3.3 Distribution

Skill branch `feishu/main` on `github.com/qwibitai/nanoclaw-feishu` (or user's own fork). Installed via:

```bash
git remote add feishu <repo-url>
git fetch feishu main
git merge feishu/main
```

Same pattern as existing `/add-telegram`, `/add-slack`.

---

## 4. Channel → NanoClaw mapping

| Feishu event | Condition | NanoClaw target |
|---|---|---|
| `im.message.receive_v1`, `chat_type == "p2p"` | any text message | **main channel** (self-chat / admin) |
| `im.message.receive_v1`, `chat_type == "group"` | mentions bot's `open_id` | group keyed by `chat_id` |
| `im.message.receive_v1`, `chat_type == "group"` | not @bot | ignored |
| Non-text `msg_type` | any | ignored in v1 (logged) |

`chat_id` is the stable NanoClaw `groupId`. First time a `chat_id` is seen, orchestrator creates the group (same code path as Slack/Telegram).

---

## 5. Event subscription

Only one event: **`im.message.receive_v1`**.

Required permission scopes on the Feishu app:
- `im:message`
- `im:message.group_at_msg` (receive @bot in groups)
- `im:message.p2p_msg` (receive p2p messages)
- `im:chat` (read chat metadata)
- `im:message:send_as_bot` (reply)

Transport: **long-connection mode** (开发者后台 → 事件订阅 → 长连接模式). No `Verification Token` / `Encrypt Key` needed.

---

## 6. Sending replies

```ts
client.im.message.create({
  params: { receive_id_type: 'chat_id' },
  data: {
    receive_id: chat_id,
    msg_type: 'text',
    content: JSON.stringify({ text: replyText }),
  },
});
```

Group replies include a leading `<at user_id="..."></at>` mention of the original sender. Toggleable later; default on.

---

## 7. Error handling

| Failure | Behavior |
|---|---|
| WS disconnect | SDK auto-reconnect (exponential backoff). Log at info. |
| Send API 429 / 5xx | Log error; drop this reply; continue loop. Do not crash. |
| Send API 401 (bad creds) | Log error once; keep running; user must fix `.env`. |
| Missing `FEISHU_APP_ID` or `FEISHU_APP_SECRET` | Factory returns `null`; channel not registered (matches Slack/Telegram). |
| Unknown event payload shape | Log warn with event type; skip. |

Never crash the orchestrator on channel-side failures.

---

## 8. Testing

`src/channels/feishu.test.ts` — uses `vitest` + mocked `@larksuiteoapi/node-sdk`:

1. Factory returns `null` when env vars missing.
2. p2p text message → `onMessage` called with `groupId = chat_id` and main-channel flag.
3. Group message with @bot → `onMessage` called with `groupId = chat_id`.
4. Group message without @bot → `onMessage` NOT called.
5. Non-text `msg_type` → ignored.
6. `send()` calls `client.im.message.create` with correct `receive_id` and text payload.
7. WS connection errors don't throw out of channel start.

Target: all tests pass on `npx vitest run src/channels/feishu.test.ts`; `npm run build` clean.

---

## 9. Skill flow (`/add-feishu`)

### Phase 1 — Pre-flight
- If `src/channels/feishu.ts` exists, skip to Phase 3.
- Ask user: do they already have a Feishu self-built app?

### Phase 2 — Apply code
- `git remote add feishu <url>` if missing
- `git fetch feishu main && git merge feishu/main` (resolve `package-lock.json` with `--theirs` on conflict)
- `npm install && npm run build && npx vitest run src/channels/feishu.test.ts`

### Phase 3 — Feishu console setup
If no app yet, hand user `FEISHU_SETUP.md`. Summary:
1. Create self-built app at [open.feishu.cn](https://open.feishu.cn/app)
2. 添加"机器人"能力
3. 事件订阅 → 长连接模式 → 订阅 `im.message.receive_v1`
4. 权限管理 → 申请 scopes listed in §5
5. 版本管理与发布 → 创建版本 → 租户管理员审批
6. 拷贝 App ID / App Secret → fill `.env`
7. 拉机器人进群 / 发起私聊，测试 `@Andy ping`

---

## 10. Open questions deferred to implementation plan

- Exact `FeishuChannel` class shape — mirror `TelegramChannel` or `SlackChannel`? (Pick the closer one during plan stage.)
- Whether to emit `onChatMetadata` on first contact with a new `chat_id` (to fetch group name for nicer logs). Likely yes.
- Rate-limit handling beyond simple drop-and-log.

These will be resolved in the implementation plan (`writing-plans` skill), not here.
