# Persistent Facts

Durable facts about the user, team, conventions, and environment. One bullet per fact, dated.

- [2026-04-14] User prefers Chinese responses
- [2026-04-14] NINE project uses FastAPI + Vue3 + TypeScript + Tailwind CSS + Pinia
- [2026-04-14] NINE backend: Python 3.11, LangGraph, LangChain, MySQL 8.0, MinIO
- [2026-04-14] NINE deployment: Docker Compose + Nginx
- [2026-04-14] Feishu bot is 阿飞-PM (appId: cli_a92b0aeeff219bd1)
- [2026-04-14] User's Feishu open_id: ou_a8a9b1f12f971fe59435c78384a367d1
- [2026-04-14] Dev workflow: all code ops go through tmux bridge → host Claude Code (dev-claude session)
- [2026-04-14] Git convention: feat/*, fix/*, refactor/* branches. Commit msg: feat(9号): 描述
- [2026-04-14] Team: main agent only (arch/dev/pm/test agents retired 2026-03-05/09)
- [2026-03-05] dev agent (大虾) and pm agent (阿飞) offlined; main absorbed all dev duties
- [2026-03-09] test agent (夏利-test) offlined; validation rules merged into main
- [2026-03-21] NINE concierge agent is 林小九; qwen3.5-plus caused 40-95s latency vs claude-sonnet 3-6s for same routing task
- [2026-03-21] NINE dev server: 10.117.5.134, MySQL db: enterprise_ai_agent, Docker containers: enterprise-ai-backend/mysql/nginx
- [2026-03-23] NINE architecture refactor plan: (1) ConversationController with atomic resume, (2) cooperative interrupts via control_signal, (3) independent message persistence off SSE handler, (4) state fields grouped by lifecycle
