# 消息持久化与 Ghost Message

> 消息幻影（显示但未存 DB）、持久化缺口、AI 消息丢失等问题

## 问题

**Ghost message**：前端显示了一条消息，但 DB 中不存在，refresh 后消失。

**持久化缺口**：AI 消息在 SSE 推送后，写 DB 的操作因异常提前退出，消息丢失。

**interrupt 数据未持久化**：interrupt 产生的中间状态只存内存，服务重启后丢失。

## 根因

- 消息推送（SSE emit）和消息写 DB 是两个独立操作，两者没有事务保证
- 写 DB 在 finally 块之外，异常时跳过
- interrupt 数据设计时未考虑进程重启场景

## 修复

- 消息写 DB 移到 try-finally 块，保证 emit 后必定持久化
- SSE 推送改为"先写 DB，再推送"，保证数据先落地
- interrupt 状态改为写 Redis（TTL=24h），key=interrupt:{session_id}:{interrupt_id}

## 教训

- "推送"和"持久化"必须有明确的顺序约定，推荐"先落地再推送"
- 关键状态（interrupt、消息）必须有持久化保证，不能只存内存
- finally 块必须包含所有资源清理和状态写入操作

## Related
- [langgraph-interrupt](langgraph-interrupt.md)
- [sse-architecture](sse-architecture.md)
