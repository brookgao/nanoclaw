# Host Runner Migration Design

## Problem

NanoClaw runs every agent invocation inside a Docker container. This causes four systemic pain points:

1. **Startup latency**: Each message triggers a `docker run` — cold start adds seconds before the agent can begin processing.
2. **Capability constraints**: The container is a stripped-down Linux VM. Tools available on the macOS host (Playwright, system Chrome, local CLIs) are unavailable or require separate installation inside the image.
3. **Debugging difficulty**: Logs are trapped inside ephemeral containers. Reproducing issues requires rebuilding images, attaching to running containers, or reading post-mortem log files.
4. **Resource overhead**: Docker Desktop on macOS reserves a fixed memory/CPU budget for its Linux VM, even when agents are idle.

## Solution

Replace the Docker container runner with a direct host-process runner. Each agent invocation becomes a `spawn('node', ['agent-runner/dist/index.js'])` on the host, with environment variables replacing volume mounts and Docker CLI args.

### Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Group isolation | None (soft/trust model) | Single-user system; same trust level as running Claude Code directly |
| Credentials | `CLAUDE_CODE_OAUTH_TOKEN` via env | Max subscription; OneCLI proxy no longer needed |
| Browser automation | Host Playwright + system Chrome | Already installed (Playwright 1.59.1, Chrome in /Applications) |
| IPC mechanism | File-based IPC (unchanged) | Proven reliable; MCP server still runs as agent subprocess |
| Migration strategy | One-step replacement | Clean cut; no parallel mode maintenance burden |
| Concurrency | Keep `GroupQueue` + `MAX_CONCURRENT_CONTAINERS` | Frequent multi-group concurrency; queue logic is container-agnostic |

---

## Architecture

### Before (Container Mode)

```
Host Process → docker run nanoclaw-agent → [Container: agent-runner + MCP server]
                  ↕ volume mounts              ↕ file IPC
              groups/{name}/              data/ipc/{name}/
```

### After (Host Mode)

```
Host Process → spawn node agent-runner → [Child Process: agent-runner + MCP server]
                  ↕ env vars + cwd             ↕ file IPC (unchanged)
              groups/{name}/              data/ipc/{name}/
```

### Path Mapping

Container paths become environment variables injected by the host runner:

| Container Path | Environment Variable | Host Value |
|---|---|---|
| `/workspace/group` | `NANOCLAW_GROUP_DIR` | `groups/{name}/` (also used as `cwd`) |
| `/workspace/ipc` | `NANOCLAW_IPC_DIR` | `data/ipc/{name}/` |
| `/workspace/global` | `NANOCLAW_GLOBAL_DIR` | `groups/global/` |
| `/workspace/shared-wiki` | `NANOCLAW_WIKI_DIR` | `groups/global/wiki/` |
| `/workspace/extra` | `NANOCLAW_EXTRA_DIRS` | Colon-separated list (knowledge-promoter uses this) |
| `/home/node/.claude` | `CLAUDE_CONFIG_DIR` | `data/sessions/{name}/.claude/` |
| `/workspace/project` | _(removed)_ | Agent has direct host filesystem access |
| `/app/src` | _(removed)_ | agent-runner runs from project directory |
| `/app/feishu-blocks-mcp/dist/index.js` | `NANOCLAW_FEISHU_MCP_PATH` | `container/feishu-blocks-mcp/dist/index.js` (absolute) |
| `/app/mem0-mcp/index.mjs` | `NANOCLAW_MEM0_MCP_PATH` | `container/mem0-mcp/index.mjs` (absolute) |

### Process Lifecycle

```
1. Host receives message for group
2. GroupQueue grants turn
3. host-runner.ts:
   a. Prepare directories (group folder, IPC dirs, .claude/)
   b. Sync skills (container/skills/ + ~/.claude/skills/ → group .claude/skills/)
   c. Build env: credentials, paths, timezone, GH_TOKEN gitconfig
   d. spawn('node', [AGENT_RUNNER_PATH], { cwd: groupDir, env, stdio: pipe })
   e. Write JSON input to stdin, close stdin
4. agent-runner reads stdin, calls Claude Agent SDK query()
5. Streaming output via stdout OUTPUT_MARKER pairs (unchanged)
6. File IPC for send_message / schedule_task (unchanged)
7. Timeout: process.kill() replaces docker stop
```

