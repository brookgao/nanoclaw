# NINE Known Issues

> 项目历史中反复出现的 bug 模式和已知问题，审查代码时逐项对照。

## 反复出现的 Bug 类型（从 PR 复盘提取）

### Bug 类 1：Agent 身份混乱（修了 4 次：#338, #446, #590, #613）

- 子任务冒充父任务发事件，异步事件乱序到达
- 根因：`sse_handler` + `chat.py` 同时负责太多事，agent 切换检测逻辑散乱

### Bug 类 2：消息持久化乱（修了 4 次：#574, #616, #619 + 用户消息去重）

- AI 流式输出存 DB 的 4 种触发方式（定时/攒够了/agent 切换/流水线暂停）对「更新旧消息 vs 新建消息」理解不一致
- 导致刷新后消息被拆分、重复、markdown 断裂

### Bug 类 3：暂停/继续状态不同步（修了 4 次：#579, #619 clarify, #596 直连 worker, interrupt_config 改造）

- LangGraph checkpoint / DB / 前端三个状态源各管各的，resume 没有原子操作
- 症状：重复点击确认跑两份、clarify 回答后界面不更新、直连 worker 后编码进度卡「准备中」

### Bug 类 4：阶段切换误删数据（循环 bug）

- `PHASE_CLEANUP` 矩阵手动维护，把重试计数器误清零
- 根因：35+ 字段平铺在大字典，无生命周期分组

## 代码模式级 Bug（来自 PR #280 复盘）

### P3: 命名空间混淆（高频）

系统存在三套并行标识：`node_name` / `agent_key` / `display_name`。大部分情况 `node_name === agent_key`，但存在例外（如 `chief_arbitration` vs `chief_arbitrator`）。

**症状**：过滤器/匹配逻辑失效，agent 找不到，事件无法路由。

**预防**：匹配 agent 时通过 `_NODE_TO_AGENT_KEY` 映射转换，参照 `docs/kb/naming-conventions.md`。

### P1: 删旧未接新

重构时删除旧渲染路径但新路径未接通，编译正常但运行时静默失败。

**预防**：遵循「先加后删」规则（PR-A 新路径上线保留 fallback，PR-B 删旧路径）。

### P2: 管线顺序错误

`renderModel` 各处理步骤存在顺序依赖，新增过滤函数放错阶段导致下游收到错误输入。

**顺序**：1 预过滤 → 1a OpenSpec → 1b 架构 JSON → 1c 大 JSON → 1d 截图 → 2 分离三层 → 3 提取 summary → 4 分组 steps → 5 提取 tailText

**INVARIANT**：架构 JSON 提取（1b）必须在大段 JSON 折叠（1c）之前。

### P7: 跨边界契约断裂

前端组件渲染异常或空白，根因是后端 payload 字段名/类型与前端 props 不匹配。

**检测**：对比后端 SSE payload 与前端组件 props 字段名和类型。

## 性能问题（已定位）

### concierge 首次回复慢（平均 51.5s）

- 根因：主力模型 `qwen3.5-plus`（via deepseek）比 `claude-sonnet-4-6` 慢 7-15 倍
- `_load_history(limit=20)` 导致 input 随对话增长膨胀（最大 9.2K tokens）
- concierge 偶发输出 2868 tokens 路由分析文字（对用户不可见的中间推理）

**修法**：把 concierge 模型切为 `claude-sonnet-4-6`，history limit 改为 5。

### phase_change 等待（平均 125s）

- interrupt → paused → 等待前端确认，每次阶段切换用户等 2 分钟以上
- 前端未给用户明确的 phase gate 操作提示

## 架构待改造方向（已规划，未完成）

| 顺序 | 内容 | 状态 |
|------|------|------|
| 第 1 步 | 统一 ConversationController（resume 原子操作） | 规划中 |
| 第 2 步 | 协作式中断（节点检查 control_signal） | 规划中 |
| 第 3 步 | 消息持久化独立（脱离 SSE handler） | 规划中 |
| 第 4 步 | State 分组（按生命周期归类字段） | 规划中 |

## Related

- [architecture](architecture.md)
- [ops-checklist](ops-checklist.md)
