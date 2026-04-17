# NanoClaw IPC Event 系统

> Agent 容器到 Host 的实时事件通道架构

## 架构

容器内 agent-runner 通过原子写入文件到 `/workspace/ipc/events/` 目录，host 侧 `ipc.ts` 扫描该目录，解析事件后分发到 `channel.onAgentEvent()`。

**事件类型**：
• `start` — agent 开始运行
• `tool_use` — 工具调用开始（name + input）
• `tool_result` — 工具返回结果（resultPreview）
• `assistant_text` — 中间文本输出
• `final` — agent 运行完成

**AgentEvent 结构**：
```typescript
{
  type: 'agent_event', chatJid: string, runId: string, seq: number,
  timestamp: number, kind: 'start'|'tool_use'|'tool_result'|'assistant_text'|'final',
  payload: Record<string, any>
}
```

## 关键设计

• 原子写入（写临时文件 → rename）防止读到半成品
• seq 字段用于排序和去重
• Channel interface 新增可选 `onAgentEvent?()` 方法，不强制所有 channel 实现

## Related

- [nanoclaw-feishu-interactive-card](nanoclaw-feishu-interactive-card.md)
