# Wiki Log

Append-only record of wiki operations.

[2026-04-15] init: wiki structure created
[2026-04-15] seed: wiki/nine/architecture.md — initial import from NINE soul.md + docs/architecture-for-testing.md
[2026-04-15] seed: wiki/nine/api-endpoints.md — initial import from docs/architecture-for-testing.md §2
[2026-04-15] seed: wiki/nine/known-issues.md — initial import from docs/kb/known-pitfalls.md + daily-memories
[2026-04-15] seed: wiki/nine/modules/llm-factory.md — initial import from soul.md tech stack + daily-memories perf data
[2026-04-15] seed: wiki/nine/ops-checklist.md — initial import from soul.md ops checklist + daily-memories server info
[2026-04-15] setup: registered wiki-git-scan (daily 9AM) and wiki-lint (Monday 10AM) scheduled tasks
[2026-04-16] import: wiki/learnings/architect-agent-loop.md — 架构师 agent 死循环与搜索螺旋（PR #439/#451/#646/#683）
[2026-04-16] import: wiki/learnings/langgraph-interrupt.md — LangGraph interrupt/resume 状态管理：零UUID泄漏、竞态、状态丢失
[2026-04-16] import: wiki/learnings/sse-architecture.md — SSE 四层架构与广播规范、双写陷阱、seq去重检查清单
[2026-04-16] import: wiki/learnings/protobuf-protoc.md — protoc 版本兼容、include路径、zsh分词、pb.go污染
[2026-04-16] import: wiki/learnings/git-deploy.md — commit静默失败、build产物污染、push认证失败合集
[2026-04-16] import: wiki/learnings/vm-verify.md — VM 验收 0/0、infra_error、健康检查死循环合集
[2026-04-16] import: wiki/learnings/milestone-phase.md — Milestone 卡片数据缺失、phase时序错误合集
[2026-04-16] import: wiki/learnings/go-build-deploy.md — Go sandbox 启动五层洋葱、sumdb死锁、cross-repo replace
[2026-04-16] import: wiki/learnings/llm-tool-calling.md — LLM 工具调用与 Prompt 冲突、弱模型 str 强制转换
[2026-04-16] import: wiki/learnings/sso-sandbox-browser.md — SSO 认证等待、多VM browser隔离、VNC黑屏
[2026-04-16] import: wiki/learnings/debugging-methodology.md — 系统性调试六原则：停止猜测、追踪证据、定位根因
[2026-04-16] import: wiki/learnings/db-timezone-migration.md — Go/Python 时区不一致、DB migration 未同步
[2026-04-16] import: wiki/learnings/e2e-testing.md — E2E 测试基础设施 bug、SSE去重、Puppeteer dev 规范
[2026-04-16] import: wiki/learnings/embedding-retrieval.md — v3/v4 embedding 混用、query噪声、模型版本必须匹配
[2026-04-16] import: wiki/learnings/host-worker-architecture.md — Host Worker 进度缺失、路径前缀截断、domain worker对等性
[2026-04-16] import: wiki/learnings/session-agent-phase-guard.md — SA phase guard bypass、step limit、信号处理
[2026-04-16] import: wiki/learnings/message-persistence.md — Ghost message、持久化缺口、AI消息丢失
[2026-04-16] import: wiki/learnings/dev-workflow.md — worktree操作规范、dev server访问、branch切换规范
[2026-04-16] import: wiki/learnings/frontend-nginx.md — Nginx配置、端口映射、WebSocket代理、前端重建必要性
[2026-04-16] import: wiki/learnings/business-map-search.md — business_map 描述丢失导致架构师搜不到项目（PR #528）
[2026-04-16] import: wiki/learnings/prompt-api-schema.md — prompt无API schema导致LLM幻觉、structured output陷阱
[2026-04-16] import: wiki/learnings/review-approval-process.md — 未经审批不能commit、dota pipeline不能跳phase
[2026-04-16] import: wiki/learnings/error-handling-shared-layer.md — 错误在共享层捕获，不在各调用点分散处理
[2026-04-16] import: wiki/learnings/cross-layer-development.md — 多层变更（DB/API/前端）必须同步，不能只改一层
[2026-04-16] import: wiki/learnings/eventbus-consumer-checklist.md — 新增事件类型必须同时注册producer和consumer
[2026-04-16] import: wiki/learnings/large-refactor-lessons.md — 大型重构PR风险控制：拆分、原子性、回滚方案（PR #897）
[2026-04-16] import: wiki/learnings/systemic-defects.md — 三类反复出现的缺陷：静默失败、状态不一致、资源未清理
[2026-04-16] import: wiki/learnings/langgraph-architecture.md — LangGraph与Gateway架构设计决策
[2026-04-16] import: wiki/learnings/concurrency-race-conditions.md — 并发竞态：resume竞态、rootfs并发覆写
[2026-04-16] import: wiki/learnings/python-code-quality.md — 条件导入UnboundLocalError、all([])陷阱、async in sync
[2026-04-16] import: wiki/learnings/log-grep-tools.md — grep_code超时处理、session log查找路径、ERE flag规范
[2026-04-16] import: wiki/learnings/backend-buffer-sse-rules.md — 禁止后端缓冲flush、工具调用不走SSE规范
[2026-04-16] import: wiki/learnings/data-pipeline.md — 数据管道必须端到端完整，每阶段输入输出明确
[2026-04-16] import: wiki/learnings/conflict-resolution.md — 合并冲突解决规范：理解两侧意图再合并
[2026-04-16] import: wiki/learnings/component-isolation.md — 组件隔离与模块所有权：禁止直接引用内部状态
[2026-04-17] create: wiki/operations/managing-groups.md — 从 CLAUDE.md 199-354 移出 156 行群组管理章节
[2026-04-17] create: wiki/operations/task-scripts.md — 从 CLAUDE.md 372-407 移出 36 行 task script 章节
[2026-04-17] slim: groups/feishu_main/CLAUDE.md — 407→157 行（-61%），移除 Slack/WhatsApp/Discord 格式规则、Managing Groups、Task Scripts 详细章节，改为 wiki 引用
[2026-04-17] create: wiki/operations/sub-agents.md — 子 agent 触发场景与铁律（Task A A2）
[2026-04-17] update: soul.md — 加主动 compact 触发器段 + 子 agent 铁律（Task A A1/A2）
