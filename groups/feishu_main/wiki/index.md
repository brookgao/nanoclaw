# Wiki Index

Andy's knowledge base. Read this on startup for a global view.

## Operations

- [managing-groups](operations/managing-groups.md) — 群组管理：查找/注册/删除/trigger/allowlist/containerConfig
- [task-scripts](operations/task-scripts.md) — 定时任务 script 阶段：wakeAgent JSON 契约、何时不用 script

## NINE Project

- [architecture](nine/architecture.md) — 技术栈、服务拓扑、多 Agent 工作流、开发服务器信息
- [api-endpoints](nine/api-endpoints.md) — 所有 FastAPI 接口、SSE 事件类型、interrupt 协议
- [known-issues](nine/known-issues.md) — 反复出现的 bug 模式、性能问题、架构待改造方向
- [ops-checklist](nine/ops-checklist.md) — 运维前置检查：LLM 配置、健康检查、部署脚本
- [modules/llm-factory](nine/modules/llm-factory.md) — llm_factory.py 提供商切换、性能基准、google provider 禁区

## Decisions
_(architecture decision records)_

## Learnings

### LangGraph / Interrupt / SSE
- [langgraph-interrupt](learnings/langgraph-interrupt.md) — LangGraph interrupt/resume 状态管理：零UUID泄漏、竞态、状态丢失
- [sse-architecture](learnings/sse-architecture.md) — SSE 四层架构与广播规范：双写陷阱、seq去重、检查清单
- [backend-buffer-sse-rules](learnings/backend-buffer-sse-rules.md) — 禁止后端缓冲 flush、工具调用事件不走 SSE
- [langgraph-architecture](learnings/langgraph-architecture.md) — LangGraph 与 Gateway 架构设计决策
- [session-agent-phase-guard](learnings/session-agent-phase-guard.md) — SA phase guard bypass、step limit、信号处理

### 架构师 Agent / LLM 行为
- [architect-agent-loop](learnings/architect-agent-loop.md) — 架构师死循环与搜索螺旋：prompt+工具无消费者导致Token溢出
- [llm-tool-calling](learnings/llm-tool-calling.md) — LLM 工具调用与 Prompt 冲突：弱模型 str 强制转换
- [prompt-api-schema](learnings/prompt-api-schema.md) — Prompt 无 API schema 导致幻觉、structured output 陷阱
- [embedding-retrieval](learnings/embedding-retrieval.md) — v3/v4 embedding 混用、query 噪声问题

### 验收 / VM / Sandbox
- [vm-verify](learnings/vm-verify.md) — VM 验收 0/0、infra_error、健康检查死循环等问题合集
- [sso-sandbox-browser](learnings/sso-sandbox-browser.md) — SSO 认证等待、多VM browser隔离、VNC黑屏
- [e2e-testing](learnings/e2e-testing.md) — E2E 测试基础设施 bug、SSE去重、Puppeteer 规范

### Git / Deploy / 构建
- [git-deploy](learnings/git-deploy.md) — commit静默失败、build产物污染、push认证失败
- [go-build-deploy](learnings/go-build-deploy.md) — Go sandbox 启动五层洋葱、sumdb死锁、cross-repo replace
- [protobuf-protoc](learnings/protobuf-protoc.md) — protoc版本兼容、include路径、zsh分词、pb.go污染
- [dev-workflow](learnings/dev-workflow.md) — worktree 操作规范、dev server 访问、branch 切换
- [frontend-nginx](learnings/frontend-nginx.md) — Nginx 配置、端口映射、前端重建必要性

### Milestone / Phase / 消息
- [milestone-phase](learnings/milestone-phase.md) — Milestone 卡片数据缺失、phase时序错误、工具归因错误
- [message-persistence](learnings/message-persistence.md) — Ghost message、持久化缺口、AI消息丢失

### 系统性模式 / 方法论
- [debugging-methodology](learnings/debugging-methodology.md) — 系统性调试六原则：停止猜测、追踪证据、定位根因
- [systemic-defects](learnings/systemic-defects.md) — 三类反复出现的缺陷：静默失败、状态不一致、资源未清理
- [error-handling-shared-layer](learnings/error-handling-shared-layer.md) — 错误在共享层捕获，不在各调用点分散处理
- [cross-layer-development](learnings/cross-layer-development.md) — 多层变更（DB/API/前端）必须同步
- [component-isolation](learnings/component-isolation.md) — 组件隔离与模块所有权约定
- [concurrency-race-conditions](learnings/concurrency-race-conditions.md) — 并发竞态：resume竞态、rootfs并发覆写
- [data-pipeline](learnings/data-pipeline.md) — 数据管道必须端到端完整，不能有断点
- [python-code-quality](learnings/python-code-quality.md) — 条件导入UnboundLocalError、all([])空列表陷阱等

### 架构 / 搜索 / 其他
- [business-map-search](learnings/business-map-search.md) — business_map 描述丢失导致架构师搜不到项目（PR #528）
- [host-worker-architecture](learnings/host-worker-architecture.md) — Host Worker 进度缺失、路径前缀截断
- [db-timezone-migration](learnings/db-timezone-migration.md) — Go/Python 时区不一致、migration 未同步
- [review-approval-process](learnings/review-approval-process.md) — 未经审批不能 commit、dota pipeline 不能跳 phase
- [eventbus-consumer-checklist](learnings/eventbus-consumer-checklist.md) — 新增事件类型必须同时注册 producer 和 consumer
- [large-refactor-lessons](learnings/large-refactor-lessons.md) — 大型重构 PR 风险控制（PR #897）
- [conflict-resolution](learnings/conflict-resolution.md) — 合并冲突必须理解两侧意图，不能机械选择
- [log-grep-tools](learnings/log-grep-tools.md) — grep_code超时处理、session log查找路径、ERE flag

### NanoClaw 运维 / 架构
- [nanoclaw-feishu-interactive-card](learnings/nanoclaw-feishu-interactive-card.md) — 飞书卡片流式更新：CardSession 状态机、lazy creation、collapsible panel
- [nanoclaw-ipc-event-system](learnings/nanoclaw-ipc-event-system.md) — Agent→Host IPC 事件通道：原子写入、seq 去重
- [nanoclaw-container-env-injection](learnings/nanoclaw-container-env-injection.md) — extraEnv 机制：host secrets 注入容器
- [nanoclaw-onecli-proxy-bypass](learnings/nanoclaw-onecli-proxy-bypass.md) — OneCLI 代理劫持飞书 API 的 NO_PROXY 绕过
- [nanoclaw-stale-container](learnings/nanoclaw-stale-container.md) — 改完代码必须 kill 旧容器
- [nanoclaw-dual-account-isolation](learnings/nanoclaw-dual-account-isolation.md) — 双 Max 账号隔离避免 529
- [nanoclaw-session-management](learnings/nanoclaw-session-management.md) — Context rot 与五条岔路决策框架

## People
- [admin](people/admin.md) — project owner and primary user

## External
_(manually ingested external knowledge)_
