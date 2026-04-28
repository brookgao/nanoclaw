# NINE LLM Factory

> `backend/app/agents/llm_factory.py` — 统一 LLM 提供商切换层，支持 OpenAI / Anthropic / Google / MiniMax，按 agent_key 从 DB 读取配置。

## 功能

`llm_factory.py` 是后端 LLM 调用的统一入口。各 agent 节点不直接实例化 LangChain LLM 对象，而是通过工厂获取，工厂根据 DB 中虚拟员工（`EmployeeLLMConfig`）的配置决定返回哪个 provider 和 model。

## 支持的 Provider

| provider | SDK | 说明 |
|---------|-----|------|
| `openai` | langchain-openai | OpenAI GPT 系列 |
| `anthropic` | langchain-anthropic | Claude 系列 |
| `google` | langchain-google-genai | Gemini 系列 |
| `deepseek` | （via OpenAI 兼容 API） | DeepSeek / Qwen 等 |
| `cliproxy` | （代理层） | 用于国内访问，替代 google 等被墙 provider |
| `minimax` | — | MiniMax-M2.5 |

## 配置来源

LLM 配置存储在 `EmployeeLLMConfig` 表，按 `agent_key` + `config_key` 索引：
- `provider`：上表中的 provider 名称
- `model`：模型名称（如 `claude-sonnet-4-6`、`gpt-4.1-mini`）
- `temperature`：温度参数

Provider 级配置存储在 `llm_provider` 表：
- `base_url`：自定义 API endpoint
- `proxy_url`：provider 级代理 URL（2026-04-28 新增，空值 = 不使用代理）

## proxy_url 代理注入方式

不同 provider 的注入方式不同（见 PR #1388）：

| provider 类型 | 注入方式 |
|---|---|
| `anthropic` | 构建后替换私有属性 `llm._client._client` / `llm._async_client._async_client`（ChatAnthropic 不支持构造参数注入） |
| OpenAI compatible | 构造时传 `http_client=httpx.Client(proxy=...)` / `http_async_client` |

**注意**：Anthropic 注入依赖内部私有属性，升级 `langchain-anthropic` 前需回归验证。

## LLM JSON 解析规范（2026-04-28）

**铁规**：禁止对 LLM 输出直接调用 `json.loads()`。统一使用：

```python
from app.agents.utils.llm_json import loads as llm_json_loads
result = llm_json_loads(text, context="节点名称")
```

`llm_json.loads()` 自动处理：markdown 代码块包裹、尾部逗号、Python dict 语法。失败返回 `None` 并记录 warning 日志。

## 重要注意事项

**`provider=google` 在中国大陆无法访问**。如果 DB 中存在 `provider='google'` 的配置，API 调用会超时或报错。

检测方法（在容器内执行）：
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

发现后改为 `provider=cliproxy`，`model=claude-sonnet-4-6`。**无需重启容器**，工厂每次调用都从 DB 读取最新配置。

## 性能基准（concierge 节点实测）

| 模型 | provider | 平均首次 token 延迟 | 备注 |
|------|---------|----------------|------|
| claude-sonnet-4-6 | anthropic/cliproxy | 3-6s | 推荐，快 7-15 倍 |
| qwen3.5-plus | deepseek | 40-95s | 当前 concierge 主力，慢 |
| MiniMax-M2.5 | minimax | 未知 | 早期使用 |

concierge 节点应切换为 `claude-sonnet-4-6`，同时将 `_load_history(limit=20)` 改为 `limit=5` 以减少 input token 膨胀。

## Related

- [architecture](../architecture.md)
- [known-issues](../known-issues.md)
- [learnings/llm-provider-proxy](../../learnings/nine/llm-provider-proxy.md)
- [learnings/encryption-key-separation](../../learnings/nine/encryption-key-separation.md)
