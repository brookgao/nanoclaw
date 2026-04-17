# Sub-Agent (Task / TeamCreate) Usage

> 何时派子 agent 而非自己干：避免中间输出污染主 context。

## 铁律

**需要过程但不需要中间输出** → 派子 agent。
**中间输出要参与当前思路** → 自己干。

## 典型场景（派子 agent）

- 读 3+ 文件才能得出结论的调查（例：「分析所有 SSE handler 的广播规范」）
- 跨目录搜索验证假设（例：「找所有 bus.broadcast 的消费者」）
- 基于代码库写报告/文档（例：「给 agents/nodes/ 按规范补 docstring」）
- 验证规范一致性（例：「检查 nine/ 实现与 spec 的差异点」）

## 典型场景（自己干）

- 已在 context 里的文件做小改
- 对话延续、同一任务推进
- 只读 1-2 个文件的小任务

## 调用方式

- `Task` — 单次子 agent，独立 context，返回最终结论
- `TeamCreate` — 多 agent 协作（各自独立 context），适合需要并行的调查

## 与主动 Compact 的关系

- 子 agent 开销：启动新 context 不便宜，但中间噪音被隔离
- 主动 compact：主 context 已污染时的补救
- 优先级：能预判为噪音任务 → 子 agent（更干净）；已经累积 → 主动 compact

## Related

- [managing-groups](managing-groups.md) — 群组管理
- [session-management](../learnings/nanoclaw/nanoclaw-session-management.md) — 五条岔路决策框架
