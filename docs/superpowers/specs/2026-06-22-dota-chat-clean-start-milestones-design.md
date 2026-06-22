# DOTA 原地优化:干净启动 + 阶段里程碑(方案 A)

- 日期:2026-06-22
- 状态:已批准设计,待实现
- 关联:#1 已修 `token-footer.ts` ctx% 显示 bug(本 spec 不含);B-via-tmux 为后续独立 spec

## 背景与问题

飞书群里显式触发 DOTA 全管线时,体感"一直卡住"。诊断(pm-lite 群,2026-06-22)确认**不是死锁**,而是又慢又贵,根因两条:

1. **乙(真的慢/贵)**:DOTA run 跑在"一群一持久 session"的复用会话上,拖着当天累积的上下文。DOTA 一跑就是 8 个 Phase / 30+ turns,每一轮都把整坨上下文重读一遍 → 单次 ~18min / ~$1.9。其中"写飞书 PRD 文档"时 `append_blocks` 被飞书真限流(429),反复等 60–120s 冷却,进一步拖长。
2. **甲(像冻住)**:18 分钟全程只有一张流式卡片显示"思考中/运行中",用户看不到推进到哪一步,无法判断是否还活着。

> 注:卡片上吓人的 `ctx:960%` 是另一个独立显示 bug(累计缓存读 ÷ 单窗口),已在 #1 单独修复,不在本 spec 范围。

## 目标

- 治"乙":DOTA 启动时把会话上下文压小,且从源头减少 `append_blocks` 429。
- 治"甲":DOTA 跑动时每跨一个 Phase 边界回贴一条里程碑消息,用户随时知道走到哪。
- 轻改、原地优化,**不动"一群一 session"架构**;为后续 B-via-tmux 留口,A 不阻塞 B。

## 非目标(YAGNI)

- 不接后台任务队列、不引入独立异步会话(那是 B-via-tmux,后续独立 spec)。
- 不改 DOTA 的触发条件(仍是显式触发),不改 Phase 顺序或质量闸门。
- 不改普通(非 DOTA)对话的行为。

## 适用范围

仅作用于**飞书群里显式触发 DOTA** 的 run。触发词沿用群 `CLAUDE.md` 已有的那组:`/dota`、「走 DOTA」、「DOTA 一下」、「上 superpowers」(及 `/dota-bugfix` 同理)。

## 设计

### 组件 1:干净启动(compact-on-DOTA-start)—— 治乙

**行为**:host/runner 在派发一条 run 之前,先用正则判断该条入站消息是否命中 DOTA 触发词。命中且**当前会话上下文超过阈值**时,在真正的 DOTA prompt 之前先 `push('/compact')`,把当天历史压成摘要,再进入 Phase 1。

```
收到消息
  └─ host 正则:是 DOTA 触发词?
       ├─ 否 → 照常派 run
       └─ 是 → 当前上下文 > 阈值?
              ├─ 否 → 直接进 Phase 1(本来就轻,不白压)
              └─ 是 → 先 push('/compact') → 再进 Phase 1
```

- **力度**:compact(软压),非 hard reset。保留用户最新需求 + 一份历史摘要,不丢背景(DOTA Phase 1 需求收敛依赖刚聊的背景)。
- **自动**:不打断、不二次询问。安全前提正是"选了软压";若改硬重置则必须先问,本 spec 不采用硬重置。
- **阈值门**:复用 idle-compact 的阈值(`NANOCLAW_IDLE_COMPACT_THRESHOLD`,默认 ~auto-compact 窗口的 75%,即 ~45k)。上下文本来就小则跳过 compact,避免无谓的 30–60s 与 token 开销。
- **复用机制**:沿用 idle-compact 已有的 `stream.push('/compact')` 通路(`container/agent-runner/src/index.ts`),不新造 compact 机制。
- **触发词识别放在哪**:DOTA 触发词是固定字符串,host/runner 用正则即可识别,**无需 LLM 判断**。识别函数单一职责、可独立单测。

**接口边界**:
- 输入:入站消息文本(判触发词)+ 阈值配置 + 当前会话上下文 token 估算。
- 输出:布尔"是否在本 run 前注入一次 /compact"。
- 依赖:现有 compact 推送通路(`stream.push('/compact')`)、现有上下文 token 估算(`extractContextTokens`)。

