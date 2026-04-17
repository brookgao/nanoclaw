# EventBus 消费者注册检查清单

> 新增事件类型时必须同时注册 producer 和所有 consumer，缺一不可

## 问题

新增了一个 SSE 事件类型，producer 已发送，但 consumer（前端 handler）忘记注册，事件静默丢弃。前端不报错，只是什么都不显示。

## 注册检查清单

新增任何事件类型（SSE、EventBus、Redis pubsub）时：

- Producer 侧：emit 代码已添加
- 消息格式已定义（类型定义/schema）
- Consumer 侧：handler 已注册（前端 / 后端 subscriber）
- 错误处理：consumer 异常不会静默
- 测试：端到端验证 producer → consumer 链路

## 教训

- 事件驱动系统中，producer 和 consumer 必须同步注册
- 每次新增事件类型，必须 grep 所有 consumer 注册点，确认覆盖
- 静默丢弃是事件系统最危险的行为，必须有 fallback 日志

## Related
- [sse-architecture](sse-architecture.md)
- [cross-layer-development](cross-layer-development.md)
