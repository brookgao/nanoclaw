# NINE API Endpoints

> 后端 FastAPI 所有对外接口清单，含认证约定和 SSE 事件协议。

认证约定：需要认证的接口在 `Authorization` Header 携带 `Bearer <JWT>`。
- 📌 = 需要认证，🔓 = 公开，🔐 = 需要管理员角色

## 认证接口（`/api/v1/auth`）

| 方法 | 路径 | 认证 | 功能 |
|------|------|------|------|
| POST | `/api/v1/auth/register` | 🔓 | 用户名/邮箱/密码注册 |
| POST | `/api/v1/auth/login` | 🔓 | 登录，返回 JWT access_token + refresh_token |
| POST | `/api/v1/auth/refresh` | 🔓 | refresh_token 换新 access_token |
| GET  | `/api/v1/auth/me` | 📌 | 获取当前用户信息 |
| PUT  | `/api/v1/auth/me/figma-token` | 📌 | 更新 Figma PAT |
| GET  | `/api/v1/auth/feishu/login_url` | 🔓 | 获取飞书 OAuth URL |
| POST | `/api/v1/auth/feishu/login` | 🔓 | 飞书授权码换 JWT |
| POST | `/api/v1/auth/feishu/grant_doc_access` | 📌 | 授权 App Bot 访问飞书文档 |

## 聊天接口（`/api/v1`）

| 方法 | 路径 | 认证 | 功能 |
|------|------|------|------|
| POST | `/api/v1/chat` | 🔓 | 非流式聊天（同步返回） |
| POST | `/api/v1/chat/stream` | 🔓 | **SSE 流式聊天**，多 Agent 主入口 |
| POST | `/api/v1/chat/resume` | 🔓 | **恢复被 interrupt 的工作流** |
| GET  | `/api/v1/health` | 🔓 | 健康检查 → `{"status": "ok"}` |

### SSE 事件类型

| 事件类型 | payload 字段 | 说明 |
|---------|-------------|------|
| `start` | `conversation_id` | 流开始 |
| `chunk` | `content`, `agent` | AI 内容片段 |
| `agent_switch` | `agent`, `label`, `avatar`, `display_name`, `employee_id` | Agent 切换 |
| `phase_change` | `phase`, `label` | 阶段变化 |
| `tool_call` | `agent`, `tool`, `args` | 工具调用开始 |
| `tool_result` | `tool`, `result` | 工具调用结果 |
| `interrupt` | `interrupt_type`, `payload` | 需要人工输入 |
| `done` | `timestamp`, `persisted` | 流结束 |
| `error` | `message` | 错误 |
| `: ping` | — | SSE 心跳（每 15 秒） |

### interrupt_type 类型

| 类型 | 触发节点 | payload 结构 | 说明 |
|------|---------|-------------|------|
| `phase_gate` | `concierge` / `chief_architect` | `{current_phase, next_phase, summary}` | 阶段确认门 |
| `clarify` | `pm_agent` | `{question, mode, options, allow_text}` | PM 追问用户 |
| `review` | `collect_diffs` | `{diffs: [{domain, diff, stats}]}` | 代码审阅 |

### `/chat/resume` 请求体

| 字段 | 类型 | 说明 |
|------|------|------|
| `conversation_id` | string | 任务 ID |
| `action` | string | `approve` / `revise` / `clarify_response` / `discuss` |
| `feedback` | string | revise 时的反馈内容 |
| `payload` | dict | 其他场景载荷 |

## 任务接口（`/api/v1/tasks`）

| 方法 | 路径 | 认证 | 功能 |
|------|------|------|------|
| GET    | `/api/v1/tasks` | 📌 | 任务列表（按 updated_at 倒序） |
| POST   | `/api/v1/tasks` | 📌 | 创建任务 |
| GET    | `/api/v1/tasks/{task_id}` | 📌 | 任务详情（含 graph state） |
| PUT    | `/api/v1/tasks/{task_id}` | 📌 | 更新任务 |
| DELETE | `/api/v1/tasks/{task_id}` | 📌 | 软删除任务 |
| GET    | `/api/v1/tasks/{task_id}/messages` | 📌 | 消息历史 |
| POST   | `/api/v1/tasks/{task_id}/messages` | 📌 | 手动写入消息 |
| GET    | `/api/v1/tasks/{task_id}/documents` | 📌 | 产出文档列表 |
| GET    | `/api/v1/tasks/{task_id}/files` | 📌 | 文件列表 |
| POST   | `/api/v1/tasks/{task_id}/files` | 📌 | 上传文件 |

## 虚拟员工接口（`/api/v1/employees`）

| 方法 | 路径 | 认证 | 功能 |
|------|------|------|------|
| GET   | `/api/v1/employees` | 🔓 | 员工列表（支持过滤） |
| GET   | `/api/v1/employees/{agent_key}` | 🔓 | 按 agent_key 获取详情 |
| POST  | `/api/v1/employees` | 🔓 | 创建虚拟员工 |
| PATCH | `/api/v1/employees/{agent_key}` | 🔓 | 更新 LLM 配置 |

## 设置接口（`/api/v1/settings`）

| 方法 | 路径 | 认证 | 功能 |
|------|------|------|------|
| GET | `/api/v1/settings/configs` | 🔐 admin | 获取系统配置 |
| PUT | `/api/v1/settings/configs` | 🔐 admin | 批量更新系统配置 |

可配置 Key：`openai_api_key`、`gemini_api_key`、`anthropic_api_key`、`agent_workspace`、`http_proxy`

## 沙盒接口

| 方法/类型 | 路径 | 功能 |
|---------|------|------|
| GET | `/api/v1/sandbox/{sandbox_id}/exec-log` | 轮询 exec 输出日志（`?since=<seq>` 增量） |
| GET | `/api/v1/tasks/{task_id}/review-diffs` | 获取任务各域 diff（进程内缓存） |

## Related

- [architecture](architecture.md)
- [modules/llm-factory](modules/llm-factory.md)
