# Session Agent / Phase Guard 机制

> SA phase guard bypass、step limit、信号处理等 Session Agent 核心问题

## 问题

**phase guard bypass**：SA phase guard 在某些路径下被绕过，agent 在不应该继续的阶段继续执行。

**step limit**：SA 执行步数无上限，某些 task 触发无限递归直到 token 溢出。

**信号不清晰**：SA 中的信号（done/failed/pending）定义不明确，字符串字面量散落各处。

## 根因

- phase guard 是 prompt 级约束，agent 可以通过特定输出格式绕过
- step limit 未在 LangGraph 层实现，只有 prompt 级"最多 N 步"，LLM 可以忽略
- 信号枚举未集中定义，各处散落使用字符串字面量

## 修复

- **PR #252**：统一信号定义，集中在 signals.py 中，禁止字符串字面量
- phase guard：改为代码层检查（检查 current_phase 与允许的 phase 列表），不依赖 prompt
- step limit：在 LangGraph recursion_limit 配置中设置，框架层强制
- phase guard bypass：在节点 entry 处添加断言，不满足条件直接 raise

## 教训

- phase guard 这类关键约束必须在代码层实现，不能只依赖 prompt
- step limit 必须用 LangGraph 的 recursion_limit 参数，不能只写在 prompt 里
- 信号/枚举值必须集中定义，禁止散落的字符串字面量

## Related
- [langgraph-interrupt](langgraph-interrupt.md)
- [architect-agent-loop](architect-agent-loop.md)
- [milestone-phase](milestone-phase.md)
