# Wiki Index

Andy's knowledge base. Read this on startup for a global view.

## Operations

- [managing-groups](operations/managing-groups.md) — 群组管理：查找/注册/删除/trigger/allowlist/containerConfig
- [task-scripts](operations/task-scripts.md) — 定时任务 script 阶段：wakeAgent JSON 契约、何时不用 script
- [sub-agents](operations/sub-agents.md) — 何时派 Task/TeamCreate 子 agent 避免中间输出污染主 context
- [autonomy-framework](operations/autonomy-framework.md) — 自治决策边界表 + post-task 经验提炼 + git 风格学习 + 已授权例行动作（start-session / seed 同步）
- [ai-troubleshooting-5steps](operations/ai-troubleshooting-5steps.md) — 线上排查 5 步法：trace_id → Jaeger → Loki → GlitchTip → 报告（含可执行 SSH 命令）

## NINE Project

- [architecture](nine/architecture.md) — 技术栈、服务拓扑、多 Agent 工作流、开发服务器信息
- [api-endpoints](nine/api-endpoints.md) — 所有 FastAPI 接口、SSE 事件类型、interrupt 协议
- [known-issues](nine/known-issues.md) — 反复出现的 bug 模式、性能问题、架构待改造方向
- [ops-checklist](nine/ops-checklist.md) — 运维前置检查：LLM 配置、健康检查、部署脚本
- [modules/llm-factory](nine/modules/llm-factory.md) — llm_factory.py 提供商切换、性能基准、google provider 禁区
- [modules/skill-api](nine/modules/skill-api.md) — 统一 Skill 列表/文件内容 API（Python + Go + 前端 SkillDetail 详情页 + 用户授权 Admin Panel）
- [learnings/skill-binding-admin-ui](learnings/nine/skill-binding-admin-ui.md) — 用户 skill 授权管理面板：category 字段、卡片 UI、权限保留逻辑
- [learnings/llm-provider-proxy](learnings/nine/llm-provider-proxy.md) — provider 级 proxy_url 字段 + llm_json.loads() 统一 JSON 解析入口
- [learnings/vm-verify-auto-login](learnings/nine/vm-verify-auto-login.md) — browser-vnc JWT 自动登录注入，免飞书扫码，SSO 等待预算大幅压缩
- [learnings/encryption-key-separation](learnings/nine/encryption-key-separation.md) — API Key 加密密钥与 JWT 验签密钥分离，修复"密钥解密失败"根因

## Decisions

- [ADR-001](decisions/adr-001-card-session-lazy-creation.md) — 飞书卡片 lazy creation：零工具走纯文本，有工具才建卡片
- [ADR-002](decisions/adr-002-ipc-file-events.md) — 文件 IPC 替代 WebSocket/Redis：原子写入 + 目录扫描
- [ADR-003](decisions/adr-003-dual-max-account.md) — 双 Max 账号隔离：用户和阿飞分开避免 529
- [ADR-004](decisions/adr-004-no-proxy-feishu.md) — NO_PROXY 绕过 OneCLI 代理劫持飞书 API

## Learnings — NINE

### LangGraph / Interrupt / SSE
- [langgraph-interrupt](learnings/nine/langgraph-interrupt.md) — interrupt/resume 状态管理：零UUID泄漏、竞态、状态丢失
- [sse-architecture](learnings/nine/sse-architecture.md) — SSE 四层架构与广播规范：双写陷阱、seq去重
- [backend-buffer-sse-rules](learnings/nine/backend-buffer-sse-rules.md) — 禁止后端缓冲 flush、工具调用事件不走 SSE
- [langgraph-architecture](learnings/nine/langgraph-architecture.md) — LangGraph 与 Gateway 架构设计决策
- [session-agent-phase-guard](learnings/nine/session-agent-phase-guard.md) — SA phase guard bypass、step limit、信号处理

### 架构师 Agent / LLM 行为
- [architect-agent-loop](learnings/nine/architect-agent-loop.md) — 架构师死循环与搜索螺旋：Token溢出
- [llm-tool-calling](learnings/nine/llm-tool-calling.md) — 工具调用与 Prompt 冲突：弱模型 str 强制转换
- [prompt-api-schema](learnings/nine/prompt-api-schema.md) — Prompt 无 API schema 导致幻觉
- [embedding-retrieval](learnings/nine/embedding-retrieval.md) — v3/v4 embedding 混用、query 噪声

### 验收 / VM / Sandbox
- [vm-verify](learnings/nine/vm-verify.md) — VM 验收 0/0、infra_error、健康检查死循环
- [sso-sandbox-browser](learnings/nine/sso-sandbox-browser.md) — SSO 认证等待、多VM browser隔离、VNC黑屏
- [e2e-testing](learnings/nine/e2e-testing.md) — E2E 测试基础设施 bug、SSE去重、Puppeteer 规范；V2 产研图全链路 E2E 框架（gate_bypass、onboarding_setup、MainAgent 追问漂移）

