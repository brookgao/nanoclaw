# LangGraph 与 Gateway 架构设计

> Nine 系统 LangGraph 架构设计决策：节点职责、state 管理、gateway 通信协议

## LangGraph 架构原则

- 每个 LangGraph 节点负责单一职责，不跨越业务边界
- 通过 LangGraph 内置 reducer 管理 state，不手动合并
- interrupt 是 LangGraph 原生机制，不自行实现
- gateway 与 agent 通过 SSE 单向推送，不用 RPC

## Gateway 职责

- 负责：路由、认证、agent 调度、SSE 转发
- 不负责：业务逻辑、状态存储（交给 Redis/DB）
- agent 调度：根据 session 类型选择对应的 LangGraph graph

## LangGraph 节点规范

- 节点接受 state 返回 state，不持有外部状态
- 副作用（emit SSE、写 DB）在节点内完成
- 使用 Command 对象控制路由，不用硬编码 edge
- LangGraph state 不是数据库，不要存大量数据（超过 100KB 用 Redis 存引用）

## 教训

- 节点之间不能直接调用，只能通过 state 传递数据
- interrupt 后的 state 必须完整持久化，否则 resume 时数据丢失
- 同一 session 的并发请求需要分布式锁保护

## Related
- [langgraph-interrupt](langgraph-interrupt.md)
- [session-agent-phase-guard](session-agent-phase-guard.md)
- [sse-architecture](sse-architecture.md)
