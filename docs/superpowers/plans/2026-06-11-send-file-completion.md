# Send-File Tool Chain Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 补完 `mcp__nanoclaw__send_file` 的另一半：MCP server (`container/agent-runner/src/ipc-mcp-stdio.ts`) 已注册工具，写 IPC 文件含 `type: 'file'`，但 nanoclaw 主进程 (`src/ipc.ts`) 无处理分支 + `src/channels/feishu.ts` 无 sendFile 实现 + `src/types.ts` Channel 接口无 sendFile 字段。3 个红测试（`src/ipc-file.test.ts`）记录了期望但实现未做。本 PR 让 5/5 红测试变绿 + 阿飞 send_file 调用真的发文件到飞书。

**Architecture:** 加 Channel.sendFile?(jid, filePath, filename?) 可选方法（其他 channel 不实现仍兼容）。Feishu 实现走 Lark `/open-apis/im/v1/files` 上传拿 file_key → `im.message.create` msg_type=file。ipc.ts 加 `data.type === 'file'` 分支，镜像 message branch 的 auth + audit + 删 IPC 文件模式。index.ts startIpcWatcher 依赖注入加 sendFile。

**Tech Stack:** TypeScript, @larksuiteoapi/node-sdk (已有), vitest. 零新依赖。

---

## File Structure

| 文件 | 改动 |
|---|---|
| `src/types.ts` | Channel 接口加 `sendFile?(jid, filePath, filename?): Promise<void>` 可选方法 |
| `src/channels/feishu.ts` | 加 `async sendFile()` method：multipart 上传到 `/open-apis/im/v1/files` 拿 file_key → `im.message.create` msg_type=file |
| `src/ipc.ts` | 加 `data.type === 'file'` 分支，类比 line 109-127 message 模式 |
| `src/index.ts` | startIpcWatcher 调用处 deps 注入加 sendFile callback |
| `src/ipc-file.test.ts` | **不动**（已有测试就是规格）|

---

## Task 1: 写测试已存在；先跑确认 RED

**Files:**
- Read: `src/ipc-file.test.ts`（160 行，5 测试）

- [ ] **Step 1: 跑测试看 3 红 2 绿**

```bash
npx vitest run src/ipc-file.test.ts 2>&1 | tail -15
```
Expected: 3 failed / 2 passed（已确认）

- [ ] **Step 2: 标记 RED**

记录当前 fail 的 3 个测试名 + 期望行为。

---

## Task 2: Channel 接口加 sendFile

**Files:**
- Modify: `src/types.ts:130` Channel interface 块

- [ ] **Step 1: 加可选方法签名**

```typescript
// 在 Channel interface 里 sendMessage 之后追加
sendFile?(
  jid: string,
  filePath: string,
  filename?: string,
): Promise<void>;
```

- [ ] **Step 2: build 验证**

```bash
npm run build
```
Expected: 0 errors

- [ ] **Step 3: commit**

```bash
git add src/types.ts
git commit -m "feat(channel): add optional sendFile method"
```

---

## Task 3: feishu.ts 实现 sendFile

**Files:**
- Modify: `src/channels/feishu.ts:1303`（isConnected 之前插入新 method）

- [ ] **Step 1: 写 sendFile 实现**

```typescript
async sendFile(
  jid: string,
  filePath: string,
  filename?: string,
): Promise<void> {
  if (!jid.startsWith(JID_PREFIX)) {
    throw new Error(`Not a Feishu JID: ${jid}`);
  }
  const chatId = jid.slice(JID_PREFIX.length);

  if (!fs.existsSync(filePath)) {
    throw new Error(`File does not exist: ${filePath}`);
  }
  const stat = fs.statSync(filePath);
  const displayName = filename ?? path.basename(filePath);

  // Upload via multipart to /open-apis/im/v1/files; returns file_key
  const FormData = (await import('form-data')).default;
  const form = new FormData();
  form.append('file_type', 'stream');
  form.append('file_name', displayName);
  form.append('file', fs.createReadStream(filePath), {
    filename: displayName,
    knownLength: stat.size,
  });

  const uploadRes: any = await this.client.request({
    method: 'POST',
    url: '/open-apis/im/v1/files',
    data: form,
    headers: form.getHeaders(),
  });
  const fileKey: string | undefined =
    uploadRes?.data?.file_key ?? uploadRes?.file_key;
  if (!fileKey) {
    logger.error({ jid, filePath, uploadRes }, '[feishu] file upload returned no file_key');
    throw new Error('Feishu file upload returned no file_key');
  }

  await this.client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      msg_type: 'file',
      content: JSON.stringify({ file_key: fileKey }),
    },
  });

  logger.info({ jid, filePath, displayName, fileKey }, '[feishu] file sent');
}
```

注意：
- `form-data` 已在 transitive deps（lark SDK 用），可直接 `await import` 拿到
- 错误时抛 Error，由 ipc.ts catch 处理

- [ ] **Step 2: 加 fs / path imports（如果还没）**

文件顶部确认已 `import fs from 'fs'` 和 `import path from 'path'`（看现有 downloadFile 用了 fs，应该已有）

