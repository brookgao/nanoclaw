# 设计：阿飞读合并转发的聊天记录（merge_forward 展开）

- 日期：2026-07-02
- 分支：`feat/feishu-read-comments`（在此分支上继续，或按需新建 `feat/feishu-read-merge-forward`）
- 触达文件：`src/channels/feishu.ts`、`src/channels/feishu.test.ts`

## 背景与问题

用户在飞书群 / 私聊里把一段「会话记录」以**合并转发（merge_forward）**的形式发给阿飞（NanoClaw 飞书通道），
希望阿飞能读到里面的真实内容（例如拿一段对话记录当上下文生成 PRD）。

现状：阿飞回复「读不到内容——消息里只有标签 `(merge_forward) Merged and Forwarded Message`」。

### 根因（已由飞书官方文档确认）

- `merge_forward` 消息的正文（`body.content`）**永远是固定占位符** `{"content":"Merged and Forwarded Message"}`，
  真实内容不在这里。
- 要拿真实内容，调用「获取指定消息内容」`GET /open-apis/im/v1/messages/{message_id}` 时，
  返回的 `data.items` 是 **1 条合并转发容器 + N 条子消息**，子消息用 `upper_message_id` 标识层级。
- 现有代码 `src/channels/feishu.ts:734` 拉到父消息后只取 `items[0]`（容器占位符），
  **`items[1..N]`（真正的子消息）全被丢弃**，于是阿飞只看到占位符。