**待 plan 决定的开放点 —— 阈值门的数据从哪来**:
host 在派 run **之前**拿不到"当前会话上下文大小"——`extractContextTokens` 是 run 内逐条消息才算得出的。三个候选,plan 阶段择一:
1. **持久化上一轮 contextTokens**:#1 已把单轮 `contextTokens` 经 usage 传回 host;持久化到 sessions 表(类比 session_id),DOTA 触发时读它做阈值门。简单,但用的是"上一轮"的值,略滞后。
2. **agent-runner 内判定**:把"是否 DOTA 触发"和阈值门下沉到 agent-runner,resume 后第一轮拿到 contextTokens 再决定是否 `push('/compact')`。最准,但逻辑进容器侧。
3. **无条件压**:DOTA 触发即注入一次 /compact,不设阈值门。上下文本来小时 /compact 近乎 no-op(便宜),实现最简,代价是偶发的无谓一次压缩。
推荐顺位:1 →(够简单且数据已具备);若 plan 评估持久化成本不值,退 3。

### 组件 2:阶段里程碑消息 —— 治甲

**行为**:在群 `CLAUDE.md` 的 DOTA 治理段新增一条行为铁律:**每跨一个 Phase 边界,先发一条单行里程碑** `send_message`。

- 文案形如:`✓ Phase 2 plan 完成 → ▶ Phase 3 审查(critic)`。
- 实时工具细节仍走原有流式卡片;里程碑是群时间线上的 durable 消息,用于"看得到推进、判断是否冻住"。
- **纯治理,零代码**:阿飞本就具备 `send_message`。
- 落点:DOTA 全局生效需要时写 `global` + `feishu_main` 双份(见 [[reference_nanoclaw_global_claudemd_inheritance]]);本 spec 先落 DOTA 治理段所在的群级 `CLAUDE.md`,具体落点在 plan 阶段确定。

### 组件 3:append_blocks 429 退避 —— 治乙(独立小修)

**行为**:`container/feishu-blocks-mcp/src/index.ts` 的 `append_blocks`(及同类写块调用)加**单块/小批 + 命中 429 指数退避重试**,从源头减少限流触发与干等。

- 退避:命中 429(及飞书等价限流码)后指数退避重试,设最大重试次数与上限等待,超限则返回结构化错误(不静默吞)。
- 与组件 1 正交:compact 治"上下文拖累",退避治"写文档限流",两件独立的事。

## 错误处理

- 组件 1:若 `/compact` 注入失败或 compact 本身报错,**降级为照常跑**(不阻断 DOTA),并 log 警告。compact 是优化不是前置条件。
- 组件 3:退避达最大次数仍 429 → 向 agent 返回明确的"限流,已重试 N 次仍失败"结构化错误,让 agent 决定改小批/稍后再试,**不静默吞错**。

## 测试策略

- 组件 1:单测 DOTA 触发词正则(命中/不命中边界:`/dota`、走 DOTA、DOTA 一下、上 superpowers、普通文本)、阈值门(超阈值→注入,低于→跳过)、compact 失败降级路径。
- 组件 3:单测 429 退避(首次 429→重试成功;持续 429→达上限返回结构化错误;非 429 错误不重试)。
- 组件 2:治理项,手动验收 —— 下次 DOTA run 观察是否每 Phase 边界回贴里程碑。
- #1 token-footer:已有单测覆盖(ctx% 用单轮 contextTokens)。

## 验收标准

1. 在飞书群发 DOTA 触发词且上下文超阈值 → run 开始前注入一次 /compact,Phase 1 在轻上下文上起跑;上下文低于阈值则不注入。
2. DOTA run 每跨一个 Phase 边界,群里出现一条里程碑消息。
3. `append_blocks` 命中 429 时按退避重试,不再"写一块干等一块",失败时返回明确错误。
4. 普通(非 DOTA)对话行为不变。
5. 全量测试通过,两个工程 `tsc` 干净。

## 给 B 留的口

A 仅做"显式 DOTA 在原地跑得快、不像冻住"。"独立会话异步跑 DOTA"是 **B-via-tmux**:复用现有 `scripts/tmux-bridge.mjs`(已具备 `/start-session` `/send` `/capture`),后续独立 spec。A 的任何改动不与 B 冲突。
