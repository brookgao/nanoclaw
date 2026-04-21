# NanoClaw Feishu 图片 Vision

> 给 Andy 接入飞书图片消息（`image` / `post` 类型）的多模态链路
> 写入: 2026-04-21 · 来源: 实操 session（feat/feishu-image-vision，14 commits）

## 架构

图片从飞书到 Claude SDK 穿越 8 层：

```
Feishu WS → feishu.ts.handleEvent
          → parseInbound（解析 post/image msg_type，抽 text + imageKeys）
          → processImageKeys（并发下载 + sharp 缩放 + base64）
          → onMessage → storeMessage（写 DB）
          → Poll loop: getMessagesSince（读 DB）
          → formatMessages（返回 {xml, images}，插 [图 N] 占位）
          → runAgent(prompt, chatJid, onOutput, images)
          → runContainerAgent(ContainerInput{prompt, images})
          → 容器 stdin JSON（首条）或 group-queue IPC 文件（30min 复用期）
          → MessageStream.push(text, images) → ContentBlockParam[]
          → Claude Agent SDK query()
```

**任何一层漏传 `images` 就挂** —— 本次 14 commits 里有 6 个是 layer 间漏传/反序列化/schema 不匹配导致的。

## 关键技术点

• **下载端点（要命易错）**：飞书 IM 消息里的图用 `GET /open-apis/im/v1/messages/{message_id}/resources/{file_key}?type=image`，**不是** `/im/v1/images/{key}`。后者只给 upload-API 上传的图用。错的端点返回 400 `{code:234001, "Invalid request param."}`
• **`@larksuiteoapi/node-sdk` 的 Client 自动管 `tenant_access_token`**：直接 `this.client.request({url, params, responseType:'arraybuffer'})`，不用手动缓存 token
• **sharp 参数**：`.rotate().resize(1568, 1568, {fit:'inside', withoutEnlargement:true}).jpeg({quality:85, mozjpeg:true})`。1568px 是 Claude 官方推荐上限，超了被模型内部降采样白烧 token
• **SDK 多模态 API shape**：`SDKUserMessage.message = MessageParam`，`content: string | ContentBlockParam[]`，`ImageBlockParam = {type:'image', source:{type:'base64', media_type, data}}`
• **post 消息结构**：`content` JSON 是二维数组，段落 × 段内元素；元素 `tag: text | at | img | code_block | a | emoji | ...`；`at` 的 `user_id` 可能是真 id 也可能是 `@_user_N` 占位符（查 `mentions[]` 数组的 `name` 字段映射）

## 踩的坑（防再踩）

### 1. BuildKit COPY 缓存陷阱
`./container/build.sh` 默认不带 `--no-cache`，buildkit 缓存 COPY 步骤，**改了 agent-runner 源码镜像里还是旧代码**。
- `docker buildx prune -f` 不清 COPY 缓存
- 必须 `docker build --no-cache --pull -t nanoclaw-agent:latest container/`
- 验证姿势：`docker run --rm --entrypoint sh nanoclaw-agent:latest -c 'grep -c <新代码特征> /app/dist/index.js'`

### 2. DB `content != ''` 过滤杀纯图消息
`getMessagesSince` (db.ts:395) 有硬过滤 `AND content != '' AND content IS NOT NULL`。纯 `image` 消息 parseInbound 返回 `text:''`，插 DB 后被 poll 过滤跳过，永不触发 agent。
- 解法：parseInbound 在 text 空且 imageKeys 非空时注入 `[图片]` 占位符

### 3. `images[]` 必须进 DB
`storeMessage` 原 schema 只有 11 列无 images。channel 收图 → deliver → 插 DB → poll 读回 → images 消失。必须 `ALTER TABLE messages ADD COLUMN images TEXT` + `JSON.stringify` 存 + hydrate 读。

### 4. IPC 通道是两条
容器首条消息走 stdin `ContainerInput` JSON；30min 复用期走 `data/ipc/{groupFolder}/input/*.json` 文件，schema `{type:'message', text, images?}`。**两条都要扩**，只扩一条就丢图。

### 5. `runAgent` 5 参问题
`runAgent(group, prompt, chatJid, onOutput, images?)` 第 5 参可选。callsite 很容易漏传（`runAgent(group, prompt, chatJid, callback)` → images=undefined）。TS 不报错、测试也不挂、运行时静默降级成纯文本。

### 6. 容器 stderr 不保存
`container.stderr` 在 container-runner 里只缓冲；**成功时丢弃**，仅失败（timeout）时落盘到 `logs/container-*.log`。调试要改成写 bind-mounted 文件（如 `/workspace/group/.probe.log` 映射到 `groups/<folder>/.probe.log`）

## 错误处理约定

• 下载失败（403/404/timeout/>10MB/解码错/key 不合法）→ `FailReason` 枚举分类
• 任何一张图失败 → 整条消息不投递，回复 `🖼️ 图没收到(原因)，能重发吗？`
• 纯图片 + 多图部分失败 → `🖼️ N 张图有 K 张没收到...`
• 超过 5 张 → 处理前 5 + `[系统: 本条消息含 N 张图，仅处理前 5 张]`
• IPC 文件 >8MB 硬上限 → 拒收 + `消息体过大（含图），请分次发送`

## 验证 & 调试姿势

• **探针模式**：在 `MessageStream.push` 或 `drainIpcInput` 写一行到 bind-mounted 文件，host 可 tail 验证
• **音频日志**：`[feishu] image attached` INFO 级别记 `msg_id / image_count / total_base64_bytes / feishu_keys`
• **usage 里图 token 解读**：Sonnet 每张 1568px 图 ≈ 1600 tokens。如果图入了 prompt cache（SDK 透明处理），下一次请求的 `cacheReadTokens` 会算上；新请求 `inputTokens` 只反映新增 text

## 相关 commits

本次实施的完整 commit 链在 `feat/feishu-image-vision` 分支（spec: `docs/superpowers/specs/2026-04-20-feishu-image-vision-design.md`，plan: `docs/superpowers/plans/2026-04-20-feishu-image-vision.md`）。

## 相关 Wiki

- [`nanoclaw-ipc-event-system.md`](nanoclaw-ipc-event-system.md) — IPC 文件 schema
- [`nanoclaw-stale-container.md`](nanoclaw-stale-container.md) — 容器复用/重启语义
- [`nanoclaw-feishu-interactive-card.md`](nanoclaw-feishu-interactive-card.md) — 飞书卡片会话
