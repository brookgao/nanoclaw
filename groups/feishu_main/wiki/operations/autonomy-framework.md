# 自治决策框架

> 基于历史踩坑数据的决策树：什么时候自己干、什么时候问用户

> 写入: 2026-04-17 · 来源: git log + wiki learnings + feedback memories 分析

## 决策树

收到任务后，按此顺序过滤：

```
第一关：这个改动可逆吗？
  不可逆（push 到多人仓库 / 删数据 / 部署 / 改安全代码）
    → 🛑 必须等用户明确指令
  可逆（本地文件改动 / 本地 commit / 可 revert 的操作）
    → 进入第二关

第二关：这个改动属于哪个高危模式？
  ┌─ 跨层变更（后端+前端 / Python+Go / DB+API+前端）
  │    → 🛑 方案确认。历史 8+ 次跨层不同步导致静默失败。
  │    证据：wiki/nine/cross-layer-development, db-timezone-migration,
  │          eventbus-consumer-checklist, sse-architecture
  │
  ├─ 状态/持久化（interrupt / session / checkpoint / Redis / DB 写入）
  │    → 🛑 方案确认。历史 5+ 次状态丢失/竞态/zombie。
  │    证据：wiki/nine/langgraph-interrupt, concurrency-race-conditions,
  │          message-persistence
  │
  ├─ 删除/替换旧代码路径
  │    → ⚠️ 先加后删。新路径验证通了，再删旧路径。
  │    禁止一个 PR 里同时删旧+加新（git revert 救不回来）。
  │    证据：wiki/nine/known-issues P1 "删旧未接新"
  │
  ├─ 环境/容器相关（mount / env / proxy / MCP 配置）
  │    → ⚠️ 改完必须 kill 旧容器验证。按三板斧排查。
  │    证据：memory/nanoclaw_container_debugging（三板斧）
  │
  ├─ 公共接口（导出函数签名 / API schema / LangGraph state 字段 / 事件类型）
  │    → ⚠️ 带方案问。改了签名必须搜所有调用方确认兼容。
  │    新增事件类型必须四层同步（Python emit / Redis / Go API / 前端 handler）。
  │    证据：wiki/nine/sse-architecture, eventbus-consumer-checklist
  │
  ├─ 引入新依赖 / 新工具
  │    → ⚠️ 带方案问。容器环境受限，很多东西装不了或装了没用。
  │    证据：本 session 阿飞在容器里装 pydantic 的教训
  │
  └─ 不属于以上任何高危模式
       → 进入第三关

第三关：我对方案有多确信？
  wiki/mem0 有完全匹配的先例 + 我理解根因
    → ✅ 自己干
  有类似案例但不完全匹配
    → ⚠️ 带方案问（说清楚哪里不一样）
  全新领域，没有先例
    → ⚠️ 带方案问

第四关：预计耗时多久？
  <10 分钟 → 做完再汇报结果
  10-30 分钟 → 发一条心跳（"我在搞 X，预计 N 分钟"），做完汇报
  >30 分钟 → 先说方案等用户确认，再动手
```

## "带方案问"的格式（必须遵守）

不是随便说"我想改一下"。必须包含：

```
**要做的事**：一句话（改什么文件，为什么）
**方案**：具体改动点（file:line，改什么）
**依据**：wiki/mem0/git log 里的先例（贴关键词，让用户能验证）
**风险**：最坏情况是什么？能 revert 吗？
**备选**：还有什么路？为什么没选？
→ A 按方案来 / B 走备选 / C 先别动
```

用户只需要回 A/B/C，不需要细读方案。这才叫"秒批"。

## 代码质量守卫（来自 code review 纠错历史）

写代码时自动检查，不需要等 review：

| 模式 | 正确做法 | 来源 |
|------|---------|------|
| 数值 config fallback | `??` 不是 `||`（保留合法的 `0`/`false`） | memory/feedback_nullish_for_numeric_config |
| 多处 inline 同一 config 解析 | 抽 helper，单点测试覆盖 | memory/feedback_shared_helper_pattern |
| base prompt 改动 | 三问：每次都要？本群适用？能按需查？ | memory/feedback_claude_md_slim_for_context_rot |
| grep 超时 | 缩小范围重试，不要直接说"不存在" | wiki/nine/log-grep-tools |
| 条件导入 | Python `try/except import` 中变量作用域 | wiki/nine/python-code-quality |

## 群特化规则

