# Host Runner Migration — 交接文档

## 概要

NanoClaw 从 Docker 容器模式迁移到宿主机直接运行模式。agent 不再通过 `docker run` 启动，改为 `spawn('node', [agent-runner])` 直接在 macOS 上运行。

**状态：代码完成，冒烟测试通过，有一个待修复的重复发送 bug**

## 改动范围

### 新增文件
- `src/host-runner.ts` (733 行) — 替代 container-runner.ts，核心功能：环境变量构建、skill 同步、进程 spawn、stdout 解析、超时处理

### 删除文件 (−1,940 行)
- `src/container-runner.ts` — 被 host-runner.ts 替代
- `src/container-runner.test.ts`
- `src/container-runtime.ts` — Docker 健康检查、stop、orphan 清理
- `src/container-runtime.test.ts`
- `src/mount-security.ts` — 容器 mount 验证，宿主机不需要

### 修改文件
| 文件 | 改动 |
|------|------|
| `container/agent-runner/src/index.ts` | 14 个硬编码路径 → 环境变量 + 容器回退 |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | `IPC_DIR` → 从 `NANOCLAW_IPC_DIR` 读取 |
| `src/config.ts` | 删除 `CONTAINER_IMAGE/TIMEOUT/MAX_OUTPUT_SIZE`，新增 `AGENT_RUNNER_PATH/PROCESS_TIMEOUT/PROCESS_MAX_OUTPUT_SIZE` |
| `src/index.ts` | 导入切换 + `ensureSystemRunning()` 替代 `ensureContainerSystemRunning()` |
| `src/knowledge-promoter.ts` | 删除 `additionalMounts`，prompt 用实际 `globalWikiDir` 路径 |
| `src/task-scheduler.ts` | 导入切换 |
| `src/ipc.ts` | `AvailableGroup` 类型导入切换 |

### 测试
- `src/host-runner.test.ts` (23 个测试) — 覆盖 spawn、输出解析、错误处理、超时、纯函数

## Commits (13 个)

```
f50adb6 fix: remove unused GROUPS_DIR import from task-scheduler
f8016f1 test: add host-runner unit tests
ee2d322 refactor: delete container-runner, container-runtime, mount-security
af65363 refactor: switch ipc.ts AvailableGroup import to host-runner
df5727b refactor: switch task-scheduler to host-runner
18e7cf1 refactor: switch knowledge-promoter to host-runner, remove mount manipulation
46f8a88 refactor: switch index.ts from container-runner to host-runner
1dfb2ff feat: add host-runner.ts replacing Docker container runner
1b12815 refactor: replace container config constants with process-based equivalents
129fb58 refactor: make agent-runner paths configurable via env vars
011a11c refactor: make IPC MCP server read NANOCLAW_IPC_DIR from env
f61428e docs: host-runner migration implementation plan
c1c6d37 docs: host-runner migration design spec
```

## 验证结果

| 项目 | 状态 |
|------|------|
| TypeScript 编译 (host + agent-runner) | ✅ 通过 |
| 全量测试 (353 tests, 24 files) | ✅ 通过 |
| ESLint | ✅ 0 errors |
| 服务启动 | ✅ 10 groups, feishu WS connected |
| Agent 响应 | ✅ "收到！"，session 连续性正常 |
| Cache 命中 | ✅ 第二条消息 cacheReadTokens ~31K |
| 重复发送 | ✅ 已解决 — 根因见下方 |

## 已解决：重复发送 Bug

**现象：** 用户发一条消息，阿飞回复两次相同内容（不同 token 用量）。

**根因：** 不是代码 bug。是 **两个 nanoclaw 实例同时运行**：
- launchd 管理的生产服务（`com.nanoclaw`，使用旧的 `dist/index.js`）
- 手动启动的 dev 服务（`npx tsx src/index.ts`）

两个进程都连着飞书 WebSocket，收到同一条消息，各自 spawn agent 回复一次。

**验证：** 停掉 launchd 服务和残留 Docker 容器后，单实例运行只产生一条回复。

**预防措施：** 迁移后需要重新构建 `dist/` 并重启 launchd 服务，确保只有一个实例。

## 架构变化要点

### 路径映射（环境变量替代 Docker volume mount）
| 环境变量 | 宿主机值 |
|----------|----------|
| `NANOCLAW_GROUP_DIR` | `groups/{name}/`（也作为 cwd） |
| `NANOCLAW_IPC_DIR` | `data/ipc/{name}/` |
| `NANOCLAW_GLOBAL_DIR` | `groups/global/` |
| `NANOCLAW_WIKI_DIR` | `groups/global/wiki/` |
| `CLAUDE_CONFIG_DIR` | `data/sessions/{name}/.claude/` |

### 关键行为变化
- **stdin 立即关闭：** `host-runner.ts` 写入 JSON 后调用 `proc.stdin.end()`，follow-up 消息通过 IPC 文件（`data/ipc/{group}/input/`）投递
- **GH_TOKEN 隔离：** 写临时 gitconfig 到 `/tmp/nanoclaw-gitconfig-{pid}`，通过 `GIT_CONFIG_GLOBAL` 环境变量传入子进程
- **.mcp.json 重写：** spawn 前将 `/app/...` 容器路径替换为宿主机绝对路径
- **超时处理：** `SIGTERM` + 5 秒后 `SIGKILL`，替代 `docker stop`
- **session 隔离：** 每个 group 独立 `CLAUDE_CONFIG_DIR`，防止跨群记忆混淆

### 保留不变
- File-based IPC（send_message、schedule_task）
- GroupQueue 并发控制
- agent-runner 代码（只改了路径读取方式，加了容器回退）
- container/skills/、feishu-blocks-mcp、mem0-mcp（路径变了，代码不变）
- Dockerfile 和 build.sh（保留做参考，不再在运行时使用）

## 回滚方案

`git revert` 迁移 commits，重新 `./container/build.sh` 构建 Docker 镜像。`data/sessions/` 中的 session 文件格式两种模式兼容。
