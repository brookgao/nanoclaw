# Embedding 模型与知识检索

> v3/v4 embedding 混用、检索 query 噪声、模型版本必须匹配等问题

## 问题

**v3/v4 混用**：文档用 embedding v3 模型编码，检索时用 v4 模型查询，向量空间不同导致 cosine similarity 全部很低，检索结果无关。

**query 噪声**：检索 query 中含大量停用词和无关上下文，导致向量偏移，检索精度下降。

## 根因

- embedding 模型版本升级后，索引未重新生成，新旧向量混存在同一个向量数据库
- query 未做预处理，直接把用户原始输入作为 query

## 修复

- 统一使用 v4 embedding 模型，重新索引所有文档
- query 预处理：去停用词、提取关键实体、限制 query 长度 ≤ 200 tokens
- 添加模型版本元数据到向量 DB 记录，启动时校验一致性

## 教训

- embedding 模型升级必须触发全量重新索引，不能增量混用
- 向量 DB 记录必须存储 model_version 字段，防止版本混用
- 检索 query 必须预处理，不能直接用原始用户输入

## Related
- [llm-tool-calling](llm-tool-calling.md)
- [business-map-search](business-map-search.md)
