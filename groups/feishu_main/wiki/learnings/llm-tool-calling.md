# LLM 工具调用与 Prompt 冲突

> LLM 工具参数类型错误、prompt 与 tool_guard 冲突、弱模型 str 强制转换等问题

## 问题

**AttributeError**：LLM 将字段输出为 JSON 编码字符串，normalize_args 解析后得到 list[str]，下游对 str 调用 .get() 报 AttributeError。

**tool_coerce JSON str（PR #694）**：弱模型（如 qwen）倾向于将 JSON 对象输出为字符串，需在 normalize_args 中强制反序列化。

**prompt 与 tool_guard 冲突**：prompt 说"必须调用 X"，tool_guard 说"已超限请停止"，LLM 优先服从 prompt，无视 tool_guard。

**response_format 幻觉**：LLM 声称支持 structured output，但实际输出不符合 schema，且不报错。

**escape hatch**：prompt 中"如果 X 不存在可以跳过"给 LLM 提供了逃脱路径，导致关键步骤被跳过。

## 根因

- LLM 输出格式不稳定，尤其弱模型会把 dict 序列化为字符串再输出
- prompt 级指令优先级高于工具层约束，两者冲突时 LLM 选 prompt
- structured output 的 schema 验证依赖 LLM 自我约束，不可靠

## 修复

- **PR #694**：normalize_args 中对 str 类型字段尝试 json.loads，失败则保留原值
- tool_guard 熔断逻辑移到 prompt 中（"超过 N 次调用必须停止"）
- 移除 prompt 中所有 escape hatch 表达，改为强制性指令
- structured output 接收端加严格的 schema 验证 + fallback 解析

## 教训

- 弱模型输入到工具参数时，必须有 normalize 层处理 str→dict 反序列化
- tool_guard 的熔断必须写入 prompt（不是只在工具层），LLM 才会遵守
- prompt 中禁止 escape hatch 表达，每个必须步骤必须是强制性的
- structured output 不可信，必须在接收端做 schema 验证

## Related
- [architect-agent-loop](architect-agent-loop.md)
- [prompt-api-schema](prompt-api-schema.md)
