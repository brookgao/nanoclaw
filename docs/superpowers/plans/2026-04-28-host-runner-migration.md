# Host Runner Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Docker container runner with direct host-process spawning, eliminating startup latency, capability constraints, debugging difficulty, and resource overhead.

**Architecture:** Each agent invocation becomes `spawn('node', ['container/agent-runner/dist/index.js'])` with environment variables replacing volume mounts. File-based IPC, MCP servers, session management, and streaming output parsing remain unchanged.

**Tech Stack:** Node.js 22, TypeScript, vitest, Claude Agent SDK

**Spec:** `docs/superpowers/specs/2026-04-28-host-runner-migration-design.md`

---

### Task 1: Make agent-runner paths configurable via environment variables

**Files:**
- Modify: `container/agent-runner/src/index.ts`

This is the foundation — agent-runner must work on both host and container (fallback to `/workspace/...` defaults).

- [ ] **Step 1: Replace hardcoded IPC paths with env-driven resolution**

In `container/agent-runner/src/index.ts`, replace lines 84-90:

```typescript
// BEFORE (lines 84-90):
let IPC_INPUT_DIR = '/workspace/ipc/input';
export function _setIpcInputDir(dir: string): void {
  IPC_INPUT_DIR = dir;
}
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;
const IPC_EVENTS_DIR = '/workspace/ipc/events';

// AFTER:
const IPC_BASE = process.env.NANOCLAW_IPC_DIR || '/workspace/ipc';
let IPC_INPUT_DIR = path.join(IPC_BASE, 'input');
export function _setIpcInputDir(dir: string): void {
  IPC_INPUT_DIR = dir;
}
function ipcCloseSentinel(): string {
  return path.join(IPC_INPUT_DIR, '_close');
}
const IPC_POLL_MS = 500;
const IPC_EVENTS_DIR = path.join(IPC_BASE, 'events');
```

Then replace all references to `IPC_INPUT_CLOSE_SENTINEL` with `ipcCloseSentinel()`. There are 3 call sites:

Line ~377 (`shouldClose` function):
```typescript
// BEFORE:
if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

// AFTER:
if (fs.existsSync(ipcCloseSentinel())) {
  try { fs.unlinkSync(ipcCloseSentinel()); } catch { /* ignore */ }
```

Line ~819 (stale sentinel cleanup in `main()`):
```typescript
// BEFORE:
try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

// AFTER:
try { fs.unlinkSync(ipcCloseSentinel()); } catch { /* ignore */ }
```

- [ ] **Step 2: Replace hardcoded workspace paths with env-driven resolution**

Add path resolution constants near the top of `main()` (after parsing containerInput, around line 802):

```typescript
const GROUP_DIR = process.env.NANOCLAW_GROUP_DIR || '/workspace/group';
const GLOBAL_DIR = process.env.NANOCLAW_GLOBAL_DIR || '/workspace/global';
const EXTRA_BASE = process.env.NANOCLAW_EXTRA_DIRS || '/workspace/extra';
```

Then replace each hardcoded path:

Line ~240 (`/workspace/group/conversations`):
```typescript
// BEFORE:
const conversationsDir = '/workspace/group/conversations';
// AFTER:
const conversationsDir = path.join(GROUP_DIR, 'conversations');
```

Line ~259 (`/workspace/group/memory`):
```typescript
// BEFORE:
const memoryDir = '/workspace/group/memory';
// AFTER:
const memoryDir = path.join(GROUP_DIR, 'memory');
```

Line ~524 (`/workspace/global/CLAUDE.md`):
```typescript
// BEFORE:
const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
// AFTER:
const globalClaudeMdPath = path.join(GLOBAL_DIR, 'CLAUDE.md');
```

Line ~533 (`/workspace/extra`):
```typescript
// BEFORE:
const extraBase = '/workspace/extra';
// AFTER:
const extraDirsList = EXTRA_BASE.includes(':') ? EXTRA_BASE.split(':') : [EXTRA_BASE];
const extraDirs: string[] = [];
for (const extraBase of extraDirsList) {
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
}
```

Remove the old `extraBase`/`extraDirs` block (lines ~532-541) that it replaces.