---

## File Changes

### Deleted Files

| File | Reason |
|---|---|
| `src/container-runner.ts` | Replaced by `host-runner.ts` |
| `src/container-runner.test.ts` | Corresponding test |
| `src/container-runtime.ts` | Docker-specific: health check, stop, orphan cleanup |
| `src/container-runtime.test.ts` | Corresponding test |
| `src/mount-security.ts` | Container mount validation; no mounts on host |
| `src/mount-security.test.ts` | Corresponding test |

### New Files

| File | Purpose |
|---|---|
| `src/host-runner.ts` | Process spawner: env setup, skill sync, spawn node, output parsing, timeout |

### Modified Files

#### `container/agent-runner/src/index.ts`

14 hardcoded paths → read from environment variables with container-path fallbacks.

```typescript
// Before
let IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_EVENTS_DIR = '/workspace/ipc/events';

// After
let IPC_INPUT_DIR = process.env.NANOCLAW_IPC_DIR
  ? path.join(process.env.NANOCLAW_IPC_DIR, 'input')
  : '/workspace/ipc/input';
// CLOSE_SENTINEL must be a function — the const was computed at load time
// before _setIpcInputDir() could run, a latent bug in the current code.
function ipcClosesentinel(): string {
  return path.join(IPC_INPUT_DIR, '_close');
}
const IPC_EVENTS_DIR = process.env.NANOCLAW_IPC_DIR
  ? path.join(process.env.NANOCLAW_IPC_DIR, 'events')
  : '/workspace/ipc/events';
```

Full path mapping:

| Line(s) | Current | After |
|---|---|---|
| 84-90 | `/workspace/ipc/input`, `/workspace/ipc/events` | `NANOCLAW_IPC_DIR` + subfolder |
| 88 | `const IPC_INPUT_CLOSE_SENTINEL` | Function `ipcClosesentinel()` |
| 240 | `/workspace/group/conversations` | `NANOCLAW_GROUP_DIR` + `/conversations` |
| 259 | `/workspace/group/memory` | `NANOCLAW_GROUP_DIR` + `/memory` |
| 524 | `/workspace/global/CLAUDE.md` | `NANOCLAW_GLOBAL_DIR` + `/CLAUDE.md` |
| 533 | `/workspace/extra` | `NANOCLAW_EXTRA_DIRS` (colon-split) |
| 548 | `/workspace/group` (SDK cwd) | `NANOCLAW_GROUP_DIR` |
| 789 | `/tmp/input.json` cleanup | Remove (entrypoint buffering no longer needed) |

#### `container/agent-runner/src/ipc-mcp-stdio.ts`

3 hardcoded paths → read `NANOCLAW_IPC_DIR`:

```typescript
// Before
const IPC_DIR = '/workspace/ipc';

// After
const IPC_DIR = process.env.NANOCLAW_IPC_DIR || '/workspace/ipc';
```

#### `src/index.ts`

- Import `runHostAgent` from `./host-runner.js` instead of `runContainerAgent` from `./container-runner.js`
- Remove imports from `./container-runtime.js`
- Remove `ensureContainerSystemRunning()` call (line 649-652)
- Add `ensureAgentRunnerBuilt()` check (verify `container/agent-runner/dist/index.js` exists)
- Replace orphan cleanup with stale process cleanup (kill `node agent-runner` processes from previous runs, by PID file or process name pattern)

#### `src/knowledge-promoter.ts`

- `runContainerAgent` → `runHostAgent`
- Remove `additionalMounts` manipulation (no mounts on host)
- Replace container path in prompt (`/workspace/extra/shared-wiki-rw/`) with actual `GROUPS_DIR/global/wiki` path
- Pass wiki path via `NANOCLAW_EXTRA_DIRS` env

#### `src/task-scheduler.ts`

- `runContainerAgent` → `runHostAgent`
- `writeTasksSnapshot` import path changes

#### `src/config.ts`

- Remove: `CONTAINER_IMAGE`, `CONTAINER_TIMEOUT`, `CONTAINER_MAX_OUTPUT_SIZE`
- Add: `AGENT_RUNNER_PATH` (path to `container/agent-runner/dist/index.js`)
- Keep: `IDLE_TIMEOUT`, `MAX_CONCURRENT_CONTAINERS` (rename consideration but not required)

