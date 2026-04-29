import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetForTest, checkDotaDecision } from './dota-bridge.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dota-bridge-test-'));
}

function writePending(
  dir: string,
  decisionId: string,
  createdAt: string,
  extra: Partial<{ sessionId: string; phase: string; question: string; project: string }> = {},
): void {
  const pendingDir = path.join(dir, 'pending');
  fs.mkdirSync(pendingDir, { recursive: true });
  const data = {
    decisionId,
    sessionId: extra.sessionId ?? 'sess-1',
    phase: extra.phase ?? 'plan',
    question: extra.question ?? 'Which approach?',
    createdAt,
    project: extra.project ?? 'test-project',
  };
  fs.writeFileSync(path.join(pendingDir, `${decisionId}.json`), JSON.stringify(data, null, 2));
}

describe('checkDotaDecision', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    _resetForTest();
    vi.useRealTimers();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('returns handled=true when a pending decision exists, writes reply file, deletes pending', () => {
    writePending(tmpDir, 'dota-001', '2024-01-01T10:00:00.000Z');

    const result = checkDotaDecision('go with option A', undefined, tmpDir);

    expect(result.handled).toBe(true);
    expect(result.confirmText).toContain('dota-001');

    // Reply file should exist
    const replyPath = path.join(tmpDir, 'replies', 'dota-001.json');
    expect(fs.existsSync(replyPath)).toBe(true);
    const reply = JSON.parse(fs.readFileSync(replyPath, 'utf-8'));
    expect(reply.decisionId).toBe('dota-001');
    expect(reply.reply).toBe('go with option A');
    expect(reply.replySource).toBe('feishu');

    // Pending file should be deleted
    const pendingPath = path.join(tmpDir, 'pending', 'dota-001.json');
    expect(fs.existsSync(pendingPath)).toBe(false);
  });

  it('returns handled=false when no pending decisions directory exists', () => {
    const result = checkDotaDecision('hello', undefined, tmpDir);
    expect(result.handled).toBe(false);
  });

  it('returns handled=false when pending directory is empty', () => {
    fs.mkdirSync(path.join(tmpDir, 'pending'), { recursive: true });
    const result = checkDotaDecision('hello', undefined, tmpDir);
    expect(result.handled).toBe(false);
  });

  it('FIFO: picks oldest pending by createdAt when no replyToText', () => {
    writePending(tmpDir, 'dota-100', '2024-01-01T12:00:00.000Z');
    writePending(tmpDir, 'dota-099', '2024-01-01T10:00:00.000Z'); // older
    writePending(tmpDir, 'dota-101', '2024-01-01T14:00:00.000Z');

    const result = checkDotaDecision('pick oldest', undefined, tmpDir);

    expect(result.handled).toBe(true);
    expect(result.confirmText).toContain('dota-099');

    const replyPath = path.join(tmpDir, 'replies', 'dota-099.json');
    expect(fs.existsSync(replyPath)).toBe(true);
  });

  it('cooldown: second call within 10s returns handled=true without writing another reply file', () => {
    vi.useFakeTimers();
    const now = new Date('2024-06-01T00:00:00.000Z').getTime();
    vi.setSystemTime(now);

    writePending(tmpDir, 'dota-200', '2024-01-01T10:00:00.000Z');

    // First call — should process
    const first = checkDotaDecision('first reply', undefined, tmpDir);
    expect(first.handled).toBe(true);
    expect(first.confirmText).toContain('dota-200');

    // Advance time by 5s (still within cooldown)
    vi.setSystemTime(now + 5_000);

    writePending(tmpDir, 'dota-201', '2024-01-01T11:00:00.000Z');

    // Second call — within cooldown, should not write reply for dota-201
    const second = checkDotaDecision('second reply', undefined, tmpDir);
    expect(second.handled).toBe(true);
    expect(second.confirmText).toBe('已收到，忽略重复消息');

    // dota-201 reply file should NOT exist
    const replyPath = path.join(tmpDir, 'replies', 'dota-201.json');
    expect(fs.existsSync(replyPath)).toBe(false);
  });

  it('ref matching: replyToText with [ref:dota-xxx] targets that specific decision', () => {
    writePending(tmpDir, 'dota-300', '2024-01-01T10:00:00.000Z'); // older
    writePending(tmpDir, 'dota-301', '2024-01-01T12:00:00.000Z'); // newer, but referenced

    const result = checkDotaDecision(
      'reply for 301',
      'some context [ref:dota-301] more text',
      tmpDir,
    );

    expect(result.handled).toBe(true);
    expect(result.confirmText).toContain('dota-301');

    // dota-301 reply should exist, dota-300 should NOT
    expect(fs.existsSync(path.join(tmpDir, 'replies', 'dota-301.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'replies', 'dota-300.json'))).toBe(false);

    // dota-300 pending should still exist (not touched)
    expect(fs.existsSync(path.join(tmpDir, 'pending', 'dota-300.json'))).toBe(true);
  });
});
