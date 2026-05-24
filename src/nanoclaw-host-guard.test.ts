/**
 * Tests for container/hooks/nanoclaw-host-guard.sh PreToolUse hook.
 * Spec: docs/specs/2026-05-24-task-workdir-safety-guard.md §5.4 + §7.2
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import path from 'path';

const HOOK = path.resolve(
  __dirname,
  '..',
  'container',
  'hooks',
  'nanoclaw-host-guard.sh',
);

const TEST_HOME = '/Users/testuser';

// 显式传 env 避免测试间脏污（critic R2 M2）
function runHook(
  input: object,
  opts: { home?: string } = {},
): { stdout: string; status: number } {
  const childEnv = { ...process.env, HOME: opts.home ?? process.env.HOME };
  const r = spawnSync('bash', [HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    env: childEnv,
  });
  return { stdout: r.stdout, status: r.status ?? 0 };
}

describe('nanoclaw-host-guard hook — deny cases', () => {
  it('denies cd into <HOME>/Desktop/vibe-coding/', () => {
    const { stdout } = runHook(
      {
        tool_name: 'Bash',
        tool_input: { command: 'cd /Users/testuser/Desktop/vibe-coding/nine && ls' },
      },
      { home: TEST_HOME },
    );
    expect(stdout).toContain('"permissionDecision": "deny"');
  });

  it('denies git -C into forbidden dir', () => {
    const { stdout } = runHook(
      {
        tool_name: 'Bash',
        tool_input: { command: 'git -C /Users/testuser/Desktop/vibe-coding/nine status' },
      },
      { home: TEST_HOME },
    );
    expect(stdout).toContain('"permissionDecision": "deny"');
  });

  it('denies cd ~/Desktop/vibe-coding/ literal tilde form', () => {
    const { stdout } = runHook(
      { tool_name: 'Bash', tool_input: { command: 'cd ~/Desktop/vibe-coding/nine' } },
      { home: TEST_HOME },
    );
    expect(stdout).toContain('"permissionDecision": "deny"');
  });

  it('denies /workspace/extra/vibe-coding/ container path', () => {
    const { stdout } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'cd /workspace/extra/vibe-coding/nine' },
    });
    expect(stdout).toContain('"permissionDecision": "deny"');
  });

  it('denies --git-dir= form', () => {
    const { stdout } = runHook(
      {
        tool_name: 'Bash',
        tool_input: {
          command:
            'git --git-dir=/Users/testuser/Desktop/vibe-coding/nine/.git log',
        },
      },
      { home: TEST_HOME },
    );
    expect(stdout).toContain('"permissionDecision": "deny"');
  });

  it('denies GIT_DIR= env var form', () => {
    const { stdout } = runHook(
      {
        tool_name: 'Bash',
        tool_input: {
          command:
            'GIT_DIR=/Users/testuser/Desktop/vibe-coding/nine/.git git log',
        },
      },
      { home: TEST_HOME },
    );
    expect(stdout).toContain('"permissionDecision": "deny"');
  });

  it('denies single-quoted forbidden path (critic R3 M1)', () => {
    const { stdout } = runHook(
      {
        tool_name: 'Bash',
        tool_input: { command: "cd '/Users/testuser/Desktop/vibe-coding/nine'" },
      },
      { home: TEST_HOME },
    );
    expect(stdout).toContain('"permissionDecision": "deny"');
  });

  it('denies $HOME literal form (Codex R5 M3)', () => {
    const { stdout } = runHook(
      {
        tool_name: 'Bash',
        tool_input: { command: 'cd "$HOME/Desktop/vibe-coding/nine"' },
      },
      { home: TEST_HOME },
    );
    expect(stdout).toContain('"permissionDecision": "deny"');
  });
});

describe('nanoclaw-host-guard hook — allow cases', () => {
  it('allows cat of spec doc containing literal forbidden path', () => {
    const { stdout, status } = runHook(
      {
        tool_name: 'Bash',
        tool_input: {
          command: 'cat docs/specs/2026-05-24-task-workdir-safety-guard.md',
        },
      },
      { home: TEST_HOME },
    );
    expect(stdout).toBe('');
    expect(status).toBe(0);
  });

  it('allows echo with literal forbidden string', () => {
    const { stdout, status } = runHook(
      {
        tool_name: 'Bash',
        tool_input: {
          command: 'echo "禁止 /Users/admin/Desktop/vibe-coding/"',
        },
      },
      { home: TEST_HOME },
    );
    expect(stdout).toBe('');
    expect(status).toBe(0);
  });

  it('allows cd to ~/nanoclaw-worktrees/ legitimate workdir', () => {
    const { stdout, status } = runHook(
      {
        tool_name: 'Bash',
        tool_input: { command: 'cd ~/nanoclaw-worktrees/nine && git status' },
      },
      { home: TEST_HOME },
    );
    expect(stdout).toBe('');
    expect(status).toBe(0);
  });

  it('skips non-Bash tools', () => {
    const { stdout, status } = runHook({
      tool_name: 'Edit',
      tool_input: { file_path: '/Users/admin/Desktop/vibe-coding/nine/foo.ts' },
    });
    expect(stdout).toBe('');
    expect(status).toBe(0);
  });
});

describe('nanoclaw-host-guard hook — fail-closed', () => {
  it('fail-closed on empty tool_name (malformed input)', () => {
    const { stdout } = runHook({} as object);
    expect(stdout).toContain('"permissionDecision": "deny"');
    expect(stdout).toContain('fail-closed');
  });
});