Line ~548 (`/workspace/group` as SDK cwd):
```typescript
// BEFORE:
cwd: '/workspace/group',
// AFTER:
cwd: GROUP_DIR,
```

Line ~789 (`/tmp/input.json` cleanup):
```typescript
// BEFORE:
try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
// AFTER: (remove entirely — entrypoint buffering no longer needed on host)
```

- [ ] **Step 3: Pass GROUP_DIR, GLOBAL_DIR, EXTRA_BASE into the createPreCompactHook closure**

The `createPreCompactHook` function is defined outside `main()` but uses `/workspace/group/...` paths. Since it's a factory function, pass the resolved paths in:

```typescript
// BEFORE (line ~217):
function createPreCompactHook(assistantName?: string): HookCallback {

// AFTER:
function createPreCompactHook(assistantName: string | undefined, groupDir: string): HookCallback {
```

Inside the hook, replace:
```typescript
// BEFORE:
const conversationsDir = '/workspace/group/conversations';
// ...
const memoryDir = '/workspace/group/memory';

// AFTER:
const conversationsDir = path.join(groupDir, 'conversations');
// ...
const memoryDir = path.join(groupDir, 'memory');
```

Update the call site in `runQuery()` (~line 596):
```typescript
// BEFORE:
PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName)] }],

// AFTER:
PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName, GROUP_DIR)] }],
```

Note: `GROUP_DIR` needs to be accessible inside `runQuery`. Since `runQuery` is called from `main()` and `GROUP_DIR` is defined in `main()`, pass it as a parameter to `runQuery` or move the const to module scope. Simplest: move the env-driven resolution to module scope (right after the IPC_BASE const block):

```typescript
const IPC_BASE = process.env.NANOCLAW_IPC_DIR || '/workspace/ipc';
// ... existing IPC vars ...
const GROUP_DIR = process.env.NANOCLAW_GROUP_DIR || '/workspace/group';
const GLOBAL_DIR = process.env.NANOCLAW_GLOBAL_DIR || '/workspace/global';
const EXTRA_BASE = process.env.NANOCLAW_EXTRA_DIRS || '/workspace/extra';
```

- [ ] **Step 4: Build agent-runner and verify it compiles**

```bash
cd container/agent-runner && npm run build
```

Expected: Clean compilation, `dist/index.js` produced.

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/index.ts
git commit -m "refactor: make agent-runner paths configurable via env vars

Reads NANOCLAW_IPC_DIR, NANOCLAW_GROUP_DIR, NANOCLAW_GLOBAL_DIR,
NANOCLAW_EXTRA_DIRS from environment with /workspace/... fallbacks.
Fixes latent bug: IPC_INPUT_CLOSE_SENTINEL was a const computed at
module load time, now a function so _setIpcInputDir() works correctly."
```

---

### Task 2: Make IPC MCP server paths configurable

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts`

- [ ] **Step 1: Replace hardcoded IPC_DIR**

```typescript
// BEFORE (line 15-17):
const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// AFTER:
const IPC_DIR = process.env.NANOCLAW_IPC_DIR || '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
```

Line ~233 (current_tasks.json):
```typescript
// This already derives from IPC_DIR, so no change needed:
const tasksFile = path.join(IPC_DIR, 'current_tasks.json');
```

- [ ] **Step 2: Build and verify**

```bash
cd container/agent-runner && npm run build
```

- [ ] **Step 3: Commit**

```bash
git add container/agent-runner/src/ipc-mcp-stdio.ts
git commit -m "refactor: make IPC MCP server read NANOCLAW_IPC_DIR from env"
```

---

### Task 3: Update config.ts

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Remove container-specific config, add AGENT_RUNNER_PATH**

```typescript
// REMOVE these lines:
export const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(process.env.CONTAINER_TIMEOUT || '1800000', 10);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760', 10,
); // 10MB default

// ADD (after STORE_DIR/GROUPS_DIR/DATA_DIR block):
export const AGENT_RUNNER_PATH = path.resolve(
  process.cwd(), 'container', 'agent-runner', 'dist', 'index.js',
);

// ADD (replace CONTAINER_TIMEOUT — used for hard-kill timeout):
export const PROCESS_TIMEOUT = parseInt(
  process.env.PROCESS_TIMEOUT || '1800000', 10,
);
export const PROCESS_MAX_OUTPUT_SIZE = parseInt(
  process.env.PROCESS_MAX_OUTPUT_SIZE || '10485760', 10,
); // 10MB default
```

