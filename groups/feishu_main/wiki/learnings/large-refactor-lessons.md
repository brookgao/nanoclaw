# 大型重构 PR 经验教训（PR #897）

> 大型重构 PR 的风险控制：原子性、回滚方案、分阶段合并策略

## 问题

PR #897 是一个大型重构，涉及 50+ 文件变更，合并后出现多个未预期的回归。

## 教训

1. **大 PR 难 review**：reviewer 无法有效理解 50+ 文件的关联变更，重要 bug 在 review 中被遗漏
2. **回滚成本高**：大 PR 合并后回滚会丢失其他有价值的改动
3. **功能与重构混合**：PR 同时包含重构和新功能，无法独立回滚重构部分

## 正确做法

- 拆分为多个小 PR，每个 PR ≤ 20 文件变更，可独立 review 和回滚
- 重构 PR 只做重构，不包含功能变更
- 分阶段合并：先合并基础重构，观察 1-2 天确认稳定后再合并上层变更
- 大型变更使用 feature flag，可快速禁用而不需要回滚

## Related
- [review-approval-process](review-approval-process.md)
- [e2e-testing](e2e-testing.md)
