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
- [2026-04-28] PM skill: mainagent 触发的技能（nine/skills/pm/），专职需求分析，输出 OpenSpec。是一个单步技能，不是流水线
- [2026-04-28] product_dev: 产研图流水线（nine/skills/product_dev/），编排三个角色：产品(PM) → 架构师 → 编码，端到端多 agent 协作
- [2026-04-28] dota: 用户的个人开发工作流（/dota 新功能 / /dota-bugfix 修 bug），8 阶段质量管线。是用户自己的流程，不是 agent 的技能
- [2026-04-28] PM skill ≠ product_dev 里的 PM 角色 ≠ 阿飞的 PM 职责。三者名字相近但完全不同，禁止混淆