Also remove `CONTAINER_IMAGE` from the `readEnvFile` call if it's there (it's not — it reads from `process.env` directly, so just removing the export is sufficient).

- [ ] **Step 2: Verify build**

```bash
npm run build
```

Expected: Compilation errors in files that import the removed constants — that's expected, we'll fix them in subsequent tasks.

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "refactor: replace container config constants with process-based equivalents"
```

---

### Task 4: Create host-runner.ts

**Files:**
- Create: `src/host-runner.ts`

This is the core of the migration — replaces `container-runner.ts`.

- [ ] **Step 1: Write host-runner.ts**

```typescript
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  AGENT_RUNNER_PATH,
  CLAUDE_CODE_OAUTH_TOKEN,
  DATA_DIR,
  GH_TOKEN,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  PROCESS_MAX_OUTPUT_SIZE,
  PROCESS_TIMEOUT,
  TIMEZONE,
} from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { ImageAttachment, RegisteredGroup } from './types.js';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  images?: ImageAttachment[];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  numTurns: number;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  usage?: TokenUsage;
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

export function resolveIdleMs(group: RegisteredGroup): number {
  return group.containerConfig?.idleTimeout ?? IDLE_TIMEOUT;
}

export function computeHardTimeoutMs(group: RegisteredGroup): number {
  const configTimeout = group.containerConfig?.timeout ?? PROCESS_TIMEOUT;
  return Math.max(configTimeout, resolveIdleMs(group) + 30_000);
}

function syncSkills(group: RegisteredGroup): void {
  const claudeDir = path.join(DATA_DIR, 'sessions', group.folder, '.claude');
  const skillsDst = path.join(claudeDir, 'skills');

  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const dir of fs.readdirSync(skillsSrc)) {
      const src = path.join(skillsSrc, dir);
      if (fs.statSync(src).isDirectory()) {
        fs.cpSync(src, path.join(skillsDst, dir), { recursive: true });
      }
    }
  }

  const userSkills = path.join(
    process.env.HOME ?? os.homedir(),
    '.claude',
    'skills',
  );
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

function ensureGroupClaudeSettings(group: RegisteredGroup): void {
  const groupSessionsDir = path.join(DATA_DIR, 'sessions', group.folder, '.claude');
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }
}

let gitConfigPath: string | null = null;

function writeGitConfig(): string {
  if (gitConfigPath && fs.existsSync(gitConfigPath)) return gitConfigPath;
  gitConfigPath = path.join(os.tmpdir(), `nanoclaw-gitconfig-${process.pid}`);
  const content = [
    `[url "https://x-access-token:${GH_TOKEN}@github.com/"]`,
    `\tinsteadOf = git@github.com:`,
    `\tinsteadOf = https://github.com/`,
  ].join('\n');
  fs.writeFileSync(gitConfigPath, content, { mode: 0o600 });
  return gitConfigPath;
}

function rewriteMcpJson(groupDir: string): void {
  const mcpJsonPath = path.join(groupDir, '.mcp.json');
  if (!fs.existsSync(mcpJsonPath)) return;

  const feishuMcpPath = path.resolve(process.cwd(), 'container', 'feishu-blocks-mcp', 'dist', 'index.js');
  const mem0McpPath = path.resolve(process.cwd(), 'container', 'mem0-mcp', 'index.mjs');

  try {
    const content = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
    let changed = false;

    if (content.mcpServers?.['feishu-blocks']?.args?.[0]?.startsWith('/app/')) {
      content.mcpServers['feishu-blocks'].args[0] = feishuMcpPath;
      changed = true;
    }
    if (content.mcpServers?.mem0?.args?.[0]?.startsWith('/app/')) {
      content.mcpServers.mem0.args[0] = mem0McpPath;
      changed = true;
    }

    if (changed) {
      fs.writeFileSync(mcpJsonPath, JSON.stringify(content, null, 2) + '\n');
    }
  } catch (err) {
    logger.warn({ groupDir, err }, 'Failed to rewrite .mcp.json');
  }
}

