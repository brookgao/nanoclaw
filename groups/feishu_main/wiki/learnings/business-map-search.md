# Business Map / 项目能力地图与搜索

> business_map 描述丢失导致架构师搜不到项目的根因分析与修复（PR #528）

## 问题

PR #528：架构师阶段无法找到相关项目，搜索结果为空或不相关。排查发现 6 个关联问题：

1. business_map 记录的 description 字段为空（数据导入脚本迁移时丢弃了该字段）
2. 向量索引只索引了 name，未包含 description
3. 搜索 query 过长，向量偏移
4. 向量 DB 与关系 DB 不同步（软删除的项目仍在向量 DB 中）
5. 架构师搜索时使用了错误的 namespace（全局 namespace 而非 org 级）
6. 返回结果未过滤 archived 项目

## 根因

business_map 数据导入脚本在某次迁移中丢弃了 description 字段，此后新建项目也未正确填充，导致向量索引无有效内容可索引。

## 修复（PR #528）

1. 重新导入 business_map 数据，补全 description 字段
2. 向量索引改为 title + description 拼接后编码
3. 搜索 query 限制 ≤ 100 tokens
4. 定期同步：关系 DB 软删除 → 向量 DB 同步删除
5. namespace 修复：使用 business_map_{org_id} 而非全局 namespace
6. 搜索结果过滤 archived=True 的项目

## 教训

- 向量索引内容必须包含足够的语义信息（description），只用 name 不够
- 关系 DB 和向量 DB 的软删除必须同步，否则搜索到幽灵记录
- namespace 必须是业务隔离的，不能用全局 namespace

## Related
- [embedding-retrieval](embedding-retrieval.md)
- [architect-agent-loop](architect-agent-loop.md)
