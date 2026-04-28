# NINE Architecture

> 企业级 AI 驱动产品研发自动化平台，采用多 Agent LangGraph 编排，前端 Vue 3 + 后端 FastAPI，通过 SSE 流式推送 AI 进度。

## 技术栈

| 层次 | 技术 |
|------|------|
| 前端框架 | Vue 3 + Vite + TypeScript + Pinia + Vue Router |
| 前端样式 | Tailwind CSS |
| 后端框架 | FastAPI (Python) + Uvicorn |
| 多 Agent 编排 | LangGraph (StateGraph) |
| ORM | SQLAlchemy 2.x |
| 数据库 | MySQL 8.0 |
| LangGraph Checkpoint | `AIOMySQLSaver`（生产）/ `MemorySaver`（降级） |
| 对象存储 | MinIO（S3 兼容） |
| 认证 | JWT（HS256）+ 飞书 OAuth |
| LLM SDK | langchain-openai / langchain-anthropic / langchain-google-genai |
| 可观测性 | Phoenix/OpenInference（可选，`PHOENIX_ENABLED=true`） |

## 服务拓扑

```
用户浏览器
    │  HTTP/WebSocket
    ▼
Nginx (port 80)        ← 反向代理，静态资源 + API 路由
    ├── /              → 前端 Vue3 SPA (container: frontend:5173)
    └── /api/*         → 后端 FastAPI (container: backend:8000)
                              │
              ┌───────────────┼──────────────────┐
              ▼               ▼                  ▼
         MySQL:3306      MinIO:9000          Sandbox-API
    (业务数据+LangGraph    (文件/图片对象     (Firecracker VM
      Checkpoint)          存储)              代码执行沙盒)
                                                  │
                                            Metal Server
                                        (Android ReDroid +
                                         Cuttlefish CVD)
```

## 容器清单

| 服务 | 镜像 | 端口 | 职责 |
|------|------|------|------|
| `nginx` | nginx:alpine | 80 | 反向代理 + 前端静态服务 |
| `backend` | 自建 Dockerfile | 8000 | FastAPI + LangGraph 多 Agent |
| `frontend` | 自建 Dockerfile | 5173 | Vue3 SPA |
| `mysql` | mysql:8.0 | 3306 | 业务数据库 + LangGraph Checkpoint |
| `minio` | minio/minio:latest | 9000/9001 | 对象存储（文件/图片） |

Docker 容器名称（运行时）：`enterprise-ai-backend`、`enterprise-ai-mysql`、`enterprise-ai-nginx`

## 项目结构

```
nine/
├── frontend/src/
│   ├── components/    # Vue 组件
│   ├── views/         # 页面视图
│   ├── stores/        # Pinia (auth, tasks, employees, activity)
│   ├── api/           # API 客户端
│   └── router/        # 路由
├── backend/app/
│   ├── main.py        # FastAPI 入口
│   ├── api/           # API 模块 (chat, tasks, auth, sandbox, android...)
│   ├── agents/
│   │   ├── graph.py       # LangGraph 主图
│   │   ├── state.py       # MultiAgentState
│   │   ├── llm_factory.py # LLM 工厂
│   │   ├── prompts.py     # 系统提示词
│   │   ├── nodes/         # agent 节点
│   │   └── tools/         # 工具模块
│   ├── core/          # 配置、数据库、安全
│   ├── models/        # ORM 模型
│   ├── schemas/       # Pydantic 模型
│   └── services/      # 业务逻辑
├── docker-compose.yml
└── CLAUDE.md          # Git 工作流规范
```

## 多 Agent 工作流（LangGraph）

入口 `_route_entry` 根据 `state.phase` 分流：

```
用户消息 → ConciergeHandler（图外）
    → intent_router → pm_agent → pm_clarify_gate?
    → project_agent → chief_architect
    → domain_review_worker（fan-out）→ review_router
    → sandbox_setup → domain_worker_execute（fan-out）
    → integration_test → collect_diffs → sandbox_commit → END
```

特殊路径：
- `is_qa=True` → `qa_responder` → END（最高优先级）
- `data_analysis` → `data_analyst`
- `agent_creation` → `agent_workshop`
- 评审分歧 → `chief_arbitration`

## 服务间通信

| 通信链路 | 协议 | 说明 |
|---------|------|------|
| 浏览器 → 后端 `/api/v1/chat/stream` | **SSE** | AI 流式输出 |
| 浏览器 → 后端 `/api/v1/sandbox/{id}/ws` | **WebSocket** | 沙盒终端双向代理 |
| 后端 → MySQL | TCP/SQLAlchemy | 业务 CRUD + LangGraph Checkpoint |
| 后端 → MinIO | HTTP/boto3 S3 兼容 | 文件上传/读取 |
| 后端 → Sandbox-API | HTTP | 创建/销毁/执行 Firecracker VM |
| 后端 → LLM API | HTTP | OpenAI / Anthropic / Google / MiniMax |
| 后端 → 飞书 API | HTTP (lark_oapi SDK) | OAuth 登录、文档读取 |

## 开发服务器

- **地址**：`ssh root@10.117.5.134`（admin 权限不足，用 root）
- **MySQL 密码**：`root_password_123`，库名 `enterprise_ai_agent`
- **部署目录**：`/ai/nine`
- **部署脚本**：`deploy/scripts/wt-deploy.sh`（worktree 独立容器验证）

## 安全密钥体系（2026-04-28）

两把密钥职责分离（PR #1390）：

| 用途 | 配置键 | 环境变量 |
|---|---|---|
| JWT 用户会话验签 | `security.jwt.key` | `JWT_SECRET_KEY` |
| LLM API Key 加密存储 | `security.encryption.key` | `ENCRYPTION_KEY` |

`ENCRYPTION_KEY` 一旦设定不可随意更换，否则已存 API Key 无法解密。

## VM 验收自动登录（2026-04-28）

browser-vnc VM 验收阶段（phase 3.6）自动注入 Nine JWT token，免除飞书扫码：
- 密钥来源：`JWT_SECRET` 环境变量 > Go API 配置文件 `security.jwt.key`
- 注入方式：`browser_evaluate` 写 `localStorage("access_token")` + 刷新页面
- 注入失败仅 warning，不阻塞验收

SSO 等待预算：工具调用上限 40→12，等待轮数 20→5。

详见 [learnings/vm-verify-auto-login](../learnings/nine/vm-verify-auto-login.md)。

## Related

- [api-endpoints](api-endpoints.md)
- [modules/llm-factory](modules/llm-factory.md)
- [known-issues](known-issues.md)
- [ops-checklist](ops-checklist.md)
- [learnings/vm-verify-auto-login](../learnings/nine/vm-verify-auto-login.md)
- [learnings/encryption-key-separation](../learnings/nine/encryption-key-separation.md)
