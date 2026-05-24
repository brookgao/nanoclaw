/**
 * Tests for safety guards in src/host-runner.ts:
 * - assertSafeWorkdir() — FORBIDDEN_PREFIXES check before spawn
 * - ensureGroupClaudeSettings() — write settings.json to SDK-read location + inject PreToolUse hook
 * Spec: docs/specs/2026-05-24-task-workdir-safety-guard.md §5.3, §5.5
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { assertSafeWorkdir, ensureGroupClaudeSettings } from './host-runner.js';
import type { RegisteredGroup } from './types.js';

describe('assertSafeWorkdir', () => {
  it('throws on /Users/<home>/Desktop/vibe-coding/...', () => {
    expect(() =>
      assertSafeWorkdir(path.join(os.homedir(), 'Desktop/vibe-coding/nine')),
    ).toThrowError(/用户主开发目录|Desktop\/vibe-coding/);
  });

  it('throws on tilde form ~/Desktop/vibe-coding/...', () => {
    expect(() => assertSafeWorkdir('~/Desktop/vibe-coding/nine')).toThrowError(
      /用户主开发目录|Desktop\/vibe-coding/,
    );
  });

  it('throws on container path /workspace/extra/vibe-coding/...', () => {
    expect(() =>
      assertSafeWorkdir('/workspace/extra/vibe-coding/nine'),
    ).toThrowError(/workspace\/extra\/vibe-coding|主开发目录/);
  });

  it('allows undefined (backward compat: old tasks without workdir field)', () => {
    expect(() => assertSafeWorkdir(undefined)).not.toThrow();
  });

  it('allows legitimate worktree path ~/nine-nanoclaw', () => {
    expect(() => assertSafeWorkdir('~/nine-nanoclaw')).not.toThrow();
  });

  it('allows legitimate absolute path under home but not in vibe-coding/', () => {
    expect(() =>
      assertSafeWorkdir(path.join(os.homedir(), 'nanoclaw-worktrees/nine')),
    ).not.toThrow();
  });

  // Codex Phase 6 M4: precise root + ${HOME} literal coverage
  it('throws on precise root path (no trailing sub-path) ~/Desktop/vibe-coding', () => {
    expect(() => assertSafeWorkdir('~/Desktop/vibe-coding')).toThrowError(
      /用户主开发目录|Desktop\/vibe-coding/,
    );
  });

  it('throws on ${HOME} literal expansion form', () => {
    expect(() =>
      assertSafeWorkdir('${HOME}/Desktop/vibe-coding/nine'),
    ).toThrowError(/用户主开发目录|Desktop\/vibe-coding/);
  });

  it('allows sibling path with same prefix but different segment (vibe-coding-other)', () => {
    // Codex Phase 6 over-block concern: assertSafeWorkdir 边界要正确（用 sep 不是 startsWith bare）
    expect(() =>
      assertSafeWorkdir(path.join(os.homedir(), 'Desktop/vibe-coding-other')),
    ).not.toThrow();
  });
});

// 整套 fs 行为测试（真实读写到 tmpdir，不 mock）
describe('ensureGroupClaudeSettings — writes to SDK-read location (Codex C1)', () => {
  let tmpRoot: string;
  let origGroupsDir: string | undefined;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-test-'));
    // 假设 ensureGroupClaudeSettings 用 resolveGroupFolderPath → GROUPS_DIR
    // 测试通过设置 NANOCLAW_TEST_GROUPS_DIR 让实现读这个 (Phase 5 实现会支持)
    origGroupsDir = process.env.NANOCLAW_GROUPS_DIR;
    process.env.NANOCLAW_GROUPS_DIR = path.join(tmpRoot, 'groups');
  });

  afterEach(() => {
    if (origGroupsDir === undefined) {
      delete process.env.NANOCLAW_GROUPS_DIR;
    } else {
      process.env.NANOCLAW_GROUPS_DIR = origGroupsDir;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('writes settings.json under groups/<folder>/.claude/ not data/sessions/', () => {
    const group: RegisteredGroup = {
      name: 'Test',
      folder: 'test_group',
      trigger: '',
      added_at: new Date().toISOString(),
    };
    ensureGroupClaudeSettings(group);

    // 期望真位置（SDK 读的 cwd 下 .claude/）
    const groupsBase = process.env.NANOCLAW_GROUPS_DIR!;
    const correctPath = path.join(
      groupsBase,
      'test_group',
      '.claude',
      'settings.json',
    );
    expect(fs.existsSync(correctPath)).toBe(true);
  });

  it('settings.json contains PreToolUse hook for Bash matcher', () => {
    const group: RegisteredGroup = {
      name: 'Test',
      folder: 'test_group',
      trigger: '',
      added_at: new Date().toISOString(),
    };
    ensureGroupClaudeSettings(group);

    const groupsBase = process.env.NANOCLAW_GROUPS_DIR!;
    const settingsPath = path.join(
      groupsBase,
      'test_group',
      '.claude',
      'settings.json',
    );
    const content = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(content.hooks).toBeDefined();
    expect(content.hooks.PreToolUse).toBeInstanceOf(Array);
    expect(content.hooks.PreToolUse.length).toBeGreaterThanOrEqual(1);
    const entry = content.hooks.PreToolUse[0];
    expect(entry.matcher).toBe('Bash');
    const hookCmd = entry.hooks?.[0]?.command ?? '';
    expect(hookCmd).toContain('nanoclaw-host-guard.sh');
  });

  it('is idempotent — calling twice does not duplicate hook', () => {
    const group: RegisteredGroup = {
      name: 'Test',
      folder: 'test_group',
      trigger: '',
      added_at: new Date().toISOString(),
    };
    ensureGroupClaudeSettings(group);
    ensureGroupClaudeSettings(group);

    const settingsPath = path.join(
      process.env.NANOCLAW_GROUPS_DIR!,
      'test_group',
      '.claude',
      'settings.json',
    );
    const content = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const nanoclawHooks = (content.hooks?.PreToolUse ?? []).filter(
      (entry: { hooks?: { command?: string }[] }) =>
        entry.hooks?.some((h) =>
          h.command?.includes('nanoclaw-host-guard.sh'),
        ),
    );
    expect(nanoclawHooks.length).toBe(1);
  });

  it('case B: preserves existing user hooks when merging in', () => {
    const group: RegisteredGroup = {
      name: 'Test',
      folder: 'test_group',
      trigger: '',
      added_at: new Date().toISOString(),
    };
    const settingsPath = path.join(
      process.env.NANOCLAW_GROUPS_DIR!,
      'test_group',
      '.claude',
      'settings.json',
    );
    // 模拟用户已有 settings.json + 已有别的 PreToolUse hook
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        env: { CUSTOM_VAR: '1' },
        hooks: {
          PreToolUse: [
            {
              matcher: 'Edit',
              hooks: [{ type: 'command', command: 'echo user-hook' }],
            },
          ],
        },
      }),
    );
    ensureGroupClaudeSettings(group);

    const content = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    // 用户已有 hook 还在
    expect(
      content.hooks.PreToolUse.some(
        (e: { matcher?: string }) => e.matcher === 'Edit',
      ),
    ).toBe(true);
    // nanoclaw hook 加进去
    expect(
      content.hooks.PreToolUse.some((e: { hooks?: { command?: string }[] }) =>
        e.hooks?.some((h) => h.command?.includes('nanoclaw-host-guard.sh')),
      ),
    ).toBe(true);
    // env 字段也保留
    expect(content.env.CUSTOM_VAR).toBe('1');
  });
});
