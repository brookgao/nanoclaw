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

The Feishu channel ships as part of this fork on branch `feature/add-feishu-channel`. If you are installing into a different fork, adapt the merge step below.

Ensure installed:

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
6. 凭证 → 复制 App ID (`cli_xxx`) 和 App Secret

### Configure `.env` and sync to container

Append (or edit) `.env`:

```
FEISHU_APP_ID=cli_xxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
FEISHU_DOMAIN=feishu
```

Sync to container env file (container reads `data/env/env`, not `.env` directly):

```bash
mkdir -p data/env && cp .env data/env/env
chmod 600 .env data/env/env
```

## Phase 4: Registration

For each Feishu chat you want to talk from, collect the `chat_id` (visible in the delivery logs after sending a test message, or via Feishu admin console), then register it:

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
npm run dev   # or the repo's run command
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
3. App version published and tenant-admin-approved
4. Permissions active (changing scopes requires a new version + re-approval)

## Uninstall

1. Remove env vars from `.env` and `data/env/env`
2. Remove registrations:
   ```bash
   sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'feishu:%'"
   ```
3. Remove code: delete `src/channels/feishu.ts` + test, remove `import './feishu.js'` from `src/channels/index.ts`, remove `@larksuiteoapi/node-sdk` from `package.json`.
