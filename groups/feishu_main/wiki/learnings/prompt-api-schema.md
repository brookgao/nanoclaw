# Prompt 设计与 API Schema 验证

> prompt 无 API schema 导致 LLM 幻觉 API、spec 与实现不一致、structured output 陷阱

## 问题

**无 API schema**：verify prompt 中未注入实际 API schema，LLM 凭记忆调用 API，endpoint 路径/参数全部幻觉。

**spec-impl gap**：spec 文档描述的行为与实际实现不一致，测试根据 spec 写但测的是幻觉行为。

**structured output 不可信**：LLM 声称支持 JSON mode，但实际输出有时会在 JSON 外面包一层 markdown code block，或字段名拼写有细微差异。

## 根因

- prompt 设计时假设 LLM 知道 API，但 LLM 只知道训练数据中的 API
- spec 文档不是唯一来源，代码实现可能已偏离 spec
- structured output 的 schema 验证依赖 LLM 自我约束，不可靠

## 修复

- verify prompt 中动态注入当前 API schema（从 OpenAPI spec 生成）
- 测试用例从实际 HTTP 请求/响应生成，不从 spec 文档生成
- structured output 接收端加严格的 schema 验证 + fallback 解析（去除 markdown wrapper）

## 教训

- 任何需要 LLM 调用 API 的 prompt，必须在 prompt 中注入完整的 API schema
- 测试用例必须从代码实际行为生成，不能从 spec 文档生成（spec 可能过时）
- structured output 永远需要接收端验证，不能信任 LLM 自我约束

## Related
- [llm-tool-calling](llm-tool-calling.md)
- [debugging-methodology](debugging-methodology.md)
