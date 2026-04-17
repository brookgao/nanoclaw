# NanoClaw Container 环境变量注入

> extraEnv 机制：正确地将 host 环境变量传递到 agent 容器

## 问题

容器内 agent 需要 host 的 secrets（如 GH_TOKEN、FEISHU_USER_ACCESS_TOKEN）。最初尝试在 `settings.json` 的 `env` 字段设置，但这只影响 Claude SDK 进程环境，不会传递到 `docker run` 的容器环境。

## 解决方案

`ContainerConfig` 新增 `extraEnv: Record<string, string>` 字段。`container-runner.ts` 的 `buildContainerArgs()` 遍历 extraEnv，每个 key-value 对加 `-e KEY=VAL` 到 docker run 参数。

## Feishu 群特殊处理

feishu 群自动注入 `FEISHU_USER_ACCESS_TOKEN`：
```typescript
if (group?.folder?.startsWith('feishu_')) {
  const token = execSync('refresh-feishu-user-token.sh').trim();
  if (token) args.push('-e', `FEISHU_USER_ACCESS_TOKEN=${token}`);
}
```

## Stale Container 陷阱

⚠️ 代码改了 extraEnv 不会影响已运行的容器。必须 kill 旧容器，让新请求触发新容器启动，才能拿到新 env。

## Related

- [nanoclaw-stale-container](nanoclaw-stale-container.md)
