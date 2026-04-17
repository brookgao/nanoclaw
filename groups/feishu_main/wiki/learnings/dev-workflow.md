# 开发工作流 / Worktree / Dev Server 规范

> dev server 访问、worktree 操作规范、branch 切换、本地环境优先原则

## 关键信息

| 机器 | 地址 | 用途 |
|------|------|------|
| Dev server | root@10.117.5.134 | 部署 nine 应用，前端/API 在这 |
| 159 编译机 | heasenbug@10.117.0.159 | worktree 编译，/tmp/wt-* 在这 |

- **当前项目**：/ai/nine（老项目 /ai/enterprise-ai-agent-platform 已废弃，不要操作）
- **159 的 shell**：zsh（不是 bash），for 循环分词行为不同

## 操作规范

**本地环境优先**：调试时先在本地复现，确认能复现后再去 dev server 操作。

**禁止手动操作 CI repo**：/ai/nine 是 CI runner 工作目录，不要手动 git 操作。

**branch 切换后必须**：
1. git status 确认干净
2. git fetch origin && git checkout <branch>
3. 检查 docker ps 中的容器是否需要重建
4. pkill -f webpack（kill 旧的 webpack watch 进程）

**容器 branch 验证**：部署后验证实际运行版本：git -C /app rev-parse HEAD

**159 zsh 兼容写法**：
- 错误：for f in $FILES; do protoc "$f"; done
- 正确：while read f; do protoc "$f"; done <<< "$FILES"

## worktree 操作

```bash
git worktree add /tmp/wt-feature-x feature/x
git worktree remove /tmp/wt-feature-x
git worktree prune
```

注意：worktree 共享主仓库的 .git/config，在 worktree 中修改 remote/config 会影响主仓库。

## 教训

- 10.117.0.159 和 10.117.5.134 是两台完全不同的机器
- dev server 上 /ai/enterprise-ai-agent-platform 是死项目，不要动
- 159 是 zsh shell，SSH 命令必须用 bash 兼容写法

## Related
- [git-deploy](git-deploy.md)
- [frontend-nginx](frontend-nginx.md)