#### `src/ipc.ts`

- Type import `AvailableGroup` from `./host-runner.js` instead of `./container-runner.js`

#### All group `.mcp.json` files

- Rewritten at spawn time by host-runner: `/app/feishu-blocks-mcp/...` → absolute host path from `NANOCLAW_FEISHU_MCP_PATH`; `/app/mem0-mcp/...` → from `NANOCLAW_MEM0_MCP_PATH`
- Safe because GroupQueue serializes per-group invocations (no race condition)

### Unchanged Files

| File | Reason |
|---|---|
| `src/group-queue.ts` | Already ChildProcess-based; `containerName` is display-only |
| `src/db.ts` | No container dependency |
| `src/router.ts` | No container dependency |
| `container/agent-runner/src/ipc-sync.ts` | Already reads `NANOCLAW_IPC_DIR` env var |
| All channel files | No container dependency |
| All `.mcp.json` files | Rewritten at spawn time by host-runner (per-group, serialized by GroupQueue) |

---

## host-runner.ts Core Design

### Function Signature (unchanged from container-runner)

```typescript
export async function runHostAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, name: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput>
```

### Environment Construction

Replaces `buildContainerArgs()` (150 lines of Docker CLI args) with a flat env object:

```typescript
function buildProcessEnv(group: RegisteredGroup, input: ContainerInput): NodeJS.ProcessEnv {
  const groupDir = resolveGroupFolderPath(group.folder);
  const ipcDir = resolveGroupIpcPath(group.folder);
  const globalDir = path.join(GROUPS_DIR, 'global');
  const claudeDir = path.join(DATA_DIR, 'sessions', group.folder, '.claude');

  return {
    ...process.env,
    // Credentials
    CLAUDE_CODE_OAUTH_TOKEN,
    // No ANTHROPIC_API_KEY — OAuth token is the sole auth method
    // Model pin
    CLAUDE_MODEL: 'claude-opus-4-6',
    // Path mapping (replaces volume mounts)
    NANOCLAW_GROUP_DIR: groupDir,
    NANOCLAW_IPC_DIR: ipcDir,
    NANOCLAW_GLOBAL_DIR: globalDir,
    NANOCLAW_WIKI_DIR: path.join(globalDir, 'wiki'),
    NANOCLAW_EXTRA_DIRS: '',
    CLAUDE_CONFIG_DIR: claudeDir,
    // MCP server paths (replaces /app/ container paths)
    NANOCLAW_FEISHU_MCP_PATH: path.resolve('container/feishu-blocks-mcp/dist/index.js'),
    NANOCLAW_MEM0_MCP_PATH: path.resolve('container/mem0-mcp/index.mjs'),
    // Timezone
    TZ: TIMEZONE,
    // SDK config
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(
      group.containerConfig?.autoCompactWindow ?? 120000
    ),
    // Agent teams
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
    // GH_TOKEN: per-process gitconfig (see below)
    ...(GH_TOKEN ? { GH_TOKEN, GIT_CONFIG_GLOBAL: writeGitConfig() } : {}),
    // Per-group extra env
    ...group.containerConfig?.extraEnv,
    // Feishu user token (refreshed at spawn time)
    ...(await refreshFeishuToken(group)),
  };
}
```

### GH_TOKEN Handling

Docker entrypoint set global git config. On host, we use a per-process temporary gitconfig to avoid polluting the host:

```typescript
function writeGitConfig(): string {
  const configPath = path.join(os.tmpdir(), `nanoclaw-gitconfig-${process.pid}`);
  const content = [
    `[url "https://x-access-token:${GH_TOKEN}@github.com/"]`,
    `  insteadOf = git@github.com:`,
    `  insteadOf = https://github.com/`,
  ].join('\n');
  fs.writeFileSync(configPath, content, { mode: 0o600 });
  return configPath;
}
```

Passed via `GIT_CONFIG_GLOBAL` env var — scoped to the child process only.

### Timeout Handling

```typescript
// Before (container-runner.ts:648)
stopContainer(containerName);  // docker stop -t 1

