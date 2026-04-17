# 数据库时区与 Migration 规范

> Go 与 Python 时区处理不一致、DB migration 未同步、content vs content_json 双写

## 问题

**时区不一致**：Go 存储时间为 UTC，Python 读取时未转换，前端显示时间错 8 小时。

**DB migration 未同步**：新增字段后忘记写 migration，或 migration 文件写了但未在 dev 服务器执行。

**content vs content_json 双写**：Message 表有 content（text）和 content_json（JSON object）两个字段，读写时混用导致数据不一致。

## 根因

- Go 的 time.Time 默认 UTC，Python 的 datetime 默认 naive（无时区），混合存储时没有统一规范
- migration 执行是手动步骤，容易遗漏
- content_json 字段需要 json.dumps 序列化，直接存 dict 会存成 Python repr 字符串

## 修复

- **时区统一**：所有时间存储 UTC，Python 读取加 pytz.utc，显示层统一转北京时间（+8）
- **migration**：新增字段必须同步写 migration + 在 dev 执行 + PR 描述中注明
- **content_json**：写入前 json.dumps()，读取后 json.loads()；在 model 层加 @property 自动处理

## 教训

- Go 和 Python 混合项目必须在架构层统一时区规范，不能各自处理
- DB migration 是 PR checklist 的必检项，reviewer 需确认 migration 文件存在且被执行
- JSON 字段的 DB 列必须在 ORM/model 层做自动序列化，禁止业务代码直接操作

## Related
- [cross-layer-development](cross-layer-development.md)
