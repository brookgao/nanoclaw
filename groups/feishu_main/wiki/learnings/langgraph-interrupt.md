# LangGraph Interrupt / Resume 状态管理

> LangGraph interrupt/resume 的各种竞态、状态丢失、零UUID泄漏等问题合集

## 问题

**状态丢失**：interrupt 后 resume 时，中间数据（choices、opt_id、phase 信息）未持久化，reconnect 后状态全丢。

**零 UUID 泄漏（PR #373）**：__resume__ 零 UUID 泄漏导致确认卡被跳过；opt_id 未翻译导致追问重复。

**竞态**：两个并发 resume 请求同时到达，LangGraph 线程安全问题导致不可预期状态。

**Zombie interrupt（TTL）**：interrupt 超时后未清理，残留 TTL zombie 阻塞后续会话。

**消失 on reconnect**：前端重连后 interrupt UI 消失，根因是事件未重放或重放不完整。

**send input 格式**：LangGraph send_input 要求 dict，传 str 会导致解析错误（框架不报错但逻辑错）。

## 根因

1. interrupt 数据只存内存，未写 DB/Redis，reconnect 即丢失
2. __resume__ 用零 UUID 标记，但下游未过滤，泄漏到正常流程
3. session_factory 在 interrupt 期间被回收，resume 时对象已无效
4. phase_change 事件在 resume 时被重复触发，前端显示两次
5. send_input(value) 中 value 必须是 dict 不能是 str，框架不抛异常但逻辑错

## 修复

- **PR #373**：修复 opt_id 翻译 + 零 UUID 过滤
- interrupt 数据持久化到 Redis，key=interrupt:{session_id}，TTL=24h
- session_factory 保持引用，interrupt 期间不回收
- resume 前检查 phase_change 是否已发送，避免重复
- send_input 统一封装，强制 dict 格式

## 教训

- interrupt 所有中间状态必须持久化（Redis/DB），不能只存内存
- resume 路径必须有幂等保护，相同 interrupt_id 只处理一次
- send_input 格式是 dict，不是 str；框架不抛异常但行为错误
- interrupt TTL 到期后必须主动清理，否则成 zombie
- 新增 interrupt 类型时，前端重放路径必须同步更新

## Related
- [sse-architecture](sse-architecture.md)
- [message-persistence](message-persistence.md)
