/**
 * Tests for task-scheduler safety guards:
 * - assertSafeScript() — pre-spawn check for task.script bypassing PreToolUse hook (Codex C2)
 * Spec: docs/specs/2026-05-24-task-workdir-safety-guard.md §5.5c
 */
import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';

import { assertSafeScript } from './task-scheduler.js';

describe('assertSafeScript', () => {
  it('throws when script contains cd into <HOME>/Desktop/vibe-coding/', () => {
    const home = os.homedir();
    const malicious = `cd ${path.join(home, 'Desktop/vibe-coding/nine')}\ngit stash\n`;
    expect(() => assertSafeScript(malicious)).toThrowError(/script.*禁止|forbidden|主开发目录/i);
  });

  it('throws when script contains git -C forbidden path', () => {
    const malicious = `git -C ${path.join(os.homedir(), 'Desktop/vibe-coding/nine')} status`;
    expect(() => assertSafeScript(malicious)).toThrowError(/script.*禁止|forbidden|主开发目录/i);
  });

  it('throws when script contains /workspace/extra/vibe-coding/...', () => {
    expect(() =>
      assertSafeScript('cd /workspace/extra/vibe-coding/nine && ls'),
    ).toThrowError(/script.*禁止|forbidden|主开发目录|workspace/i);
  });

  it('throws when script contains $HOME literal forbidden path (Codex M3)', () => {
    expect(() =>
      assertSafeScript('cd "$HOME/Desktop/vibe-coding/nine"\necho hi'),
    ).toThrowError(/script.*禁止|forbidden|主开发目录/i);
  });

  it('throws when script uses find + forbidden path (Codex R6 M1)', () => {
    const home = os.homedir();
    const malicious = `find ${path.join(home, 'Desktop/vibe-coding/nine')} -name '*.yaml'`;
    expect(() => assertSafeScript(malicious)).toThrowError(
      /script.*禁止|forbidden|主开发目录/i,
    );
  });

  it('allows undefined script (backward compat)', () => {
    expect(() => assertSafeScript(undefined)).not.toThrow();
    expect(() => assertSafeScript(null)).not.toThrow();
    expect(() => assertSafeScript('')).not.toThrow();
  });

  it('allows legitimate script with cd to ~/nine-nanoclaw', () => {
    expect(() =>
      assertSafeScript('cd ~/nine-nanoclaw && python3 scripts/daily_routine.py'),
    ).not.toThrow();
  });

  it('allows echo with literal forbidden path string', () => {
    expect(() =>
      assertSafeScript('echo "禁止 /Users/admin/Desktop/vibe-coding/"'),
    ).not.toThrow();
  });
});
