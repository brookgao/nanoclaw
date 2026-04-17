# 飞书 Interactive Card 流式更新

> NanoClaw 实现飞书卡片实时展示工具调用进度的完整方案

## 核心架构

**CardSession 状态机**：start → lazy card create on first tool_use → patch on tool events → final patch with green header → delete session

关键设计决策：
• **Lazy creation** — 不在 start 时发卡片，等到第一个 tool_use 才创建。零工具调用的回复走纯文本路径，避免空卡片
• **Collapsible panel** — 每个工具调用生成 `collapsible_panel`（schema 2.0），默认收起，展开显示参数 JSON + 结果预览
• **Heartbeat** — 每 15s 自动 patch 刷新运行时间，防止用户以为卡住
• **Debounce** — 500ms 防抖，避免快速连续 tool_use 导致频繁 patch

## 卡片 Schema

飞书 Interactive Card v2 使用 `schema 2.0`，结构：
• `header`：title + subtitle + template（blue=运行中，green=完成）
• `body.elements`：markdown + hr + collapsible_panel

API：`im.message.create`（创建）+ `im.message.patch`（更新）

## 防重复机制

问题：stdout 回调和 onAgentEvent final 都会调 sendMessage → 消息重复
解决：sendMessage 检查 card session active → suppress plain text；onAgentEvent final 有卡片则 patch，无卡片则 defer 给 stdout 路径

## 相关文件

• `src/channels/feishu.ts` — CardSession 实现
• `src/ipc.ts` — events 目录扫描
• `container/agent-runner/src/index.ts` — writeAgentEvent()

## Related

- [sse-architecture](sse-architecture.md)
- [nanoclaw-ipc-event-system](nanoclaw-ipc-event-system.md)
