/**
 * Host Runner for NanoClaw
 * Spawns agent-runner as a direct Node.js child process (replaces container-runner.ts)
 */
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

// Sentinel markers for robust output parsing (must match agent-runner)
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

/**
 * Resolve the idle timeout (ms) for a group: per-group override, else global default.
 * Used by both the host-side stdin-close timer (src/index.ts) and the process
 * hard-kill grace period (computeHardTimeoutMs below).
 */
export function resolveIdleMs(group: RegisteredGroup): number {
  return group.containerConfig?.idleTimeout ?? IDLE_TIMEOUT;
}

/**
 * Hard-kill timeout (ms) for a process run. Floors on `idleMs + 30s` so the
 * graceful _close sentinel always has time to trigger before the hard kill.
 */
export function computeHardTimeoutMs(group: RegisteredGroup): number {
  const configTimeout = group.containerConfig?.timeout ?? PROCESS_TIMEOUT;
  return Math.max(configTimeout, resolveIdleMs(group) + 30_000);
}

/**
 * Sync skills from container/skills/ and ~/.claude/skills/ into the group's
 * per-session .claude/skills/ directory. Container skills take precedence
 * over user skills (user skills are not overwritten).
 */
function syncSkills(group: RegisteredGroup): void {
  const claudeDir = path.join(DATA_DIR, 'sessions', group.folder, '.claude');
  const skillsDst = path.join(claudeDir, 'skills');

  // Container skills (take precedence)
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const dir of fs.readdirSync(skillsSrc)) {
      const src = path.join(skillsSrc, dir);
      if (fs.statSync(src).isDirectory()) {
        fs.cpSync(src, path.join(skillsDst, dir), { recursive: true });
      }
    }
  }

  // User's custom skills (don't overwrite container skills)
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

/**
 * Ensure the group's .claude/settings.json exists with the required SDK env vars.
 */
function ensureGroupClaudeSettings(group: RegisteredGroup): void {
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            // Enable agent swarms (subagent orchestration)
            // https://code.claude.com/docs/en/agent-teams#orchestrate-teams-of-claude-code-sessions
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            // Load CLAUDE.md from additional mounted directories
            // https://code.claude.com/docs/en/memory#load-memory-from-additional-directories
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            // Enable Claude's memory feature (persists user preferences between sessions)
            // https://code.claude.com/docs/en/memory#manage-auto-memory
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }
}

/**
 * Write a temporary per-process gitconfig that rewrites GitHub URLs to use
 * the GH_TOKEN for HTTPS auth. Replaces the Docker entrypoint's global git config.
 */
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

/**
 * Rewrite .mcp.json to replace /app/... container paths with host paths.
 * This is needed because the MCP config was written for the Docker container
 * filesystem layout; on host, the paths are different.
 */
function rewriteMcpJson(groupDir: string): void {
  const mcpJsonPath = path.join(groupDir, '.mcp.json');
  if (!fs.existsSync(mcpJsonPath)) return;

  const feishuMcpPath = path.resolve(
    process.cwd(),
    'container',
    'feishu-blocks-mcp',
    'dist',
    'index.js',
  );
  const mem0McpPath = path.resolve(
    process.cwd(),
    'container',
    'mem0-mcp',
    'index.mjs',
  );

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

/**
 * For Feishu groups, refresh the user access token so feishu-blocks MCP
 * can read docs with user permissions (tenant token only reads docs where
 * the bot is explicitly added as collaborator).
 */
async function refreshFeishuToken(
  group: RegisteredGroup,
): Promise<Record<string, string>> {
  if (!group.folder?.startsWith('feishu_')) return {};
  try {
    const refreshScript = path.join(
      process.cwd(),
      'scripts',
      'refresh-feishu-user-token.sh',
    );
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

/**
 * Build the environment object for the child process. Replaces the 150-line
 * buildContainerArgs() from container-runner.ts — env vars instead of docker
 * volume mounts and -e flags.
 */
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
    NANOCLAW_FEISHU_MCP_PATH: path.resolve(
      process.cwd(),
      'container',
      'feishu-blocks-mcp',
      'dist',
      'index.js',
    ),
    NANOCLAW_MEM0_MCP_PATH: path.resolve(
      process.cwd(),
      'container',
      'mem0-mcp',
      'index.mjs',
    ),
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

/**
 * Spawn agent-runner as a direct Node.js child process.
 * Function signature matches runContainerAgent() for drop-in replacement.
 */
export async function runHostAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // Pre-spawn setup: settings, skills, MCP paths
  ensureGroupClaudeSettings(group);
  syncSkills(group);
  rewriteMcpJson(groupDir);

  // Create IPC directories before spawning
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

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
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

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

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
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
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
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
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
    // Keep configTimeout for the user-facing error message.
    // computeHardTimeoutMs may floor higher due to grace period,
    // but the error should reflect the user's intent.
    const configTimeout = group.containerConfig?.timeout ?? PROCESS_TIMEOUT;
    const timeoutMs = computeHardTimeoutMs(group);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, processName },
        'Process timeout, sending SIGTERM',
      );
      proc.kill('SIGTERM');
      // SIGKILL fallback after 5 seconds if SIGTERM is ignored
      setTimeout(() => {
        if (!proc.killed) {
          logger.warn(
            { group: group.name, processName },
            'SIGTERM ignored, sending SIGKILL',
          );
          proc.kill('SIGKILL');
        }
      }, 5000);
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
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

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // process being reaped after the idle period expired.
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
        // On error, log input metadata only — not the full prompt.
        // Full input is only included at verbose level to avoid
        // persisting user conversation content on every non-zero exit.
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

      // Streaming mode: wait for output chain to settle, return completion marker
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

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);
        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
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
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

/**
 * Write available groups snapshot for the agent to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  _registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
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

/**
 * Verify agent-runner is built and available. Called at startup.
 */
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