async function refreshFeishuToken(
  group: RegisteredGroup,
): Promise<Record<string, string>> {
  if (!group.folder?.startsWith('feishu_')) return {};
  try {
    const refreshScript = path.join(process.cwd(), 'scripts', 'refresh-feishu-user-token.sh');
    if (!fs.existsSync(refreshScript)) return {};
    const { execSync } = await import('node:child_process');
    const result = execSync(refreshScript, {
      encoding: 'utf8',
      timeout: 25000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const token = result.trim();
    if (token) {
      logger.debug(
        { group: group.folder, tokenPrefix: token.slice(0, 15) },
        '[feishu] injected user access token',
      );
      return { FEISHU_USER_ACCESS_TOKEN: token };
    }
  } catch (err) {
    const stderr = (err as any).stderr ?? '';
    logger.error(
      { group: group.folder, err: (err as Error).message, stderr },
      '[feishu] failed to refresh user access token',
    );
  }
  return {};
}

async function buildProcessEnv(
  group: RegisteredGroup,
): Promise<NodeJS.ProcessEnv> {
  const groupDir = resolveGroupFolderPath(group.folder);
  const ipcDir = resolveGroupIpcPath(group.folder);
  const globalDir = path.join(GROUPS_DIR, 'global');
  const claudeDir = path.join(DATA_DIR, 'sessions', group.folder, '.claude');

  const feishuEnv = await refreshFeishuToken(group);

  return {
    ...process.env,
    CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_CODE_OAUTH_TOKEN || undefined,
    CLAUDE_MODEL: 'claude-opus-4-6',
    NANOCLAW_GROUP_DIR: groupDir,
    NANOCLAW_IPC_DIR: ipcDir,
    NANOCLAW_GLOBAL_DIR: globalDir,
    NANOCLAW_WIKI_DIR: path.join(globalDir, 'wiki'),
    NANOCLAW_EXTRA_DIRS: '',
    CLAUDE_CONFIG_DIR: claudeDir,
    NANOCLAW_FEISHU_MCP_PATH: path.resolve(process.cwd(), 'container', 'feishu-blocks-mcp', 'dist', 'index.js'),
    NANOCLAW_MEM0_MCP_PATH: path.resolve(process.cwd(), 'container', 'mem0-mcp', 'index.mjs'),
    TZ: TIMEZONE,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(
      group.containerConfig?.autoCompactWindow ?? 120000,
    ),
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
    ...(GH_TOKEN ? { GH_TOKEN, GIT_CONFIG_GLOBAL: writeGitConfig() } : {}),
    ...group.containerConfig?.extraEnv,
    ...feishuEnv,
  };
}

export async function runHostAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  ensureGroupClaudeSettings(group);
  syncSkills(group);
  rewriteMcpJson(groupDir);

  const ipcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(ipcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'input'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'sync_requests'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'sync_responses'), { recursive: true });

  const env = await buildProcessEnv(group);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const processName = `nanoclaw-${safeName}-${Date.now()}`;

  logger.info(
    { group: group.name, processName, isMain: input.isMain },
    'Spawning host agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const proc = spawn('node', [AGENT_RUNNER_PATH], {
      cwd: groupDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(proc, processName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();

    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();

      if (!stdoutTruncated) {
        const remaining = PROCESS_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Process stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break;

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            resetTimeout();
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ process: group.folder }, line);
      }
      if (stderrTruncated) return;
      const remaining = PROCESS_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Process stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout ?? PROCESS_TIMEOUT;
    const timeoutMs = computeHardTimeoutMs(group);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, processName },
        'Process timeout, sending SIGTERM',
      );
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) {
          logger.warn({ group: group.name, processName }, 'SIGTERM ignored, sending SIGKILL');
          proc.kill('SIGKILL');
        }
      }, 5000);
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    proc.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `agent-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Agent Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Process: ${processName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, processName, duration, code },
            'Process timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({ status: 'success', result: null, newSessionId });
          });
          return;
        }

        logger.error(
          { group: group.name, processName, duration, code },
          'Process timed out with no output',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Process timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `agent-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Agent Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        if (isVerbose) {
          logLines.push(`=== Input ===`, JSON.stringify(input, null, 2), ``);
        } else {
          logLines.push(
            `=== Input Summary ===`,
            `Prompt length: ${input.prompt.length} chars`,
            `Session ID: ${input.sessionId || 'new'}`,
            ``,
          );
        }
        logLines.push(
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Agent log written');

      if (code !== 0) {
        logger.error(
          { group: group.name, code, duration, stderr, stdout, logFile },
          'Agent process exited with error',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Process exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Agent completed (streaming mode)',
          );
          resolve({ status: 'success', result: null, newSessionId });
        });
        return;
      }

      try {
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);
        logger.info(
          { group: group.name, duration, status: output.status, hasResult: !!output.result },
          'Agent completed',
        );
        resolve(output);
      } catch (err) {
        logger.error(
          { group: group.name, stdout, stderr, error: err },
          'Failed to parse agent output',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, processName, error: err },
        'Agent spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    script?: string | null;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  _registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      { groups: visibleGroups, lastSync: new Date().toISOString() },
      null,
      2,
    ),
  );
}

