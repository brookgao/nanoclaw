# SSO 认证 / Sandbox 浏览器 / VNC 问题

> sandbox SSO 登录等待、多VM browser隔离、VNC 黑屏、nginx host 路由等问题

## 问题

**SSO 等待（PR #584）**：sandbox 中 SSO 登录后，LLM agent 未等待 SSO 完成就继续操作，导致后续请求 401。

**多 VM SSO hostname 隔离**：多个 VM 并发时，SSO cookie 绑定 hostname，不同 VM 的 hostname 相同导致 cookie 互相污染。

**namespace 隔离**：多 sandbox 环境中 SSO session namespace 未隔离，session_id 冲突。

**nginx sandbox_api_host**：nginx 反向代理配置中 sandbox_api upstream host 硬编码，多 sandbox 环境无法动态路由。

**VNC 黑屏（PR #519）**：VNC 连接后黑屏，根因是 restore timeout 过短，VM snapshot 恢复未完成就进行 VNC 连接。

**单 browser 约束**：sandbox 环境要求同一 VM 只能有一个 browser 实例，多实例导致 CDP 端口 9224 冲突。

## 根因

- SSO 是异步流程，agent 需要主动轮询登录状态而不是固定等待
- Cookie 隔离需要 VM 级别的 hostname 差异化
- VNC restore timeout 未考虑 snapshot 大小对恢复时间的影响

## 修复

- **PR #584**：SSO 等待改为轮询 /sso/status 接口，成功后才继续
- 多 VM hostname：每个 VM 分配唯一 hostname vm-{id}.local
- nginx 动态路由：sandbox_api_host 从请求 header X-Sandbox-Id 动态选择 upstream
- **PR #519**：VNC restore timeout 从 10s 增加到 60s，加重试逻辑
- 单 browser 约束：启动前检查 CDP 端口 9224 是否已占用，已占用则复用

## 教训

- SSO 登录是异步的，不能用 sleep 等待，必须轮询状态接口
- 多 VM 环境中，所有基于 hostname/cookie 的标识都需要 VM 级隔离
- VNC/snapshot 操作的超时必须考虑最坏情况（大 snapshot），不能用固定短超时
- CDP 端口 9224 是 sandbox browser 的标准端口，多实例时需要端口管理

## Related
- [vm-verify](vm-verify.md)
- [frontend-nginx](frontend-nginx.md)
