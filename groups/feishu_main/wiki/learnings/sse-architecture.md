# SSE 事件架构与广播规范

> Nine 系统四层 SSE 架构、事件广播检查清单、双写陷阱、seq 去重等规范

## 四层架构

1. **Agent层**（Python LangGraph 节点）→ emit 到 Redis Stream
2. **Redis Stream** → 持久化 + fanout
3. **Go API**（SSE endpoint）→ 从 Redis 读 + 推送给前端
4. **前端**（ChunkHandler / PhaseDataHandler）→ 按 event type 分发

每层都有独立的注册/配置要求，新增事件类型必须**四层同步**。

## 问题

- astream_events 和 _emit_sse 同时使用导致 Redis 双写，事件重复
- 新增事件类型忘记在前端注册，事件静默丢弃
- fanout 输入是 list 而不是单个 client，广播漏发
- resume 后 seq 不去重，前端收到重复事件
- POST /stream 接口忘记返回 lastSeq，前端无法续连
- 事件重放时没有发 replay_end，前端不知道重放结束

## 新增 SSE 事件类型检查清单

1. Python emit 侧：调用 _emit_sse(event_type, data)，不与 astream_events 混用
2. Redis 侧：确认 event_type 已在 stream key schema 中
3. Go API 侧：event_type 在路由/过滤白名单中
4. 前端侧：在 ChunkHandler 或 PhaseDataHandler 中注册 handler
5. POST /stream 必须在响应体中返回 lastSeq
6. 重放结束必须发 replay_end 事件

## 规范

- 双写防护：节点内用 astream_events 时，禁止同时调 _emit_sse
- fanout 格式：fanout 函数入参是单个 client 对象，不是 list
- seq 去重：resume 时 client 携带 lastSeq，服务端过滤 seq <= lastSeq 的事件
- nginx 配置：SSE 端点必须 proxy_buffering off，proxy_read_timeout 3600s

## 教训

- 每次新增 SSE 事件类型，必须过一遍四层检查清单
- astream_events 和 _emit_sse 不能混用，选一个
- POST /stream 响应体必须含 lastSeq，这是 resume 的基础
- replay_end 不是可选的，没有它前端会永远等待
- V2 前端 ChunkHandler 只接受 source === main_agent，内部 agent 的 chunk 会被丢弃

## Related
- [langgraph-interrupt](langgraph-interrupt.md)
- [frontend-nginx](frontend-nginx.md)
- [backend-buffer-sse-rules](backend-buffer-sse-rules.md)