export function ensureAgentRunnerBuilt(): void {
  if (!fs.existsSync(AGENT_RUNNER_PATH)) {
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Agent runner not built                                 ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Run: cd container/agent-runner && npm run build               ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error(`Agent runner not found at ${AGENT_RUNNER_PATH}`);
  }
}
```

- [ ] **Step 2: Verify it compiles**

```bash
npm run build
```

Expected: Errors from other files that still import `container-runner` — that's fine, we fix those next.

- [ ] **Step 3: Commit**

```bash
git add src/host-runner.ts
git commit -m "feat: add host-runner.ts replacing Docker container runner

Spawns agent-runner as a direct Node.js child process with env-based
path mapping. Preserves same function signatures (runHostAgent,
writeTasksSnapshot, writeGroupsSnapshot) for drop-in replacement."
```

---

### Task 5: Update index.ts to use host-runner

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Replace container-runner and container-runtime imports**

```typescript
// BEFORE (lines 26-31):
import {
  ContainerOutput,
  resolveIdleMs,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';

// AFTER:
import {
  ContainerOutput,
  ensureAgentRunnerBuilt,
  resolveIdleMs,
  runHostAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './host-runner.js';
```

- [ ] **Step 2: Replace ensureContainerSystemRunning**

```typescript
// BEFORE (lines 649-652):
function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

// AFTER:
function ensureSystemRunning(): void {
  ensureAgentRunnerBuilt();
}
```

Update the call in `main()`:
```typescript
// BEFORE:
ensureContainerSystemRunning();

// AFTER:
ensureSystemRunning();
```

- [ ] **Step 3: Replace runContainerAgent → runHostAgent**

In the `runAgent` function (~line 457):
```typescript
// BEFORE:
const output = await runContainerAgent(

// AFTER:
const output = await runHostAgent(
```

- [ ] **Step 4: Verify build**

```bash
npm run build
```

Expected: May still error on `knowledge-promoter.ts` and `task-scheduler.ts` — fixed in next tasks.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "refactor: switch index.ts from container-runner to host-runner"
```

---

### Task 6: Update knowledge-promoter.ts

**Files:**
- Modify: `src/knowledge-promoter.ts`

- [ ] **Step 1: Replace import and simplify spawnDistiller**

```typescript
// BEFORE (line 6):
import { runContainerAgent } from './container-runner.js';

// AFTER:
import { runHostAgent } from './host-runner.js';
```

Replace the entire `spawnDistiller` function body:
```typescript
export async function spawnDistiller(
  group: RegisteredGroup,
  chatJid: string,
): Promise<void> {
  const groupDir = resolveGroupFolderPath(group.folder);
  const globalWikiDir = path.join(GROUPS_DIR, 'global', 'wiki');

  logger.info({ group: group.folder }, 'Spawning knowledge distiller');

  clearPromotionFlag(path.join(groupDir, 'memory'));

  try {
    await runHostAgent(
      {
        ...group,
        containerConfig: {
          ...group.containerConfig,
        },
      },
      {
        prompt:
          `Run the /knowledge-distiller skill now. Write wiki pages to ${globalWikiDir} (read-write). The shared wiki at ${globalWikiDir} contains existing wiki content.`,
        groupFolder: group.folder,
        chatJid,
        isMain: group.isMain === true,
        isScheduledTask: true,
        assistantName: 'Distiller',
      },
      () => {},
    );
    logger.info({ group: group.folder }, 'Knowledge distiller completed');
  } catch (err) {
    logger.error(
      {
        group: group.folder,
        err: err instanceof Error ? err.message : String(err),
      },
      'Knowledge distiller failed',
    );
  }
}
```

Key changes:
- No `additionalMounts` (no mounts on host)
- Prompt uses actual `globalWikiDir` path instead of `/workspace/extra/shared-wiki-rw/`

- [ ] **Step 2: Commit**

```bash
git add src/knowledge-promoter.ts
git commit -m "refactor: switch knowledge-promoter to host-runner, remove mount manipulation"
```

---

### Task 7: Update task-scheduler.ts

**Files:**
- Modify: `src/task-scheduler.ts`

- [ ] **Step 1: Replace import**

```typescript
// BEFORE (lines 13-17):
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';

// AFTER:
import {
  ContainerOutput,
  runHostAgent,
  writeTasksSnapshot,
} from './host-runner.js';
```

- [ ] **Step 2: Replace runContainerAgent call**

In `runTask()` (~line 180):
```typescript
// BEFORE:
const output = await runContainerAgent(

// AFTER:
const output = await runHostAgent(
```

- [ ] **Step 3: Commit**

```bash
git add src/task-scheduler.ts
git commit -m "refactor: switch task-scheduler to host-runner"
```

---

### Task 8: Update ipc.ts type import

**Files:**
- Modify: `src/ipc.ts`

- [ ] **Step 1: Replace import**

```typescript
// BEFORE (line 7):
import { AvailableGroup } from './container-runner.js';

// AFTER:
import { AvailableGroup } from './host-runner.js';
```

- [ ] **Step 2: Commit**

```bash
git add src/ipc.ts
git commit -m "refactor: switch ipc.ts AvailableGroup import to host-runner"
```

---

### Task 9: Delete container-specific files

**Files:**
- Delete: `src/container-runner.ts`
- Delete: `src/container-runner.test.ts`
- Delete: `src/container-runtime.ts`
- Delete: `src/container-runtime.test.ts`
- Delete: `src/mount-security.ts`
- Delete: `src/mount-security.test.ts` (if exists)

- [ ] **Step 1: Verify no remaining imports**

```bash
grep -rn "container-runner\|container-runtime\|mount-security" src/ --include='*.ts' | grep -v '.test.ts' | grep -v 'node_modules'
```

Expected: No results (all imports already switched).

- [ ] **Step 2: Delete files**

```bash
git rm src/container-runner.ts src/container-runner.test.ts src/container-runtime.ts src/container-runtime.test.ts src/mount-security.ts
```

- [ ] **Step 3: Build and run tests**

```bash
npm run build && npm test
```

Expected: Build succeeds. Some tests may fail due to mocks referencing deleted modules — those test files were already deleted. Remaining tests should pass.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore: remove Docker container-runner, container-runtime, mount-security

These modules are superseded by host-runner.ts which spawns agent
processes directly on the host."
```

---

### Task 10: Write host-runner tests

**Files:**
- Create: `src/host-runner.test.ts`

- [ ] **Step 1: Write tests for buildProcessEnv and helpers**

```typescript
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

vi.mock('./config.js', () => ({
  AGENT_RUNNER_PATH: '/tmp/mock-agent-runner.js',
  PROCESS_MAX_OUTPUT_SIZE: 10485760,
  PROCESS_TIMEOUT: 1800000,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000,
  TIMEZONE: 'America/Los_Angeles',
  GH_TOKEN: undefined,
  CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth-token',
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      cpSync: vi.fn(),
    },
  };
});

vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: (folder: string) =>
    `/tmp/nanoclaw-test-groups/${folder}`,
  resolveGroupIpcPath: (folder: string) =>
    `/tmp/nanoclaw-test-data/ipc/${folder}`,
}));

