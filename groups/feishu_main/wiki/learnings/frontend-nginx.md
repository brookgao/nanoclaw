# 前端 / Nginx 配置与部署规范

> Nginx 作为前端入口、WebSocket 代理配置、端口映射、前端重建必要性等

## 关键架构

- nginx 是前端唯一入口，所有前端请求都经过 nginx，不能绕过
- v1 前端端口：3000（内部），nginx 代理到 80
- v2 前端端口：3001（内部），nginx 代理到 80/v2
- Go API 端口：8080（内部），nginx 代理到 /api

## 常见问题

**端口不匹配**：fallback_config 中配置的端口与实际服务端口不一致，请求路由失败。

**webpack watch 孤儿进程**：branch 切换后旧的 webpack watch 进程未终止，新 build 与旧进程冲突，端口被占用。

**WebSocket 代理缺失**：nginx 配置中 WebSocket upgrade 头未设置，SSE/WS 连接被 nginx 截断。

**部署后未重建前端**：Go API 或 Python backend 更新后，前端 bundle 未重新构建，前端调用了旧的 API schema。

## Nginx SSE 必要配置

SSE 端点必须在 nginx 中关闭缓冲并设置长超时：
- proxy_buffering off
- proxy_read_timeout 3600s
- proxy_http_version 1.1
- 设置 Upgrade 和 Connection 头

## 教训

- 任何 Go API / backend 变更后，必须重新构建前端（npm run build）
- 切换 branch 后必须 kill 旧的 webpack watch 进程（pkill -f webpack）
- nginx config 修改后必须 nginx -t && nginx -s reload
- SSE 端点的 nginx 配置必须关闭 buffering

## Related
- [sse-architecture](sse-architecture.md)
- [dev-workflow](dev-workflow.md)