- [ ] **Step 3: build**

```bash
npm run build
```
Expected: 0 errors

- [ ] **Step 4: commit**

```bash
git add src/channels/feishu.ts
git commit -m "feat(feishu): implement sendFile via Lark multipart upload + msg_type=file"
```

---

## Task 4: ipc.ts 加 type=file 分支

**Files:**
- Modify: `src/ipc.ts:109` 后追加 file 分支

- [ ] **Step 1: 镜像 message 模式加 file 分支**

```typescript
// 在 `if (data.type === 'message' && data.chatJid && data.text) { ... }` 之后追加
if (data.type === 'file' && data.chatJid && data.path) {
  const targetGroup = registeredGroups[data.chatJid];
  if (
    isMain ||
    (targetGroup && targetGroup.folder === sourceGroup)
  ) {
    if (!deps.sendFile) {
      logger.warn(
        { chatJid: data.chatJid, sourceGroup },
        'IPC file: channel has no sendFile implementation',
      );
    } else {
      try {
        await deps.sendFile(data.chatJid, data.path, data.filename);
        logger.info(
          { chatJid: data.chatJid, sourceGroup, path: data.path },
          'IPC file sent',
        );
      } catch (err) {
        logger.error(
          { chatJid: data.chatJid, sourceGroup, err },
          'IPC file send failed',
        );
      }
    }
  } else {
    logger.warn(
      { chatJid: data.chatJid, sourceGroup },
      'Unauthorized IPC file attempt blocked',
    );
  }
}
```

- [ ] **Step 2: types deps interface 加 sendFile**

在 `IpcWatcherDeps` interface 里加 `sendFile?: (jid: string, filePath: string, filename?: string) => Promise<void>`

- [ ] **Step 3: build**

```bash
npm run build
```

- [ ] **Step 4: commit**

```bash
git add src/ipc.ts
git commit -m "feat(ipc): route type=file messages to channel.sendFile"
```

---

## Task 5: index.ts 注入 sendFile 依赖

**Files:**
- Modify: `src/index.ts`（startIpcWatcher 调用处）

- [ ] **Step 1: 在 deps 对象里加 sendFile**

类比 sendMessage：

```typescript
sendFile: async (jid, filePath, filename) => {
  const channel = findChannel(channels, jid);
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  if (!channel.sendFile) {
    throw new Error(
      `Channel ${channel.name} does not support file attachments`,
    );
  }
  return channel.sendFile(jid, filePath, filename);
},
```

- [ ] **Step 2: build**

```bash
npm run build
```
Expected: 0 errors

- [ ] **Step 3: commit**

```bash
git add src/index.ts
git commit -m "feat(orchestrator): wire sendFile callback into IPC watcher"
```

---

## Task 6: Phase 7 — 跑测试 + 全套回归 + smoke

- [ ] **Step 1: ipc-file 5/5 绿**

```bash
npx vitest run src/ipc-file.test.ts 2>&1 | tail -10
```
Expected: 5 passed, 0 failed

- [ ] **Step 2: 全套回归**

```bash
npx vitest run 2>&1 | tail -6
```
Expected: 全过

- [ ] **Step 3: build clean**

```bash
npm run build
```
Expected: 0 errors

- [ ] **Step 4: 主目录 pull + 重启 nanoclaw + 阿飞 send_file smoke**

```bash
# 在主目录
cd /Users/admin/Desktop/vibe-coding/nanoclaw
git pull
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# 然后到测试用例生成群 / PRD-review 群跟阿飞说"发 SKILL.md"
# 验证：飞书群真的收到 .md 文件附件
```

如果 smoke 失败：可能是 Lark file API path 不对或权限问题，看 nanoclaw.log 找 `[feishu] file upload` 日志。

---

## Task 7: Phase 8 — PR + 等 merge

```bash
git push -u origin feat/send-file-completion
gh pr create -R brookgao/nanoclaw --base main --head feat/send-file-completion \
  --title "feat(feishu): complete send_file tool chain" \
  --body "..."
```

默认停手，等用户「合了」。

---

## Self-Review

### Spec coverage
- ✅ Channel.sendFile? 接口 (Task 2)
- ✅ Feishu sendFile 实现 (Task 3)
- ✅ ipc.ts file 分支 + auth check (Task 4)
- ✅ index.ts deps 注入 (Task 5)
- ✅ 5/5 测试绿 (Task 6 Step 1-3)
- ✅ smoke 行为验证 (Task 6 Step 4)
- ✅ PR + 等 merge (Task 7)

### 风险点
1. **Lark `/open-apis/im/v1/files` 上传 API 实际响应格式**：plan 假设 `data.file_key` 路径，但 SDK 包装可能不同。Smoke 必跑。
2. **form-data 包**：是 Lark SDK 的 transitive dep，`await import('form-data')` 应能拿到。如果运行时不行，需要 `npm install form-data --save`。
3. **filename 含中文 / 空格**：Lark API 一般用 UTF-8，应 OK；smoke 验证一下。
4. **大文件**：im.v1.files 限制 30MB (file_type=stream)。SKILL.md 才 6KB，不是问题。
