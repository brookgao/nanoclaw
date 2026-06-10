/**
 * Tests for container/hooks/nanoclaw-host-guard.sh PreToolUse hook.
 * Spec: docs/specs/2026-05-24-task-workdir-safety-guard.md §5.4 + §7.2
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

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
  opts: { home?: string; extraEnv?: Record<string, string> } = {},
): { stdout: string; status: number } {
  const childEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: opts.home ?? process.env.HOME ?? '',
    ...(opts.extraEnv || {}),
  };
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
        tool_input: {
          command: 'cd /Users/testuser/Desktop/vibe-coding/nine && ls',
        },
      },
      { home: TEST_HOME },
    );
    expect(stdout).toContain('"permissionDecision": "deny"');
  });

  it('denies git -C into forbidden dir', () => {
    const { stdout } = runHook(
      {
        tool_name: 'Bash',
        tool_input: {
          command: 'git -C /Users/testuser/Desktop/vibe-coding/nine status',
        },
      },
      { home: TEST_HOME },
    );
    expect(stdout).toContain('"permissionDecision": "deny"');
  });

  it('denies cd ~/Desktop/vibe-coding/ literal tilde form', () => {
    const { stdout } = runHook(
      {
        tool_name: 'Bash',
        tool_input: { command: 'cd ~/Desktop/vibe-coding/nine' },
      },
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
        tool_input: {
          command: "cd '/Users/testuser/Desktop/vibe-coding/nine'",
        },
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

describe('nanoclaw-host-guard hook — action bans: push to protected branch', () => {
  const cases = [
    // bare branch as last token
    'git push origin dev',
    'git push origin main',
    'git push origin master',
    // trailing flags (critic C1)
    'git push origin dev --force',
    'git push origin dev -u',
    'git push origin dev --tags',
    'git push --set-upstream origin main',
    // quoted (critic C1 / I6)
    'git push origin "dev"',
    "git push origin 'main'",
    // HEAD:protected
    'git push origin HEAD:dev',
    'git push origin HEAD:main',
    // refs/heads/protected
    'git push origin refs/heads/main',
    // src:dst with protected dst (critic C2)
    'git push origin local-dev:dev',
    'git push origin :dev', // delete remote dev
    'git push origin local:master',
    // git -c <cfg> push prefix bypass (critic C3)
    'git -c http.proxy=x push origin dev',
    'git --no-pager push origin main',
    // extra whitespace
    'git  push   origin   dev',
    // force-update refspec +dev (review C2)
    'git push origin +dev',
    'git push origin +main',
    // --mirror / --all push every local ref (review C1)
    'git push --mirror origin',
    'git push --all origin',
    // case-insensitive bypass attempt (review I1)
    'git push origin DEV',
    'git push origin Main',
    // multi-line — grep is line-oriented, line containing push origin dev still matches
    'git status\ngit push origin dev',
  ];
  for (const cmd of cases) {
    it(`denies: ${cmd}`, () => {
      const { stdout } = runHook(
        { tool_name: 'Bash', tool_input: { command: cmd } },
        { home: TEST_HOME },
      );
      expect(stdout).toContain('"permissionDecision": "deny"');
      expect(stdout).toContain('保护分支');
    });
  }

  const allowCases = [
    'git push origin fix/some-feature',
    'git push -u origin feat/yyy',
    'git push origin dev-fix', // protected name as prefix, not full token
    'git push origin develop',
    'git push origin fix/dev', // protected as path segment
    'echo dev', // protected name in unrelated command
    'touch master.md',
    // command-position anchor: git inside string literal must NOT trigger (review I2)
    'echo "see: git push origin dev"',
    "echo 'usage: git push origin main'",
    'cat README.md # mentions git push origin dev',
  ];
  for (const cmd of allowCases) {
    it(`ALLOWS: ${cmd}`, () => {
      const { stdout } = runHook(
        { tool_name: 'Bash', tool_input: { command: cmd } },
        { home: TEST_HOME },
      );
      expect(stdout).not.toContain('"permissionDecision": "deny"');
    });
  }
});

describe('nanoclaw-host-guard hook — action bans: force push', () => {
  const denyCases = [
    'git push --force origin fix/x',
    'git push --force-with-lease origin fix/x',
    'git push -f origin fix/x',
    'git push -fu origin fix/x', // bundled (critic I4)
    'git push -uf origin fix/x', // bundled, different order
    'git -c x=y push --force origin fix/x', // git-prefix bypass (critic C3)
    'git push --force-with-lease=dev origin fix/x', // ref-scoped lease (review M1)
  ];
  for (const cmd of denyCases) {
    it(`denies: ${cmd}`, () => {
      const { stdout } = runHook(
        { tool_name: 'Bash', tool_input: { command: cmd } },
        { home: TEST_HOME },
      );
      expect(stdout).toContain('"permissionDecision": "deny"');
      expect(stdout).toContain('强制推');
    });
  }

  const allowCases = [
    'git push origin fix/x',
    'git push -u origin fix/x', // -u (set-upstream) not -f
    'touch force.txt', // "force" as filename, not flag
    'git log --pretty=format:%h', // 'f' is in format string, not flag
  ];
  for (const cmd of allowCases) {
    it(`ALLOWS: ${cmd}`, () => {
      const { stdout } = runHook(
        { tool_name: 'Bash', tool_input: { command: cmd } },
        { home: TEST_HOME },
      );
      expect(stdout).not.toContain('"permissionDecision": "deny"');
    });
  }
});

describe('nanoclaw-host-guard hook — action bans: bypass verify/sign', () => {
  const denyCases = [
    'git commit --no-verify -m "foo"',
    'git push --no-verify origin fix/x',
    'git commit --no-gpg-sign -m "foo"',
    'git -c core.hooksPath=/dev/null commit --no-verify -m x', // git-prefix bypass (critic C3)
  ];
  for (const cmd of denyCases) {
    it(`denies: ${cmd}`, () => {
      const { stdout } = runHook(
        { tool_name: 'Bash', tool_input: { command: cmd } },
        { home: TEST_HOME },
      );
      expect(stdout).toContain('"permissionDecision": "deny"');
      expect(stdout).toContain('hook');
    });
  }

  const allowCases = [
    'git commit -m "feat: thing"',
    'git push origin fix/x',
    'echo --no-verify', // string not as a flag in git verb
  ];
  for (const cmd of allowCases) {
    it(`ALLOWS: ${cmd}`, () => {
      const { stdout } = runHook(
        { tool_name: 'Bash', tool_input: { command: cmd } },
        { home: TEST_HOME },
      );
      expect(stdout).not.toContain('"permissionDecision": "deny"');
    });
  }
});

describe('nanoclaw-host-guard hook — D-class: gh pr create approval gate', () => {
  let tmpGroupDir: string;

  beforeEach(() => {
    tmpGroupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-approval-'));
  });
  afterEach(() => {
    fs.rmSync(tmpGroupDir, { recursive: true, force: true });
  });

  function writeFreshApproval(): void {
    const dir = path.join(tmpGroupDir, '.approvals');
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date();
    const ttl = new Date(now.getTime() + 30 * 60 * 1000);
    fs.writeFileSync(
      path.join(dir, 'fresh.json'),
      JSON.stringify({
        kind: 'plan',
        approved_at: now.toISOString(),
        ttl_until: ttl.toISOString(), // ISO with milliseconds — macOS parse test
        matched_text: '按 plan 改',
        matched_message_id: 'om_1',
        matched_sender: 'ou_user',
      }),
    );
  }

  function writeExpiredApproval(): void {
    const dir = path.join(tmpGroupDir, '.approvals');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'old.json'),
      JSON.stringify({
        kind: 'plan',
        approved_at: '2020-01-01T00:00:00.000Z',
        ttl_until: '2020-01-01T00:30:00.000Z',
      }),
    );
  }

  const PR_CREATE_CMDS = [
    'gh pr create --title x --body y',
    'gh pr create',
    'gh api repos/foo/bar/pulls -X POST -f title=x -f head=foo -f base=dev',
    'gh api repos/foo/bar/pulls --method POST -f title=x',
    'gh api /repos/foo/bar/pulls -f title=x',
    'curl -X POST -H "Authorization: token T" https://api.github.com/repos/foo/bar/pulls',
    // Reviewer C2: -X POST BEFORE URL
    'gh api -X POST /repos/x/y/pulls -f title=x',
    'gh api -X POST /repos/x/y/pulls --input payload.json',
    // Reviewer C2: --method POST before URL
    'gh api --method POST repos/x/y/pulls',
    // Reviewer I1: graphql mutation
    "gh api graphql -f query='mutation{createPullRequest(input:{title:\"x\"}){pullRequest{number}}}'",
    // Reviewer recommended #5: curl --data
    'curl --data @body.json https://api.github.com/repos/x/y/pulls',
    // Reviewer recommended #6: curl URL before -X
    'curl https://api.github.com/repos/x/y/pulls -X POST -d \'{"title":"x"}\'',
    // gh api GET /pulls also gated (conservative — user should use `gh pr list`)
    'gh api repos/x/y/pulls',
  ];

  for (const cmd of PR_CREATE_CMDS) {
    it(`denies "${cmd.slice(0, 50)}..." without approval`, () => {
      const { stdout } = runHook(
        { tool_name: 'Bash', tool_input: { command: cmd } },
        { home: TEST_HOME, extraEnv: { NANOCLAW_GROUP_DIR: tmpGroupDir } },
      );
      expect(stdout).toContain('"permissionDecision": "deny"');
      expect(stdout).toContain('approval');
    });
  }

  it('ALLOWS gh pr create with fresh approval (and consumes marker)', () => {
    writeFreshApproval();
    const before = fs
      .readdirSync(path.join(tmpGroupDir, '.approvals'))
      .filter((f) => f.endsWith('.json') && !f.endsWith('.consumed.json'));
    expect(before).toHaveLength(1);

    const { stdout } = runHook(
      { tool_name: 'Bash', tool_input: { command: 'gh pr create --title x' } },
      { home: TEST_HOME, extraEnv: { NANOCLAW_GROUP_DIR: tmpGroupDir } },
    );
    expect(stdout).not.toContain('"permissionDecision": "deny"');

    const after = fs.readdirSync(path.join(tmpGroupDir, '.approvals'));
    expect(after.filter((f) => f.endsWith('.consumed.json'))).toHaveLength(1);
    expect(
      after.filter((f) => f.endsWith('.json') && !f.endsWith('.consumed.json')),
    ).toHaveLength(0);
  });

  it('SECOND gh pr create after consumption → deny (one approval = one PR)', () => {
    writeFreshApproval();
    runHook(
      { tool_name: 'Bash', tool_input: { command: 'gh pr create --title x' } },
      { home: TEST_HOME, extraEnv: { NANOCLAW_GROUP_DIR: tmpGroupDir } },
    );
    const { stdout } = runHook(
      { tool_name: 'Bash', tool_input: { command: 'gh pr create --title x' } },
      { home: TEST_HOME, extraEnv: { NANOCLAW_GROUP_DIR: tmpGroupDir } },
    );
    expect(stdout).toContain('"permissionDecision": "deny"');
  });

  it('denies gh pr create with expired approval', () => {
    writeExpiredApproval();
    const { stdout } = runHook(
      { tool_name: 'Bash', tool_input: { command: 'gh pr create' } },
      { home: TEST_HOME, extraEnv: { NANOCLAW_GROUP_DIR: tmpGroupDir } },
    );
    expect(stdout).toContain('"permissionDecision": "deny"');
  });

  it('denies inline NANOCLAW_GROUP_DIR= override (critic C1)', () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-other-'));
    fs.mkdirSync(path.join(otherDir, '.approvals'));
    fs.writeFileSync(
      path.join(otherDir, '.approvals', 'fresh.json'),
      JSON.stringify({
        kind: 'plan',
        ttl_until: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      }),
    );
    const { stdout } = runHook(
      {
        tool_name: 'Bash',
        tool_input: {
          command: `NANOCLAW_GROUP_DIR=${otherDir} gh pr create --title x`,
        },
      },
      { home: TEST_HOME, extraEnv: { NANOCLAW_GROUP_DIR: tmpGroupDir } },
    );
    expect(stdout).toContain('"permissionDecision": "deny"');
    expect(stdout).toContain('NANOCLAW_GROUP_DIR');
    fs.rmSync(otherDir, { recursive: true, force: true });
  });

  const NON_GATED_CMDS = [
    'gh pr view 5',
    'gh pr list',
    'gh pr merge 5 --merge',
    'gh pr edit 5 --add-reviewer foo',
    'gh issue list',
    'gh repo view',
    'curl https://api.github.com/repos/foo/bar',
    'gh api repos/foo/bar/issues',
  ];
  for (const cmd of NON_GATED_CMDS) {
    it(`ALLOWS non-gated: ${cmd}`, () => {
      const { stdout } = runHook(
        { tool_name: 'Bash', tool_input: { command: cmd } },
        { home: TEST_HOME, extraEnv: { NANOCLAW_GROUP_DIR: tmpGroupDir } },
      );
      expect(stdout).not.toContain('"permissionDecision": "deny"');
    });
  }

  it('macOS date parse round-trip (critic C2)', () => {
    writeFreshApproval();
    const { stdout } = runHook(
      { tool_name: 'Bash', tool_input: { command: 'gh pr create' } },
      { home: TEST_HOME, extraEnv: { NANOCLAW_GROUP_DIR: tmpGroupDir } },
    );
    expect(stdout).not.toContain('"permissionDecision": "deny"');
  });

  it('NANOCLAW_GROUP_DIR unset → deny on gh pr create', () => {
    writeFreshApproval();
    const { stdout } = runHook(
      { tool_name: 'Bash', tool_input: { command: 'gh pr create' } },
      { home: TEST_HOME, extraEnv: { NANOCLAW_GROUP_DIR: '' } },
    );
    expect(stdout).toContain('"permissionDecision": "deny"');
  });
});
