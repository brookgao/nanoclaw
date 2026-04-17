# 跨层开发规范

> 修改涉及多层（DB/Backend/Frontend）时，必须同步修改所有层，不能只改一层

## 问题

新增 DB 字段，但 API 层未暴露；API 新增字段，但前端未使用；导致功能在某层失效但其他层不知道。

## 数据变更完整链路

```
DB schema → ORM model → API endpoint → 前端 state → UI 展示
```

每一步都必须同步变更。

## PR 规范

新增字段的 PR 必须包含：
- DB migration
- ORM 变更
- API endpoint 变更
- 前端 state 变更
- PR 描述中列出影响的所有层

## 教训

- 任何数据变更必须追踪完整链路
- PR checklist 必须包含"各层是否同步"的检查
- 不要假设"另一层自然会跟上"，必须显式确认

## Related
- [db-timezone-migration](db-timezone-migration.md)
- [frontend-nginx](frontend-nginx.md)
