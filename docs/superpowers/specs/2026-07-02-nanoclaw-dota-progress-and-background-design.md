# NanoClaw：DOTA 运行时进度可见 + 显式后台执行（设计 spec）

> 日期：2026-07-02　状态：草案（DOTA Phase 1 产出）
> 目标读者：nanoclaw 维护者

## 1. 背景与问题

在飞书群里让阿飞跑完整 DOTA（十几个 Phase、几十轮、派子任务 + Codex）时，用户观察到**整个群没有任何响应、像卡死**。根因有两层：

1. **看着像死（进度不可见）**：一个群一次只跑一个串行 query。长时间「等模型」或「限流退避」期间，agent-runner 不产出 `tool_use/tool_result` 事件，卡片就停在「⏳ 思考中…」不动。SDK 其实吐了 `rate_limit_event`（agent-runner 日志可见），但**没被转成卡片事件**，用户无从知道是被限流。卡片虽有 15s 心跳（`feishu.ts:1309`），但只刷新头部计时器、不带任何进度语义。
2. **真的没响应（前台被独占）**：DOTA 期间用户新发的消息被 `Piping IPC message into active query` 塞进正在跑的 DOTA 上下文，不会单独回复 → 群在这段时间无法处理任何别的对话。

## 2. 目标 / 非目标

**目标**

- **A**：DOTA/长任务运行期间，卡片显式反馈「跑到哪 / 是否被限流」，而不是恒定一句「思考中」。
- **B**：用户**显式说「后台跑」**时，把重活丢到后台执行，前台群保持可响应；**默认仍前台**（行为不变）。

**非目标（明确不做）**

- 不解决账号额度 / 并行多跑（那要多号或 API Key，见 [背景排查]）。B 只治「别阻塞」，不承诺「能并行多个 DOTA 不 429」。
- 不改按群绑定账号（`buildProcessEnv` 仍单一全局 token）。
- 不给 runQuery 加「流式 stall 超时→abort 重试」（已确认在 429 场景下有害；本 spec 走「限流可见」而非「abort」）。

## 3. 增量 A：运行时进度可见 + 限流可见

**A1 — 限流可见（核心）**

- agent-runner 的 `for await` 消费循环里，识别 `message.type === 'rate_limit_event'` **且 `rate_limit_info.status === 'rejected'`**（`allowed`/`allowed_warning` 是正常心跳，不算限流），转成 `emitEvent('notice', { kind: 'rate_limit', text })`。（不带 `retryAtMs`：实测 Max/OAuth 429 常无 `retry-after`，YAGNI。）
- feishu `onAgentEvent` 收到 `notice/rate_limit` → 卡片状态行改为 `⏳ 账号限流中，等待重试…`；限流解除后（下一条正常 assistant/tool 事件到达）恢复为常规运行态。

**A2 — 阶段/活动进度（轻量）**

- 现在卡片只有「思考中」+ 工具计数。补一个「最近动作」语义：收到 `tool_use` 时状态行显示当前工具名（已有 tool_use 事件，只需渲染）；收到 SDK `task_*`（`task_started/task_progress/task_notification`，日志已出现）时，转成 `notice` 事件在卡片上显示「子任务：<summary> <status>」。
- 不引入 DOTA-phase 专用协议（阿飞在群里输出的 `▶ Phase N` 文本已是天然进度）；A2 只保证「有动作就有反馈」，覆盖「等模型 + 跑子任务」这两段静默期。

**A3 — 心跳语义增强**

- 心跳 patch 时，若当前处于限流态则保持限流文案；否则显示已运行时长 + 最近动作，避免「计时器在动但看不出在干嘛」。

判据：跑 DOTA 时，卡片任一时刻都能看出「在跑哪个工具/子任务」或「在限流等待」，不再出现「计时器动、内容恒为思考中」超过一个心跳周期（15s）的情况（限流态除外，限流态有明确文案）。

## 4. 增量 B：显式后台执行（"后台跑"）

