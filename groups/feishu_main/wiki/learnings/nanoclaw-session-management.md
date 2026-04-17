# NanoClaw Session 管理策略

> 基于 Thariq Shihipar 的 context 管理理论，应用于 NanoClaw agent session

## 五条岔路（每步操作后的决策）

1. **Continue** — context 健康，继续当前 session
2. **Rewind** — 去掉失败尝试，保持 context 干净（不只是撤销，是主动清理噪音）
3. **Clear** — context 腐烂严重，从零开始（NanoClaw 场景：清 DB sessions 表 + 归档 .jsonl）
4. **Compact** — context 健康时主动压缩，比自动 compaction 质量好得多
5. **Sub-agent** — 隔离中间噪音，只带结论回主 context

## Context Rot 在 NanoClaw 的表现

阿飞的容器里 Claude SDK 有 session resumption。每次 @阿飞 续同一个 session，context 越来越腐烂：
• 注意力分散 → 把旧结论当新事实复述
• 重复调查已排除的方向
• 格式/指令遵从度下降

## 应用规则

• 阿飞的长任务（如代码审查、多步调试）完成后应 clear session，不要续
• 状态查询类（如"目前进度"）可以续 session
• 大量工具调用的中间结果是 context rot 主要来源 → 用 sub-agent 隔离
• 手动 compact 优于等自动 compaction（自动的压缩质量差）

## Related

- [debugging-methodology](debugging-methodology.md)
