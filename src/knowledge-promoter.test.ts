import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { hasUnpromotedEntries, shouldPromote } from './knowledge-promoter.js';

describe('hasUnpromotedEntries', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns false when file does not exist', () => {
    expect(hasUnpromotedEntries(path.join(tmp, 'missing.md'))).toBe(false);
  });

  it('returns true when unpromoted entries exist', () => {
    const file = path.join(tmp, 'session-learnings.md');
    fs.writeFileSync(
      file,
      '# Session Learnings\n\n[2026-04-24] Some learning | 来源: test.md\n',
    );
    expect(hasUnpromotedEntries(file)).toBe(true);
  });

  it('returns false when all entries are promoted', () => {
    const file = path.join(tmp, 'session-learnings.md');
    fs.writeFileSync(
      file,
      '# Session Learnings\n\n[promoted] [2026-04-24] Some learning | 来源: test.md\n',
    );
    expect(hasUnpromotedEntries(file)).toBe(false);
  });
});

describe('shouldPromote', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns true when .needs-promotion flag exists', () => {
    fs.writeFileSync(path.join(tmp, '.needs-promotion'), '12');
    expect(shouldPromote(tmp)).toBe(true);
  });

  it('returns false when no flag exists', () => {
    expect(shouldPromote(tmp)).toBe(false);
  });
});