> ⏸️ **状态：已推迟（2026-07-02，DOTA Phase 3 审查后决策）。** Codex 审查证实 B 设计有两处 CRITICAL：SDK 无 `run_in_background`（应走 `background?: boolean`），且前台 `final` 会拆卡片 session 导致后台回帖被丢弃——B 需要「卡片 session 跨前台单轮 + 按 task_id 独立卡片」的架构级重做，超出本轮范围。**A 先上，B 另起 spec/spike。** 约束见记忆 [[nanoclaw_background_task_card_lifecycle]]。以下为原始设计，重做时参考。

**触发（用户拍板）**：默认前台（现状不变）。仅当用户消息**显式**含「后台跑 / 后台执行 / run in background」类意图时，走后台。识别方式待 Phase 2 定：优先「前台阿飞被指示用 Task 的 `run_in_background` 派 DOTA」这种 skill/prompt 层做法，而非在 host 侧硬解析中文关键词（避免误判 [[feedback_andy_confirm_before_code]] 式事故）。

**执行模型**：借现有 SDK Task 机制（日志已有 `task_started/progress/notification`）。

```
用户:「后台跑完整 DOTA」
  └─ 前台阿飞: 用 Task(run_in_background) 派出 DOTA 任务
        ├─ 立刻回:「已后台开跑 DOTA，你继续说别的」  ← 前台 query 空出来
        └─ 后台任务跑 DOTA → 进度经 task_progress/notification 回帖卡片(复用 A 的 notice 渲染)
  └─ 前台: 之后用户新消息正常单独处理(不再被塞进 DOTA 上下文)
```

**关键约束**

- 前台 ack 必须在派出后**立即返回**，不阻塞等待后台完成。
- 后台任务完成 / 失败 → 通过 `task_notification` 明确回帖（成功给 PR 链接等，失败给原因，含「被限流」）。
- 后台任务的进度回帖不能和前台新对话的卡片打架（runId 隔离，参考 [[nanoclaw_feishu_card]] 的 runId 约束）。

**待 Phase 2 明确的设计点**

- 「显式后台」到底在哪层识别（skill 指令 vs host 解析 vs MCP 工具参数）。
- 后台任务的进度/结果如何映射到飞书卡片（新卡片 vs 原卡片续帖）。
- 前后台并发时 IPC/session 的隔离（现在是单 warm session，后台是否独立 session）。

## 5. 触点文件

| 文件 | 改动 |
|------|------|
| `container/agent-runner/src/index.ts` | `for await` 里识别 `rate_limit_event` / `task_*` → `emitEvent('notice', …)`；B 的后台派发相关（Phase 2 定） |
| `src/channels/feishu.ts` | `onAgentEvent` 加 `notice` 分支渲染；心跳文案增强；后台任务进度回帖 |
| `src/types.ts` | `AgentEvent` 增加 `notice` kind 及其 payload 类型 |
| `container/agent-runner/src/index.test.ts` | A/B 的单测 |
| （B 可能涉及）`src/host-runner.ts` / task 相关 | 前后台隔离，Phase 2 定 |

## 6. 成功判据

- **A**：构造一个「限流 / 长子任务」场景，卡片显示 `账号限流中…` / `子任务：…`，而非恒定「思考中」。单测覆盖 `rate_limit_event → notice` 与 `task_* → notice` 的转换。
- **B**：显式说「后台跑」→ 前台立即 ack 并放行后续消息（前台可在后台任务未完成时回复新消息）；不说则前台行为与现状一致（回归测试保证默认路径不变）。
- 全量 `npm run build` + 现有测试全绿；新增测试全绿。

## 7. 风险与权衡

- **B 与共享账号的张力**：B 让「边跑边聊」，但用它并行多个 DOTA 会更快打爆账号 A → 429。文档需写明 B ≠ 并行扩容。
- **卡片并发**：前后台同时更新卡片易串台，必须用 runId 严格隔离（历史事故见 [[debugging_feishu_card_stuck]] 的 compact 重置卡片）。
- **中文关键词误判**：若在 host 侧解析「后台跑」，口语变体多、易误触发；优先 skill/工具参数层显式化。
- **DOTA 自身开发锁 Bash**：在本仓库跑 DOTA（superpowers TDD+plans）可能凑齐 dota-audit 锁；卡住时按 [[reference_dota_audit_hook_blocks_bash]] 清 `.omc/dota-audit.log` 复位。
