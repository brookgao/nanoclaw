# 架构师 Agent 死循环与搜索螺旋

> 架构师 prompt 给工具但无实际输入/消费者，或指令触发无限搜索，导致 Token 溢出

## 问题

**场景一（PR #683）**：架构师 prompt 强制调用 openspec 四步工具，但 state["openspec"] 不含 change_name slug，agent 猜错后反复重试至 Token 溢出（1.09M > qwen 上限 991K）。

**场景二（PR #646）**：architect prompt 要求 openspec 四步调用，但 platform_presets 中工具策略未配置，preset 是唯一数据源，prompt 与工具实际可用状态不一致。

**场景三（PR #439）**：ARCHITECT_EXTRA_INSTRUCTIONS 加了"可行性验证"段落，每个文件路径都做工具验证，在 Go monorepo 中 grep 高频失败，触发搜索螺旋（44次LLM调用/1.84M tokens）。

**场景四（PR #451）**：arch_prompt 列举搜索工具+"信息不足时可用"，LLM 进入 75 次 codebase_search_code 螺旋，工具层熔断被 prompt 级指令覆盖。

## 根因

1. 给 LLM 工具+强制调用指令，但不提供工具所需参数 = 必然死循环
2. prompt 要求调用工具，但 preset 中未配置该工具 = 调用空气
3. prompt 写了开放式"先验证文件"指令，无次数上限，LLM 无法停止
4. prompt 级指令优先级高于工具层 tool_call_guard 熔断警告，LLM 会忽略警告继续执行

## 修复

- **PR #683**：禁用 prompt segment sort_order=40（is_active=False），architect preset 移除 openspec 相关工具，openspec_read 加防御层
- **PR #646**：同步 seed platform_presets，使 prompt 要求的工具实际存在
- **PR #439**：删除 ARCHITECT_EXTRA_INSTRUCTIONS 中"可行性验证"段落，追加"文件路径验证由系统自动完成"
- **PR #451**：修改 arch_prompt 措辞，限制工具调用次数上限

## 教训

- 给 agent 添加工具前必须验证：(1) 工具参数从哪来？(2) 工具产物谁消费？两个问题任一答不上来就不该加
- prompt 要求"必须调用 X 工具"时，必须确认 X 在 preset 中 + 参数在 state 中 + 产物有消费者
- 新增 prompt 指令不能写开放式"用工具确认 X"，必须有明确次数约束或由确定性代码替代
- 禁用 prompt 和移除工具必须同步操作，不能只改一半
- 历史坑：PR #673 只改 preset 没改 prompt → PR #646 又加回工具 → PR #683 才彻底解决

## Related
- [langgraph-interrupt](langgraph-interrupt.md)
- [llm-tool-calling](llm-tool-calling.md)