### Git / Deploy / 构建
- [git-deploy](learnings/nine/git-deploy.md) — commit静默失败、build产物污染、push认证失败
- [go-build-deploy](learnings/nine/go-build-deploy.md) — Go sandbox 启动五层洋葱、sumdb死锁
- [protobuf-protoc](learnings/nine/protobuf-protoc.md) — protoc版本兼容、include路径、zsh分词
- [dev-workflow](learnings/nine/dev-workflow.md) — worktree 操作规范、dev server 访问
- [frontend-nginx](learnings/nine/frontend-nginx.md) — Nginx 配置、端口映射、前端重建

### Milestone / Phase / 消息
- [milestone-phase](learnings/nine/milestone-phase.md) — Milestone 卡片数据缺失、phase时序错误
- [message-persistence](learnings/nine/message-persistence.md) — Ghost message、持久化缺口
- [chat-state-builder-round](learnings/nine/chat-state-builder-round.md) — 多轮回跳时 phase group key 必须含 round 维度，修 issue #1218

### 代码质量 / 架构模式
- [error-handling-shared-layer](learnings/nine/error-handling-shared-layer.md) — 错误在共享层捕获，不在各调用点分散
- [cross-layer-development](learnings/nine/cross-layer-development.md) — 多层变更必须同步
- [component-isolation](learnings/nine/component-isolation.md) — 组件隔离与模块所有权约定
- [concurrency-race-conditions](learnings/nine/concurrency-race-conditions.md) — resume竞态、rootfs并发覆写
- [data-pipeline](learnings/nine/data-pipeline.md) — 数据管道必须端到端完整
- [python-code-quality](learnings/nine/python-code-quality.md) — UnboundLocalError、all([])空列表陷阱

### LLM 配置 / 安全 / VM 验收
- [llm-provider-proxy](learnings/nine/llm-provider-proxy.md) — provider 级 proxy_url 字段 + llm_json.loads() 统一 JSON 解析入口
- [vm-verify-auto-login](learnings/nine/vm-verify-auto-login.md) — browser-vnc JWT 自动登录注入，免飞书扫码，SSO 等待预算大幅压缩
- [encryption-key-separation](learnings/nine/encryption-key-separation.md) — API Key 加密密钥与 JWT 验签密钥分离，修复"密钥解密失败"根因

### 其他
- [business-map-search](learnings/nine/business-map-search.md) — business_map 描述丢失（PR #528）
- [host-worker-architecture](learnings/nine/host-worker-architecture.md) — Host Worker 进度缺失、路径前缀截断
- [db-timezone-migration](learnings/nine/db-timezone-migration.md) — Go/Python 时区不一致
- [review-approval-process](learnings/nine/review-approval-process.md) — 未经审批不能 commit
- [eventbus-consumer-checklist](learnings/nine/eventbus-consumer-checklist.md) — 新增事件必须同时注册 producer 和 consumer
- [large-refactor-lessons](learnings/nine/large-refactor-lessons.md) — 大型重构 PR 风险控制（PR #897）
- [conflict-resolution](learnings/nine/conflict-resolution.md) — 合并冲突必须理解两侧意图
- [log-grep-tools](learnings/nine/log-grep-tools.md) — grep_code超时、session log路径

## Learnings — NanoClaw

- [feishu-interactive-card](learnings/nanoclaw/nanoclaw-feishu-interactive-card.md) — 飞书卡片流式更新：CardSession 状态机、lazy creation、collapsible panel
- [ipc-event-system](learnings/nanoclaw/nanoclaw-ipc-event-system.md) — Agent→Host IPC 事件通道：原子写入、seq 去重
- [container-env-injection](learnings/nanoclaw/nanoclaw-container-env-injection.md) — extraEnv 机制：host secrets 注入容器
- [onecli-proxy-bypass](learnings/nanoclaw/nanoclaw-onecli-proxy-bypass.md) — OneCLI 代理劫持飞书 API 的 NO_PROXY 绕过
- [stale-container](learnings/nanoclaw/nanoclaw-stale-container.md) — 改完代码必须 kill 旧容器
- [dual-account-isolation](learnings/nanoclaw/nanoclaw-dual-account-isolation.md) — 双 Max 账号隔离避免 529
- [session-management](learnings/nanoclaw/nanoclaw-session-management.md) — Context rot 与五条岔路决策框架
- [feishu-image-vision](learnings/nanoclaw/nanoclaw-feishu-image-vision.md) — 飞书图片多模态链路：8 层穿透 + BuildKit 缓存坑 + DB schema

## Learnings — General

- [debugging-methodology](learnings/general/debugging-methodology.md) — 系统性调试六原则：停止猜测、追踪证据、定位根因
- [systemic-defects](learnings/general/systemic-defects.md) — 三类反复出现的缺陷：静默失败、状态不一致、资源未清理

## People
- [admin](people/admin.md) — project owner and primary user