### nanoclaw（feishu_main）
- commit + push：测试过了可以自己推（单人仓库）
- CLAUDE.md 改动：瘦身方向可以自己做，加内容要问

### nine（feishu_langgraph-fix）
- commit + push：**必须问**（多人协作仓库）
- state 字段改动：**🛑 必须问**（影响所有 agent 节点）
- 不改 langgraph 范围外的代码

### 私聊（feishu_dm）
- 继承通用规则，无额外限制

## Post-Task 经验提炼（每次有实质产出后强制执行）

**提炼什么**：
- 根因是什么？为什么之前没发现？
- 踩了什么坑？属于上面哪个高危模式？（如果是新模式 → 更新本文档）
- 做了什么决策？为什么选 A 不选 B？
- 用户纠正了什么？

**双写**：
1. **Wiki** learnings 子目录 → 更新 index + FTS5
2. **mem0** → `mcp__mem0__add_memory`，2-5 个短关键词
3. **本群 memories.md** → `[YYYY-MM-DD] 结论 | 教训 | 下次`

**跳过**：纯问答、格式修复、已存过的同类教训。

**关键**：如果这次踩坑暴露了决策树没覆盖的新高危模式，**必须回来更新第二关的模式列表**。决策树是活的。

## Git 风格学习

动手写代码前：

```bash
git log --oneline -15  # commit message 风格
git log -3 --stat      # 改动粒度
git log -1 --format=%B # 完整 message 格式
```

模仿用户风格。当前用户（brookgao）使用 conventional commits + scope：
- `feat(feishu): implement FeishuChannel`
- `fix(container): use ?? over || for timeout fallback`
- feature branch → merge to main

## 已授权的例行动作（跳过决策树）

以下动作属于"看起来像高危但实为例行"，用户已授权自主执行，**不需要带方案问**。看到触发条件直接动手。

### tmux-bridge 会话自愈
- **条件**：`GET /health` 返回 `status: "no-session"`
- **动作**：`POST /start-session`（端点幂等，自带 `has-session` 检查）
- **为什么授权**：端点本来就是为自愈设计的，不起会话整个链路就断了。阻塞用户 = 把能自动的事变手动。
- **后续**：`sleep 15` 给 claude CLI 初始化，再继续原工作流

### Seed 源码改动的配对生效
- **条件**：当前任务刚改了 seed 源文件（如 `server/backend/app/models/seeds/**/*.yaml` 或 `app/models/seed_*.py`），且生效方式是**容器启动时 upsert**
- **动作**：通过 dev-claude 跑 `deploy/scripts/wt-deploy.sh up <worktree>` 重新部署（触发 `main.py` 里的 seed 函数）
- **⚠️ 副作用**：这个命令会**重启 backend 容器**。如果有人正在用同一个 dev 环境（调试、跑测试、看浏览器），会被打断。动手前先问用户"现在有人在用 dev 吗"，没人回或明确放行再跑。
- **为什么授权**：seed 同步是本次改动的完成步骤，不是独立决策。upsert 幂等，失败能重跑。
- **反例（仍要带方案问）**：
  - 改 migration 文件（涉及 schema 变更）
  - 改非 seed 数据（用户表、订单、配置表等 live 数据）
  - 直接 SQL `UPDATE` / `DELETE` live 行
  - 改 seed 之外的源码想通过 deploy 生效 → 走正常代码改动流程

### 如何新增条目
用户显式说"以后这种你自己搞" → 追加一条，写明：
- **条件**：什么情况触发
- **动作**：具体命令 / API
- **为什么授权**：讲清幂等性 / 可回滚性 / 为什么不是独立决策

## 信任升级机制

同一类操作连续 3 次用户都批准 + 没出问题：
→ 可从 ⚠️ 升级为 ✅
→ 在 mem0 记一条：`[升级] X 类操作可自主执行，基于 N 次成功先例 (YYYY-MM-DD)`
→ 用户显式说"以后这种你自己决定"也算升级

用户纠正了一次 → 立即降级回 ⚠️ 或 🛑，在 mem0 记原因。

## Related

- [session-management](../learnings/nanoclaw/nanoclaw-session-management.md) — context rot 缓解
- [stale-container](../learnings/nanoclaw/nanoclaw-stale-container.md) — 容器调试第一步
- [container-debugging](../learnings/nanoclaw/nanoclaw-container-env-injection.md) — env 注入机制
- [managing-groups](managing-groups.md) — 群组管理
