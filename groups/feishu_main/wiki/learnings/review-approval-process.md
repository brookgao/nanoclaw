# 验收 / 审核流程规范

> 不经审批不能 commit、dota pipeline 不能跳 phase、merge 前能力检查清单

## 核心规则

**未经审批不能 commit**：
- agent 完成实现后，必须等人工 approve 或 verifier agent 通过，才能 commit
- diff_review 通过不等于可以 commit，还需要 verify_review 通过

**Dota pipeline 不能跳 phase**：
- pipeline 各阶段有顺序依赖，不能因为"这次简单"就跳过
- 跳过 phase 导致后续阶段缺少输入数据，静默失败
- 如果 phase 卡住，修复原因，不要 skip

## Merge 前能力检查清单

- 所有 verify_review 通过
- E2E 测试通过
- diff 无非预期改动
- migration 已执行（如有新字段）
- 前端重新构建（如有 API 变更）

## 常见问题

**Dota pipeline stall**：某个 phase 卡住不动，原因通常是 SSE 事件未到达或 phase_gate 未触发，不是 agent 卡死。排查 SSE 事件流而不是重启。

**diff review interrupt 后必须重新执行**：interrupt 后不能用旧 diff_review 结果。

## 教训

- pipeline 的每个 phase 都不可跳过，即使看起来简单
- commit 权限由审核状态决定，不由 agent 的主观判断决定
- phase 卡住时，看 SSE 事件流，不要直接重启

## Related
- [git-deploy](git-deploy.md)
- [session-agent-phase-guard](session-agent-phase-guard.md)
