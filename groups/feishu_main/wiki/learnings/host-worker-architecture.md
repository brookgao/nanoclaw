# Host Worker / Domain Worker 架构

> Host Worker 进度缺失、路径前缀截断、domain worker 对等性问题

## 问题

**进度缺失**：Host Worker 执行时 worker_progress 事件未发出，前端进度条不动。

**路径前缀截断**：Host Worker 在处理文件路径时，错误地剥离了路径前缀，导致文件找不到（sandbox 专用逻辑被错误应用到 Host Worker）。

**domain worker 对等性**：Host Worker 支持的功能集与 Domain Worker 不对等，某些任务在 Domain Worker 上可以但在 Host Worker 上失败。

## 根因

- worker_progress 事件发送逻辑在 Domain Worker 中有，但在 Host Worker 重构时漏掉
- 路径前缀剥离是针对 sandbox 环境的适配，Host Worker 不在 sandbox 中，不需要剥离
- Host Worker 和 Domain Worker 是两个独立代码路径，功能同步依赖手动维护

## 修复

- 在 Host Worker 的主循环中补充 worker_progress 事件发送
- 路径处理：Host Worker 中的 strip_prefix 逻辑改为条件执行（仅 sandbox 模式）
- 建立 Host/Domain Worker 功能对等检查清单，新增功能时两侧同步
- Host Worker prompt 移除所有 sandbox 特定描述

## 教训

- 两个并行代码路径（Host Worker vs Domain Worker）的功能必须明确同步机制
- sandbox 特定的路径处理不能无条件应用到 Host Worker
- Worker progress 事件是前端体验的关键，不能在重构中遗漏

## Related
- [vm-verify](vm-verify.md)
- [sse-architecture](sse-architecture.md)
