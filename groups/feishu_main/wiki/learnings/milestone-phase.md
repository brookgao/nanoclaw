# Milestone / Phase 状态管理

> Milestone 卡片数据缺失、phase 时序错误、工具归因错误等一系列状态管理问题

## 问题

**milestone 三个 bug（PR #391）**：milestone 卡片数据缺失、时序错乱、工具归因错误，同一 PR 修复三个关联 bug。

**temp_milestone vs milestone**：temp 记录未正确晋升为 milestone，或 milestone 数据被 temp 覆盖。

**timeline 错位**：milestone 时间线展示顺序与实际执行顺序不一致，根因是 seq 字段排序与时间戳排序不一致。

**phase_gate 时序**：phase_gate 在 LangGraph 节点执行过程中被触发，而不是节点结束后，导致 phase 状态提前变更。

**start_seq bug**：milestone start 事件的 seq 与第一个 action 的 seq 重叠，前端渲染出现 off-by-one 错误。

**subtask 异常 done 状态**：subtask 在未完成时被标为 done，根因是 parent task done 时级联更新了所有子任务。

## 根因

- milestone 相关的 DB 写入分散在多个模块，无统一入口，各自维护状态导致不一致
- phase_gate 检查在 async node 内部调用，而 node 可能并发执行，导致 race condition
- temp_milestone 晋升逻辑有条件判断缺陷，某些路径跳过晋升

## 修复

- **PR #199**：修复 milestone 卡片缺失数据字段
- **PR #193**：修复 milestone 卡片 phase 归因
- **PR #391**：三合一修复，统一 milestone 写入入口
- phase_gate：改为在节点 callback（on_node_end）中触发，保证时序
- start_seq：milestone start 事件 seq 改为 first_action_seq - 1

## 教训

- milestone 状态写入必须有统一入口，禁止多处分散写
- phase_gate 等状态变更不能在 async node 执行过程中触发，要用 callback
- temp 与正式记录的晋升逻辑必须有显式断言，不能靠隐式条件
- 前端 milestone 渲染依赖 seq 严格单调递增，后端必须保证

## Related
- [langgraph-interrupt](langgraph-interrupt.md)
- [session-agent-phase-guard](session-agent-phase-guard.md)