// After
proc.kill('SIGTERM');
setTimeout(() => {
  if (!proc.killed) proc.kill('SIGKILL');
}, 5000);
```

### Skill Sync

Extracted from `buildVolumeMounts()` — same logic, just no mount step:

```typescript
function syncSkills(group: RegisteredGroup): void {
  const claudeDir = path.join(DATA_DIR, 'sessions', group.folder, '.claude');
  const skillsDst = path.join(claudeDir, 'skills');

  // 1. Copy container/skills/ → group .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const dir of fs.readdirSync(skillsSrc)) {
      const src = path.join(skillsSrc, dir);
      if (fs.statSync(src).isDirectory()) {
        fs.cpSync(src, path.join(skillsDst, dir), { recursive: true });
      }
    }
  }

  // 2. Copy ~/.claude/skills/ → group .claude/skills/ (don't overwrite container skills)
  const userSkills = path.join(process.env.HOME!, '.claude', 'skills');
  if (fs.existsSync(userSkills)) {
    for (const dir of fs.readdirSync(userSkills)) {
      const src = path.join(userSkills, dir);
      const dst = path.join(skillsDst, dir);
      if (fs.statSync(src).isDirectory() && !fs.existsSync(dst)) {
        fs.cpSync(src, dst, { recursive: true });
      }
    }
  }
}
```

### Functions Carried Over from container-runner.ts

These functions move to `host-runner.ts` unchanged:

- `writeTasksSnapshot()` — writes filtered tasks JSON for IPC
- `writeGroupsSnapshot()` — writes available groups JSON for IPC
- `resolveIdleMs()` — per-group idle timeout resolution
- `computeHardTimeoutMs()` — hard-kill timeout calculation

### Functions Removed

- `buildVolumeMounts()` — no mounts on host
- `buildContainerArgs()` — replaced by `buildProcessEnv()`

---

## .mcp.json Path Resolution

Group `.mcp.json` files reference `/app/feishu-blocks-mcp/dist/index.js` and `/app/mem0-mcp/index.mjs`. Rather than rewriting these files (fragile, race conditions), the agent-runner resolves MCP server paths at runtime:

The agent-runner's `query()` call already injects the `nanoclaw` MCP server programmatically. For feishu-blocks and mem0, these are configured in the group's `.mcp.json` which the SDK reads from `cwd`. 

**Strategy:** The host-runner rewrites the per-group `.mcp.json` at spawn time (before the process starts), replacing `/app/...` paths with the actual host paths from `NANOCLAW_FEISHU_MCP_PATH` and `NANOCLAW_MEM0_MCP_PATH`. This is safe because:
- Each group has its own `.mcp.json` (no sharing)
- GroupQueue serializes per-group invocations (no race between two agents for the same group)

---

## Startup Changes

```typescript
// Before (index.ts main())
ensureContainerSystemRunning();  // docker info + orphan cleanup

// After
ensureAgentRunnerBuilt();  // check container/agent-runner/dist/index.js exists
cleanupStaleProcesses();   // kill leftover node agent-runner processes by PID pattern
```

---

## What We Keep From the Container World

| Asset | Location | Status |
|---|---|---|
| agent-runner source | `container/agent-runner/` | Keep — runs on host now |
| feishu-blocks-mcp | `container/feishu-blocks-mcp/` | Keep — path changes only |
| mem0-mcp | `container/mem0-mcp/` | Keep — path changes only |
| container skills | `container/skills/` | Keep — synced to .claude/skills/ |
| Dockerfile | `container/Dockerfile` | Keep for reference, no longer used at runtime |
| build.sh | `container/build.sh` | Keep for reference, no longer used at runtime |

---

## Testing Strategy

1. **Unit tests for host-runner.ts**: Mock `spawn`, verify env construction and path resolution
2. **Integration test**: Spawn agent-runner with env vars, send a simple prompt, verify OUTPUT_MARKER response
3. **IPC test**: Verify send_message and schedule_task still flow through file IPC
4. **Session continuity**: Start a session, send a follow-up message, verify session resumes
5. **Manual smoke test**: Send a message via Feishu, verify end-to-end response

## Rollback

If issues arise, `git revert` the migration commit and rebuild the Docker image. Sessions stored in `data/sessions/` are format-compatible in both modes.
