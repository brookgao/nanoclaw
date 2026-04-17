# NanoClaw Stale Container 陷阱

> 代码/配置改了但容器还在跑旧版本，是 NanoClaw 调试中最常见的误判源

## 现象

改了代码（如加了 NO_PROXY、extraEnv、新 MCP server）→ 测试 → 还是老行为 → 以为代码有 bug → 实际是旧容器还在跑。

## 根因

NanoClaw 容器有 idle timeout，在超时前会复用已有容器。代码改动、`.mcp.json` 改动、Dockerfile 改动都不会自动更新正在运行的容器。

## 解决方案

改完代码后，必须 kill 旧容器：
```bash
docker ps | grep nanoclaw
docker kill <container_id>
```

下一次 @阿飞 时会启动新容器，带上最新配置。

## 排查规则

调试飞书/MCP 相关问题时，如果代码逻辑看起来正确但行为不对，**第一件事**检查容器是不是在代码修改之前启动的。

## Related

- [nanoclaw-container-env-injection](nanoclaw-container-env-injection.md)
- [nanoclaw-onecli-proxy-bypass](nanoclaw-onecli-proxy-bypass.md)
