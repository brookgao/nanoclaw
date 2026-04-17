# Git Commit / Push / Deploy 规范与常见故障

> worktree commit 静默失败、build 产物污染、push 认证失败、部署验证等问题合集

## 问题

**静默失败（PR #734）**：push 被 GitLab 拒绝，但前端显示"已完成"，无飞书通知、无 MR、代码丢失。

**build 产物污染（PR #828）**：git add -A 把 .wt-owner/build/dist/out/ 等编译产物提交到 GitLab（几十 MB 二进制）。

**GIT_ASKPASS 认证失败（PR #825）**：remote URL 含 oauth2:@（空密码），Git 跳过 ASKPASS，push 认证失败。

**worktree commit 静默跳过**：编译失败时 worktree_commit 逻辑静默跳过，未报错，验收环节看到 0/0。

**phase_done 过早（PR #762）**：push 失败后 phase 仍被标为 done，milestone 状态错误。

**deploy 环境变量缺失（PR #730）**：start.sh 未注入 env var，容器启动失败但 CI 报 success。

## 根因

- push 失败返回 [PUSH_FAILED]，飞书/MR 创建都用 if remote_url 过滤 → 跳过；milestone_writer 硬编码 status="done" → 前端误报
- BUILD_ARTIFACTS 列表只含少数文件，遗漏 .wt-owner 等目录
- oauth2:@ 中的冒号让 Git 认为密码字段为空，跳过 credential helper
- 编译失败未抛出异常，worktree_commit 无法感知

## 修复

- **PR #734**：push 失败时 emit phase_data:commit_error → 前端 Toast + 飞书红卡；milestone 不硬编码 done
- **PR #828**：提取 cleanup_build_artifacts(ssh, wt_path) 共享函数，所有 git add -A 前统一调用
- **PR #825**：删除 remote URL 中的冒号，oauth2@host 而不是 oauth2:@host
- **PR #762**：push 失败时不推进 phase_done，挂起等人工处理

## 新增 git add -A 调用点检查清单

1. 在 git add -A 前调 cleanup_build_artifacts(ssh, wt_path)
2. 新增构建产物目录时同步加入 BUILD_DIRS 列表
3. push 失败必须有可见通知（飞书 + SSE Toast），不能静默
4. milestone status 不能在 push 完成前硬编码 done

## 教训

- git add -A 是危险操作，必须先清理构建产物
- push 失败是致命错误，必须有多渠道通知（飞书红卡 + 前端 Toast）
- GIT_ASKPASS URL 不能含多余冒号，oauth2:@ → oauth2@
- V2 前端错误通知必须走 phase_data 通道，不能用 chunk

## Related
- [sse-architecture](sse-architecture.md)
- [vm-verify](vm-verify.md)
- [dev-workflow](dev-workflow.md)
