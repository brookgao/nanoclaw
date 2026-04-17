# NanoClaw 双账号隔离

> 用户 CLI 和阿飞的 tmux-bridge 必须用独立 Claude Max 账号，否则 529 限流

## 问题

tmux-bridge 让阿飞（容器内）通过 HTTP API 操控 host 上的 Claude Code CLI 跑 pytest 等命令。如果用户和阿飞共用同一个 Claude Max 账号，并发请求触发 529 (rate limit)。

## 解决方案

建立独立 tmux session `dev-claude-andy`，绑定第二个 Claude Max 账号（不同 OAuth token）。

**组件**：
• `scripts/start-dev-claude-andy.sh` — 幂等启动 tmux session
• LaunchDaemon plist — 开机自启
• `scripts/tmux-bridge.mjs` 端口 `:9876` — 专用于 andy 的 bridge
• `scripts/account-status.sh` — 一键查看所有账号状态（alias `nc-accounts`）

## CLAUDE.md 配置

在群 CLAUDE.md 中告诉阿飞：
• 容器不能跑 NINE 测试（没有 Python 环境）
• 通过 tmux-bridge `:9876` 端口操控 `dev-claude-andy` session
• Bridge 是异步的：send → 等 → capture

## Related

- [nanoclaw-container-env-injection](nanoclaw-container-env-injection.md)