const mockSpawn = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  ChildProcess: class {},
}));

import { runHostAgent, ContainerOutput } from './host-runner.js';
import type { ContainerInput } from './host-runner.js';
import type { RegisteredGroup } from './types.js';

function createMockProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.killed = false;
  proc.kill = vi.fn();
  return proc;
}

describe('runHostAgent', () => {
  let mockProc: ReturnType<typeof createMockProcess>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const group: RegisteredGroup = {
    name: 'Test Group',
    folder: 'test_group',
    trigger: '@Andy',
    isMain: false,
  };

  const input: ContainerInput = {
    prompt: 'Hello',
    groupFolder: 'test_group',
    chatJid: 'test-jid',
    isMain: false,
  };

  it('spawns node with agent runner path', async () => {
    const promise = runHostAgent(group, input, () => {});

    const output: ContainerOutput = {
      status: 'success',
      result: 'Hello back',
      newSessionId: 'sess-123',
    };
    mockProc.stdout.push(
      `${OUTPUT_START_MARKER}\n${JSON.stringify(output)}\n${OUTPUT_END_MARKER}\n`,
    );
    mockProc.stdout.push(null);
    mockProc.stderr.push(null);
    mockProc.emit('close', 0);

    const result = await promise;
    expect(result.status).toBe('success');
    expect(result.result).toBe('Hello back');
    expect(mockSpawn).toHaveBeenCalledWith(
      'node',
      ['/tmp/mock-agent-runner.js'],
      expect.objectContaining({
        cwd: '/tmp/nanoclaw-test-groups/test_group',
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
  });

  it('returns error on non-zero exit code', async () => {
    const promise = runHostAgent(group, input, () => {});

    mockProc.stderr.push('Some error happened');
    mockProc.stdout.push(null);
    mockProc.stderr.push(null);
    mockProc.emit('close', 1);

    const result = await promise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('Process exited with code 1');
  });

  it('calls onOutput for streamed results', async () => {
    const outputs: ContainerOutput[] = [];
    const promise = runHostAgent(group, input, () => {}, async (o) => {
      outputs.push(o);
    });

    const output: ContainerOutput = {
      status: 'success',
      result: 'Streamed result',
      newSessionId: 'sess-456',
    };
    mockProc.stdout.push(
      `${OUTPUT_START_MARKER}\n${JSON.stringify(output)}\n${OUTPUT_END_MARKER}\n`,
    );
    mockProc.stdout.push(null);
    mockProc.stderr.push(null);
    mockProc.emit('close', 0);

    await promise;
    expect(outputs).toHaveLength(1);
    expect(outputs[0].result).toBe('Streamed result');
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npm test -- src/host-runner.test.ts
```

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/host-runner.test.ts
git commit -m "test: add host-runner unit tests"
```

---

### Task 11: Full build and test verification

- [ ] **Step 1: Build everything**

```bash
npm run build && cd container/agent-runner && npm run build && cd ../..
```

- [ ] **Step 2: Run all tests**

```bash
npm test
```

Expected: All tests pass. Any test failures should be from tests that reference deleted modules — identify and fix.

- [ ] **Step 3: Run lint**

```bash
npm run lint
```

- [ ] **Step 4: Commit any remaining fixes**

```bash
git add -A && git commit -m "fix: resolve remaining build/test issues from host-runner migration"
```

---

### Task 12: Manual smoke test

- [ ] **Step 1: Start nanoclaw**

```bash
npm run dev
```

Expected: Starts without errors, logs `NanoClaw running` instead of Docker-related startup messages.

- [ ] **Step 2: Send a test message via Feishu**

Send a message in the feishu_main group. Verify:
- Agent responds (not a Docker error)
- Response appears in Feishu
- Logs show `Spawning host agent` instead of `Spawning container agent`

- [ ] **Step 3: Verify MCP tools work**

In the same conversation, ask the agent to use `send_message` or `list_tasks`. Verify IPC still works.

- [ ] **Step 4: Verify session continuity**

Send a follow-up message. Verify the agent resumes the same session (check logs for session ID reuse).

---