文档来源：
- [接收消息内容结构 / merge_forward](https://open.feishu.cn/document/server-docs/im-v1/message-content-description/message_content?lang=zh-CN)
- [获取指定消息的内容](https://open.feishu.cn/document/server-docs/im-v1/message/get?lang=zh-CN)

**关键结论：数据本来就在同一个 API 调用里返回，不需要新接口，现有代码只是把子消息扔了。**

## 目标 / 非目标

### 目标

- 阿飞能把合并转发的聊天记录展开成可读的**文字转录**喂给模型。
- 展开转录里的**内联图片**（下载为多模态块，设上限防 token 爆炸）。
- 支持两个入口：
  1. **群里回复合并转发消息并 @阿飞**（截图场景；群里无法在转发本身 @，只能靠回复+@）。
  2. **私聊里直接把会话记录转发给阿飞**（p2p 无需 @）。

### 非目标（本期不做，YAGNI）

- 不抽取转发里**文件附件的正文**（md/txt/pdf 等）——本期文件只标注 `[文件: 名字]`。
- 不还原嵌套转发的树形层级——扁平按时间平铺即可。
- 不做转发内容的持久化 / 二次检索。

## 方案

### 1. 共享 helper：`expandMergeForward()`

两个入口共用一个函数，避免重复解析逻辑（遵循「多调用点抽 helper」惯例）。

```
函数签名（示意）：
  async expandMergeForward(items: FeishuMessageItem[]): Promise<{
    transcript: string;
    imageAttachments: ImageAttachment[];
    truncated: { messages: boolean; images: number };  // 用于给用户/日志提示
  }>
```

处理逻辑：

1. 从 `items` 中**剔除** `msg_type === 'merge_forward'` 的容器条目，剩下的是子消息。
2. 按 `create_time` 升序排序（缺字段时保持 API 返回顺序）。
3. 逐条渲染成 `发件人: 内容`：
   - 发件人名：`resolveSenderName(sender.id.open_id)`（带缓存 + 按 open_id 去重，少发请求）；解析失败回退 open_id。
   - 按 `msg_type`：
     | 子消息类型 | 渲染 |
     |---|---|
     | `text` | 文字（复用 `parseInbound` 的 text 分支） |
     | `post` | 文字（复用 `parseInbound` 的 post 解析；内嵌图片计入图片预算） |
     | `image` | `[图片]` 占位 + 在预算内 `downloadImage(childMsgId, image_key)` |
     | `file` | `[文件: file_name]` |
     | 其他（`share_chat` / `interactive` / `system` …） | `[<msg_type>]` |
4. 图片下载复用现有 `processImageKeys`（含并发控制 + 失败处理），累计到全局上限 `MAX_FORWARD_IMAGES`。
5. 应用上限（见「边界与限制」），超限时在 transcript 末尾追加系统提示行。

transcript 输出格式（示意）：

```
[合并转发的聊天记录 · 共 4 条]
建波(Bobo): MRD-七夕心愿互动玩法 你使用这个skill帮我通过这个mrd生成一个prd
Nine-dev: 🔧 Skill
Nine-dev: MRD 已完整读取。这是一份七夕心愿互动玩法的 MRD，包含三个阶段：心愿点亮、心愿免单、心愿聚榜…
```

### 2. 两个接入点

```
收到消息
  ├─ 私聊直发 merge_forward（feishu.ts:630 处，原本 parseInbound 返回 null 被 drop）
  │     → GET /messages/{m.message_id} 拿 items → expandMergeForward → 构造 parsed
  │
  ├─ 群里回复 merge_forward 并 @阿飞（feishu.ts:734 处，parentRes.data.items 已含子消息）
  │     → 直接把 parentRes.data.items 喂 expandMergeForward
  │     → transcript 拼进 cleanedText，图片并入 attachments
  │
  └─ 其他消息类型：原有逻辑完全不变
```

- **群 / 回复@ 路径**（`feishu.ts:719-791`）：父消息是 `merge_forward` 时，`parentRes.data.items` 已经包含
  容器 + 子消息，直接喂 helper；transcript 追加到 `cleanedText`，图片并入现有 `attachments` 数组，
  同时写入 `replyToInfo.content`。
- **私聊 / 直接转发路径**（`feishu.ts:628-636`）：`m.message_type === 'merge_forward'` 时不再 drop；
  补一次 `GET /open-apis/im/v1/messages/{m.message_id}` 拿 items，喂 helper，
  用返回的 transcript / 图片构造一个合成的 `parsed`（`text = transcript`, `imageKeys/attachments = 下载结果`），
  再走后续正常流程。
- 群里裸转发（无回复无 @）在群 gate（`feishu.ts:642-655`）本就会因未 @ 被拦掉——符合预期，群走回复+@ 路径。

### 3. 边界与限制

- **图片上限** `MAX_FORWARD_IMAGES`（常量，默认 `10`，可选 env 覆盖）：超出的图片保留 `[图片]` 文字占位，
  并在末尾提示「本条合并转发含 X 张图，仅处理前 10 张」。
- **条数上限** `MAX_FORWARD_MESSAGES`（默认 `200`）+ **字符上限**（默认 `~8000` 字符）：超出截断并标注
  「记录过长，仅展开前 N 条」。
- 单张图片 ≤10MB（沿用现有 `downloadImage` 的 `maxContentLength`）。
- 嵌套转发：`items` 已被飞书扁平化，直接按时间平铺。
- 外部 / 跨租户发件人：`resolveSenderName` 失败回退 open_id，不抛错。
- 429 退避：图片下载走 `processImageKeys` 并发控制；发件人名去重 + `nameCache` 缓存。

### 4. 待实测 —— 实现第一步（gating，不猜、curl 实测）

**这是唯一可能推翻整个方案的点，必须最先验。**

用截图里那条真实合并转发消息（从 `messages.db` / feishu 日志找到 reply 消息的 `parent_id`，即 merge_forward 的
message_id），以**阿飞机器人自己的 tenant token**（cli_a90a12c46ef9dbc2，poizon.feishu.cn）curl：

```
GET /open-apis/im/v1/messages/{merge_forward_message_id}
```

确认三件事：
1. `data.items` 确实返回 N 条子消息（不止容器）；
2. **阿飞对来自另一个会话（建波↔Nine-dev）的子消息有读权限**（转发进来的载荷 vs 原会话实时引用）；
3. 子消息的 `sender.id.open_id` / `create_time` / `upper_message_id` / `body.content` / `msg_type` 字段齐全。

若 (2) 不通过 → 该功能在飞书 API 层走不通 → **降级**：保持现状（提示用户粘贴文字 / 截图），不硬做。

### 5. 测试

- 单测 `expandMergeForward`（复用 `feishu.test.ts` 的 mock 风格）：
  - 纯文字子消息 → 断言 transcript 行格式与发件人前缀；
  - 含图子消息 → 断言图片进入 `imageAttachments` 且不超上限；
  - 超图片上限 → 断言截断标注 + 占位保留；
  - 超条数上限 → 断言截断标注；
  - 含 file / 未知类型 → 断言 `[文件: ...]` / `[<type>]` 占位；
  - 空 items / 只有容器 → 断言优雅返回空。
- 单测两个接入点路由：
  - 群回复 merge_forward 父消息 → transcript 进入 `cleanedText`；
  - 私聊直发 merge_forward → 不再被 drop，走展开路径。

## 风险 / 降级

| 风险 | 应对 |
|---|---|
| 阿飞对跨会话子消息无读权限（最高风险） | 实现第一步 curl 实测；不通过则降级回现状，不硬做 |
| 大转发导致 token / 成本爆炸 | 图片 + 条数 + 字符三重上限，超限截断标注 |
| 大量发件人名解析触发 429 | open_id 去重 + `nameCache` 缓存 |
| 图片下载 429 / 超时 | 复用 `processImageKeys` 并发控制与失败处理 |

## 验证结果（2026-07-02，实测门控 Task 1）

对截图里那条真实合并转发消息 `om_x100b6b56484034b0b2ab88541dc6476`（pm-lite 群 `oc_38cc3d4e05...`），
用 NanoClaw 飞书 bot 自己的 tenant token curl `GET /open-apis/im/v1/messages/{id}`：

- ✅ **权限过关**：`code:0 success`，返回 8 条 items（1 容器 + 7 子消息）；`msg_type`/`message_id`/
  `upper_message_id`/`create_time`/`sender.id` 字段齐全。阿飞**能**读跨会话子消息。
- ✅ **text 子消息可读**：拿到真实正文（如 `建波: https://…wiki… 你使用这个skill…`、`建波: B端和C端都有…券包。`）。
- ⚠️ **interactive 卡片子消息不可读（飞书硬限制）**：7 条里有 5 条是 interactive 卡片（Nine-dev/机器人的回复），
  API 只返回占位符 `{"elements":[[{"tag":"img",…},{"tag":"text","text":"请升级至最新版本客户端，以查看内容"}]]}`，
  **无任何真实内容**。交互卡片是客户端渲染的，服务端消息 API 拿不到卡片正文，无解。

### 决策（Option A，用户离线时按最佳判断推进，Phase 7 复核）

照建，诚实降级：
- `text` / `post` 正常展开为真实文字。
- `interactive` 卡片渲染为 `[卡片消息]`（**不**把 “请升级至最新版本客户端” 噪声塞给模型），并计数。
- 当存在不可读卡片时，transcript 末尾追加系统提示：`[系统: 含 N 条卡片消息，飞书 API 无法读取其内容]`，
  让模型/用户知道有内容缺失。
- 其余不变（`file` → `[文件: 名字]`，其它类型 → `[<type>]`）。

价值边界：人对人**文字**对话完美可读；机器人**卡片**回复读不到（飞书限制）。此决策可逆（在 feature 分支未合并），
Phase 7 向用户复核，用户可否决或改走「跟文档链接读源档」的扩展方案。
```
