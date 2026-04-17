# OneCLI 代理劫持与 NO_PROXY 绕过

> OneCLI HTTP 代理会劫持容器内 axios 对飞书 API 的调用，导致 400 错误

## 问题

NanoClaw 使用 OneCLI 作为 HTTP 代理注入 API keys。但 OneCLI 代理会拦截所有 HTTP 请求，包括容器内 MCP server（如 feishu-blocks-mcp）对 `open.feishu.cn` 的 axios 调用。被代理转发的飞书 API 请求返回 400。

## 根因

OneCLI 设置了 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量，axios 默认遵循这些代理设置。飞书 API 不需要也不应该经过 OneCLI 代理。

## 解决方案

在 `.mcp.json` 的 feishu-blocks MCP server env 中加：
```json
"NO_PROXY": "open.feishu.cn,.feishu.cn,.larkoffice.com,.larksuite.com"
```

这让 axios 对飞书域名的请求绕过代理直连。

## 排查教训

400 错误容易误判为 token 无效或参数错误。如果 token 确认有效但仍报 400，优先检查代理设置。

## Related

- [nanoclaw-container-env-injection](nanoclaw-container-env-injection.md)
