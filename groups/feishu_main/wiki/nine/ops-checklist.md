# NINE Ops Checklist

> Pre-verification environment checks for NINE project.

## LLM Config Check

Check DB for `provider=google` (will fail in China):

```bash
docker exec enterprise-ai-backend python3 -c "
from app.core.database import SessionLocal
from app.models.employee_llm_config import EmployeeLLMConfig
db = SessionLocal()
bad = db.query(EmployeeLLMConfig).filter_by(provider='google').all()
for c in bad: print(f'  {c.agent_key}/{c.config_key}: google/{c.model}')
db.close()
"
```

If found, change to `cliproxy/claude-sonnet-4-6`. No restart needed.

## Backend Health

```bash
curl http://10.117.5.134/api/v1/health
```

Expected: `{"status":"ok"}`

## Frontend Dev Server

Port 5173 should have a listener:

```bash
curl -s -o /dev/null -w "%{http_code}" http://10.117.5.134:5173
```

Expected: `200`

## Deploy with Worktree Script

验证改动时，用独立容器而非直接 `docker compose up`：

```bash
MAIN_REPO=$(git worktree list | head -1 | awk '{print $1}')
$MAIN_REPO/deploy/scripts/wt-deploy.sh up $(git rev-parse --show-toplevel)
```

脚本自动分配独立端口，验证完成后清理：

```bash
$MAIN_REPO/deploy/scripts/wt-deploy.sh down $(git rev-parse --show-toplevel)
```

## MySQL 连接

```bash
ssh root@10.117.5.134
mysql -u root -proot_password_123 enterprise_ai_agent
```

## Container Names

| 容器 | 用途 |
|------|------|
| `enterprise-ai-backend` | FastAPI 后端 |
| `enterprise-ai-mysql` | MySQL 8.0 |
| `enterprise-ai-nginx` | Nginx 反向代理 + 前端静态 |

## Related

- [architecture](architecture.md)
- [modules/llm-factory](modules/llm-factory.md)
