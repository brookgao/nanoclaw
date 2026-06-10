import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  checkApprovalKeywords,
  writeApproval,
  hasFreshApproval,
  findFreshApproval,
  consumeApproval,
  gcExpiredApprovals,
} from './approval-bridge.js';

const tmpRoot = path.join(os.tmpdir(), 'approval-bridge-test');
let tmpDir: string;

function freshDir(): string {
  const d = path.join(
    tmpRoot,
    `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  fs.mkdirSync(d, { recursive: true });
  return d;
}

describe('checkApprovalKeywords', () => {
  it.each([
    ['按 plan 改', true],
    ['按plan做', true],
    ['按plan实施', true],
    ['按 plan 来', true],
    ['这个 plan 行', true],
    ['这plan可以', true],
    ['plan approved', true],
    ['plan approve', true],
    ['plan 批准', true],
    ['plan 通过', true],
    ['go ahead', true],
    ['Go Ahead', true],
    ['goahead', true],
    ['实施吧', true],
    ['开始动手', true],
    ['开始写代码', true],
    ['开始做', true],
  ])('matches: %s → %s', (text, expected) => {
    expect(checkApprovalKeywords(text).matched).toBe(expected);
  });

  it.each([
    ['OK', false],
    ['好的', false],
    ['嗯', false],
    ['收到', false],
    ['改吧', false], // 进方案挡 ≠ 批准 plan
    ['动手', false],
    ['你来做', false],
    ['不行', false],
    ['不批准', false],
    ['我之前说过按 plan 改了', false], // 非开头不算
    ['你帮我改', false],
    // 反向 retrospective (reviewer I4) — `完` 是 retrospective 强标志
    ['按 plan 改完了', false],
    ['按 plan 实施完了', false],
    ['开始写完了', false],
    ['实施吧完成了', false], // 不太合语法但作为 safety
  ])('rejects: %s → %s', (text, expected) => {
    expect(checkApprovalKeywords(text).matched).toBe(expected);
  });
});

describe('writeApproval', () => {
  beforeEach(() => {
    tmpDir = freshDir();
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates .approvals/<id>.json with correct schema', () => {
    const filename = writeApproval(tmpDir, {
      kind: 'plan',
      matchedText: '按 plan 改',
      matchedMessageId: 'om_1',
      matchedSender: 'ou_a',
    });
    const data = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.approvals', filename), 'utf-8'),
    );
    expect(data.kind).toBe('plan');
    expect(data.matched_text).toBe('按 plan 改');
    expect(data.matched_message_id).toBe('om_1');
    expect(data.matched_sender).toBe('ou_a');
    expect(data.approved_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(data.ttl_until).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // TTL should be ~30min after approved_at
    const delta =
      new Date(data.ttl_until).getTime() - new Date(data.approved_at).getTime();
    expect(delta).toBe(30 * 60 * 1000);
  });

  it('atomic write: no .tmp left behind', () => {
    writeApproval(tmpDir, {
      kind: 'plan',
      matchedText: 'x',
      matchedMessageId: 'm',
      matchedSender: 's',
    });
    const files = fs.readdirSync(path.join(tmpDir, '.approvals'));
    expect(files.every((f) => !f.endsWith('.tmp'))).toBe(true);
  });
});

describe('findFreshApproval / hasFreshApproval', () => {
  beforeEach(() => {
    tmpDir = freshDir();
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns path within TTL', () => {
    writeApproval(tmpDir, {
      kind: 'plan',
      matchedText: '按 plan 改',
      matchedMessageId: 'om_1',
      matchedSender: 'ou_a',
    });
    const p = findFreshApproval(tmpDir);
    expect(p).not.toBeNull();
    expect(hasFreshApproval(tmpDir)).toBe(true);
  });

  it('returns null when expired', () => {
    const dir = path.join(tmpDir, '.approvals');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'old.json'),
      JSON.stringify({
        kind: 'plan',
        approved_at: '2020-01-01T00:00:00.000Z',
        ttl_until: '2020-01-01T00:30:00.000Z',
      }),
    );
    expect(findFreshApproval(tmpDir)).toBeNull();
    expect(hasFreshApproval(tmpDir)).toBe(false);
  });

  it('returns null when dir does not exist', () => {
    expect(hasFreshApproval(tmpDir)).toBe(false);
  });

  it('skips .consumed.json files', () => {
    const dir = path.join(tmpDir, '.approvals');
    fs.mkdirSync(dir, { recursive: true });
    const future = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    fs.writeFileSync(
      path.join(dir, 'used.consumed.json'),
      JSON.stringify({ kind: 'plan', ttl_until: future }),
    );
    // .consumed.json doesn't end in .json-suffix-only — but our filter is
    // .endsWith('.json'). `used.consumed.json` DOES end with `.json`.
    // That's a bug we must guard against. The implementation excludes
    // these by not iterating consumed files explicitly — let's verify.
    expect(findFreshApproval(tmpDir)).toBeNull();
  });
});

describe('consumeApproval', () => {
  beforeEach(() => {
    tmpDir = freshDir();
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('renames .json to .consumed.json (one approval = one PR)', () => {
    writeApproval(tmpDir, {
      kind: 'plan',
      matchedText: 'go ahead',
      matchedMessageId: 'om_1',
      matchedSender: 'ou_a',
    });
    const fresh = findFreshApproval(tmpDir)!;
    expect(fresh).not.toBeNull();
    consumeApproval(fresh);
    expect(fs.existsSync(fresh)).toBe(false);
    expect(fs.existsSync(fresh.replace(/\.json$/, '.consumed.json'))).toBe(
      true,
    );
    // After consumption, next findFreshApproval returns null
    expect(findFreshApproval(tmpDir)).toBeNull();
  });
});

describe('gcExpiredApprovals', () => {
  beforeEach(() => {
    tmpDir = freshDir();
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes expired .json files older than 1h past TTL', () => {
    const dir = path.join(tmpDir, '.approvals');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'ancient.json'),
      JSON.stringify({
        kind: 'plan',
        approved_at: '2020-01-01T00:00:00.000Z',
        ttl_until: '2020-01-01T00:30:00.000Z',
      }),
    );
    const removed = gcExpiredApprovals(tmpDir);
    expect(removed).toBe(1);
    expect(fs.existsSync(path.join(dir, 'ancient.json'))).toBe(false);
  });

  it('keeps fresh files', () => {
    writeApproval(tmpDir, {
      kind: 'plan',
      matchedText: 'x',
      matchedMessageId: 'm',
      matchedSender: 's',
    });
    const before = fs
      .readdirSync(path.join(tmpDir, '.approvals'))
      .filter((f) => f.endsWith('.json')).length;
    gcExpiredApprovals(tmpDir);
    const after = fs
      .readdirSync(path.join(tmpDir, '.approvals'))
      .filter((f) => f.endsWith('.json')).length;
    expect(after).toBe(before);
  });
});
