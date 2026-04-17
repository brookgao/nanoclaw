# E2E 测试 / Playwright / Puppeteer 规范

> Nine E2E 测试的基础设施 bug、SSE 去重、Puppeteer dev 环境注意事项

## 问题（PR #869）

1. SSE 连接在测试结束前断开，事件丢失
2. Go API 对重复 SSE 事件未去重，前端收到双份事件
3. browser preflight 检查逻辑有误，测试在 browser 未就绪时就开始

**v1 only**：Nine E2E 目前只支持 v1 前端，v2 前端的 E2E 覆盖尚未实现。

**Puppeteer dev 注意**：dev 服务器上 Puppeteer 必须用 --no-sandbox flag，否则 Chrome 启动失败。

## 修复（PR #869）

- SSE 连接改为在最后一个事件收到后 keepalive 3s 再断开
- Go API 加 seq 去重 map，同 session 内 seq 重复直接跳过
- browser preflight：轮询 /health 直到 200，最多等 30s

## E2E 标准流程

1. wt-deploy.sh up <worktree>
2. 等待 Go API + Frontend 健康（GET /health 返回 200）
3. 运行 Playwright/Puppeteer 测试
4. 检查 SSE 事件序列完整性（seq 连续、无重复）
5. wt-deploy.sh down <worktree>

## 教训

- E2E 测试必须等 browser preflight 通过再开始，不能用 sleep
- SSE 相关的 E2E 必须验证事件完整性（seq 连续、无重复）
- dev 环境 Puppeteer 必须加 --no-sandbox --disable-setuid-sandbox
- E2E 失败时，先看 SSE 事件流是否完整，再看业务逻辑

## Related
- [sse-architecture](sse-architecture.md)
- [vm-verify](vm-verify.md)
