# 后端缓冲与 SSE 事件规范

> 禁止后端缓冲 flush、工具调用事件不走 SSE、node internal agent 不推 SSE

## 规则一：禁止后端手动 flush 缓冲

手动调用 response.flush() 会破坏 chunked encoding，导致 SSE 流异常中断。让框架管理缓冲，SSE 通过 Content-Type: text/event-stream 自动流式传输。

## 规则二：工具调用事件不走 SSE

工具调用（tool_use / tool_result）事件只在 LangGraph state 中传递，不推送到前端 SSE。

工具调用是 agent 内部实现细节，前端只需要知道工具调用的最终结果，不需要知道中间过程。

## 规则三：internal agent 不推 SSE

V2 前端的 ChunkHandler 只接受 source === main_agent 的 chunk。

内部 agent 节点（非 main_agent）产生的内容不能直接推 SSE chunk，否则被前端丢弃。内部 agent 的输出应通过 main_agent 汇总后推送。

## 规则四：astream_events 和 _emit_sse 不能混用

在同一个节点中，只能用 astream_events 或 _emit_sse，两者都会写 Redis，混用导致双写。

## 教训

- 后端 HTTP 响应不能手动 flush，会破坏 chunked encoding
- 工具调用不走 SSE，只在 state 中传递
- 内部 agent 的 chunk 不直接推 SSE，通过 main_agent 汇总
- astream_events 和 _emit_sse 选一个，不要混用

## Related
- [sse-architecture](sse-architecture.md)
