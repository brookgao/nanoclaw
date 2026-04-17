# 代码冲突解决规范

> 合并冲突解决时，必须理解两侧意图后再合并，不能机械选择一侧

## 问题

Merge conflict 解决时机械地"接受 ours"或"接受 theirs"，导致某一侧的重要变更被丢弃，bug 悄悄引入。

## 正确流程

1. 理解两侧的意图：查看两侧的 commit history，理解各自为什么做这个改动
2. 分析冲突类型：
   - 同一逻辑的不同实现 → 选更好的那个
   - 两个独立的功能改动 → 合并两者
   - 一侧 refactor + 另一侧 bugfix → 在 refactor 后的代码上重新应用 bugfix
3. 解决后测试：不能只是"看起来对"，必须运行测试验证

## 常见陷阱

- 接受 ours 丢失 bugfix：dev branch 上的 bugfix 被 main branch 的 ours 覆盖
- 接受 theirs 丢失功能：新功能被旧版本覆盖
- 两者都保留导致重复：同一逻辑被执行两次

## 教训

- 解决 merge conflict 前，必须理解两侧各自的意图和上下文
- 不能机械地接受 ours 或接受 theirs
- conflict 解决后必须运行测试，验证合并结果正确

## Related
- [git-deploy](git-deploy.md)
- [dev-workflow](dev-workflow.md)
