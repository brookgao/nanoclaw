import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  MessageStream,
  drainIpcInput,
  _setIpcInputDir,
  getIdleCompactConfig,
  extractContextTokens,
  waitForIpcMessage,
  IdleCompactController,
  isDotaTrigger,
  messageToNotice,
} from './index.js';

describe('isDotaTrigger', () => {
  it('matches explicit DOTA trigger phrases', () => {
    expect(isDotaTrigger('/dota 还价文案不一致')).toBe(true);
    expect(isDotaTrigger('/dota-bugfix 列表页崩了')).toBe(true);
    expect(isDotaTrigger('走 DOTA 把这个需求做了')).toBe(true);
    expect(isDotaTrigger('DOTA 一下')).toBe(true);
    expect(isDotaTrigger('上 superpowers')).toBe(true);
    expect(isDotaTrigger('前面的 dota 流程你继续啊')).toBe(true);
  });

  it('is case-insensitive for dota / superpowers', () => {
    expect(isDotaTrigger('/DOTA foo')).toBe(true);
    expect(isDotaTrigger('上 SuperPowers')).toBe(true);
  });

  it('does not match ordinary messages', () => {
    expect(isDotaTrigger('帮我看下这个 bug')).toBe(false);
    expect(isDotaTrigger('endorota 是什么')).toBe(false);
    expect(isDotaTrigger('')).toBe(false);
  });
});

describe('IdleCompactController.compactNow', () => {
  const cfg = { enabled: true, thresholdTokens: 45000, delayMs: 30000 };

  it('pushes /compact immediately when context is at/over threshold', () => {
    const pushed: string[] = [];
    const c = new IdleCompactController(cfg, () => pushed.push('/compact'));
    c.onContextTokens(60000);
    expect(c.compactNow()).toBe(true);
    expect(pushed).toEqual(['/compact']);
    expect(c.compactInFlight).toBe(true);
  });

  it('skips when context is below threshold', () => {
    const pushed: string[] = [];
    const c = new IdleCompactController(cfg, () => pushed.push('/compact'));
    c.onContextTokens(1000);
    expect(c.compactNow()).toBe(false);
    expect(pushed).toEqual([]);
  });

  it('skips when context is unknown (cold start)', () => {
    const pushed: string[] = [];
    const c = new IdleCompactController(cfg, () => pushed.push('/compact'));
    expect(c.compactNow()).toBe(false);
    expect(pushed).toEqual([]);
  });

  it('skips when a compact is already in flight', () => {
    const pushed: string[] = [];
    const c = new IdleCompactController(cfg, () => pushed.push('/compact'));
    c.onContextTokens(60000);
    c.compactNow();
    expect(c.compactNow()).toBe(false);
    expect(pushed).toEqual(['/compact']);
  });
});

describe('MessageStream multimodal', () => {
  it('yields string content when no images', async () => {
    const ms = new MessageStream();
    ms.push('hello');
    ms.end();
    const out = [];
    for await (const m of ms) out.push(m);
    expect(out).toHaveLength(1);
    expect(out[0].message.content).toBe('hello');
  });

  it('yields ContentBlockParam[] when images present', async () => {
    const ms = new MessageStream();
    ms.push('hello', [
      { mediaType: 'image/jpeg', base64: 'AAAA', sourceKey: 'k1' },
    ]);
    ms.end();
    const out = [];
    for await (const m of ms) out.push(m);
    expect(out[0].message.content).toEqual([
      { type: 'text', text: 'hello' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' },
      },
    ]);
  });

  it('yields ContentBlockParam[] with multiple images in order', async () => {
    const ms = new MessageStream();
    ms.push('look', [
      { mediaType: 'image/jpeg', base64: 'AAAA', sourceKey: 'k1' },
      { mediaType: 'image/jpeg', base64: 'BBBB', sourceKey: 'k2' },
    ]);
    ms.end();
    const out = [];
    for await (const m of ms) out.push(m);
    const content = out[0].message.content as any[];
    expect(content).toHaveLength(3);
    expect(content[0].type).toBe('text');
    expect(content[1].source.data).toBe('AAAA');
    expect(content[2].source.data).toBe('BBBB');
  });
});

describe('drainIpcInput multimodal', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-test-'));
    _setIpcInputDir(tmp);
  });
  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('parses IPC file with images field', () => {
    fs.writeFileSync(
      path.join(tmp, '1.json'),
      JSON.stringify({
        type: 'message',
        text: 'hi',
        images: [{ mediaType: 'image/jpeg', base64: 'AAAA', sourceKey: 'k1' }],
      }),
    );
    const out = drainIpcInput();
    expect(out).toEqual([
      {
        text: 'hi',
        images: [{ mediaType: 'image/jpeg', base64: 'AAAA', sourceKey: 'k1' }],
      },
    ]);
  });

  it('parses IPC file without images field (backward compat)', () => {
    fs.writeFileSync(
      path.join(tmp, '2.json'),
      JSON.stringify({ type: 'message', text: 'hi' }),
    );
    const out = drainIpcInput();
    expect(out).toEqual([{ text: 'hi' }]);
    expect(out[0].images).toBeUndefined();
  });

  it('skips files with invalid JSON', () => {
    fs.writeFileSync(path.join(tmp, 'bad.json'), '{not json');
    fs.writeFileSync(
      path.join(tmp, 'good.json'),
      JSON.stringify({ type: 'message', text: 'ok' }),
    );
    const out = drainIpcInput();
    expect(out).toEqual([{ text: 'ok' }]);
  });
});

describe('getIdleCompactConfig', () => {
  it('defaults threshold to 75% of auto-compact window, delay 30s, enabled', () => {
    const cfg = getIdleCompactConfig({});
    expect(cfg).toEqual({ enabled: true, thresholdTokens: 45000, delayMs: 30000 });
  });

  it('derives threshold from CLAUDE_CODE_AUTO_COMPACT_WINDOW', () => {
    const cfg = getIdleCompactConfig({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000' });
    expect(cfg.thresholdTokens).toBe(75000);
  });

  it('honors explicit threshold override', () => {
    const cfg = getIdleCompactConfig({ NANOCLAW_IDLE_COMPACT_THRESHOLD: '20000' });
    expect(cfg.thresholdTokens).toBe(20000);
    expect(cfg.enabled).toBe(true);
  });

  it('disables when threshold is 0', () => {
    const cfg = getIdleCompactConfig({ NANOCLAW_IDLE_COMPACT_THRESHOLD: '0' });
    expect(cfg.enabled).toBe(false);
  });

  it('falls back to defaults on non-numeric values', () => {
    const cfg = getIdleCompactConfig({
      NANOCLAW_IDLE_COMPACT_THRESHOLD: 'abc',
      NANOCLAW_IDLE_COMPACT_DELAY_MS: '',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: 'nope',
    });
    expect(cfg).toEqual({ enabled: true, thresholdTokens: 45000, delayMs: 30000 });
  });

  it('honors delay override', () => {
    const cfg = getIdleCompactConfig({ NANOCLAW_IDLE_COMPACT_DELAY_MS: '5000' });
    expect(cfg.delayMs).toBe(5000);
  });
});

describe('extractContextTokens', () => {
  it('sums input + cache read/creation + output from a main-thread assistant message', () => {
    const msg = {
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        usage: {
          input_tokens: 3,
          cache_read_input_tokens: 11141,
          cache_creation_input_tokens: 22630,
          output_tokens: 100,
        },
      },
    };
    expect(extractContextTokens(msg)).toBe(33874);
  });

  it('returns null for non-assistant messages', () => {
    expect(extractContextTokens({ type: 'result' })).toBeNull();
  });

  it('returns null for sidechain (subagent) assistant messages', () => {
    const msg = {
      type: 'assistant',
      parent_tool_use_id: 'toolu_123',
      message: { usage: { input_tokens: 5 } },
    };
    expect(extractContextTokens(msg)).toBeNull();
  });

  it('returns null when usage is missing', () => {
    expect(
      extractContextTokens({ type: 'assistant', parent_tool_use_id: null, message: {} }),
    ).toBeNull();
  });

  it('treats missing usage fields as 0', () => {
    const msg = {
      type: 'assistant',
      parent_tool_use_id: null,
      message: { usage: { input_tokens: 7 } },
    };
    expect(extractContextTokens(msg)).toBe(7);
  });
});

describe('waitForIpcMessage', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-wait-test-'));
    _setIpcInputDir(tmp);
  });
  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('resolves with the message when one is pending', async () => {
    fs.writeFileSync(
      path.join(tmp, '1.json'),
      JSON.stringify({ type: 'message', text: 'hello' }),
    );
    const result = await waitForIpcMessage();
    expect(result).toEqual({ kind: 'message', message: { text: 'hello' } });
  });

  it('resolves close when _close sentinel exists', async () => {
    fs.writeFileSync(path.join(tmp, '_close'), '');
    const result = await waitForIpcMessage();
    expect(result).toEqual({ kind: 'close' });
  });

  it('waits until a message arrives later', async () => {
    setTimeout(() => {
      fs.writeFileSync(
        path.join(tmp, '2.json'),
        JSON.stringify({ type: 'message', text: 'late' }),
      );
    }, 800);
    const result = await waitForIpcMessage();
    expect(result).toEqual({ kind: 'message', message: { text: 'late' } });
  });
});

describe('IdleCompactController', () => {
  const cfg = { enabled: true, thresholdTokens: 45000, delayMs: 30000 };
  let pushed: number;
  const pushCompact = () => {
    pushed++;
  };

  beforeEach(() => {
    pushed = 0;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pushes /compact after the idle delay when context is over threshold', () => {
    const c = new IdleCompactController(cfg, pushCompact);
    c.onContextTokens(50000);
    expect(c.onResult()).toBe(false);
    expect(pushed).toBe(0);
    vi.advanceTimersByTime(30000);
    expect(pushed).toBe(1);
    expect(c.compactInFlight).toBe(true);
  });

  it('does nothing when context is below threshold', () => {
    const c = new IdleCompactController(cfg, pushCompact);
    c.onContextTokens(10000);
    c.onResult();
    vi.advanceTimersByTime(60000);
    expect(pushed).toBe(0);
  });

  it('does nothing when disabled', () => {
    const c = new IdleCompactController(
      { ...cfg, enabled: false },
      pushCompact,
    );
    c.onContextTokens(50000);
    c.onResult();
    vi.advanceTimersByTime(60000);
    expect(pushed).toBe(0);
  });

  it('cancels the pending compact when a user message arrives', () => {
    const c = new IdleCompactController(cfg, pushCompact);
    c.onContextTokens(50000);
    c.onResult();
    vi.advanceTimersByTime(15000);
    c.onUserMessage();
    vi.advanceTimersByTime(60000);
    expect(pushed).toBe(0);
  });

  it('marks the next result as the compact turn exactly once', () => {
    const c = new IdleCompactController(cfg, pushCompact);
    c.onContextTokens(50000);
    c.onResult();
    vi.advanceTimersByTime(30000);
    expect(c.compactInFlight).toBe(true);
    c.onCompactBoundary();
    expect(c.onResult()).toBe(true);
    expect(c.compactInFlight).toBe(false);
    // Follow-up turn is a normal result again
    c.onContextTokens(8000);
    expect(c.onResult()).toBe(false);
  });

  it('does not reschedule right after the compact turn completes', () => {
    const c = new IdleCompactController(cfg, pushCompact);
    c.onContextTokens(50000);
    c.onResult();
    vi.advanceTimersByTime(30000);
    expect(pushed).toBe(1);
    c.onResult(); // compact turn result — context still reported high
    vi.advanceTimersByTime(60000);
    expect(pushed).toBe(1);
  });

  it('reschedules (not duplicates) when results arrive back to back', () => {
    const c = new IdleCompactController(cfg, pushCompact);
    c.onContextTokens(50000);
    c.onResult();
    vi.advanceTimersByTime(15000);
    c.onUserMessage(); // user activity cancels
    c.onContextTokens(52000);
    c.onResult(); // new turn done, schedule again
    vi.advanceTimersByTime(30000);
    expect(pushed).toBe(1);
  });

  it('delivers a real result normally when compact is queued but has not run yet', () => {
    // Agent-teams turns emit several results; the turn's real final result
    // can arrive after /compact was pushed but before it executed.
    const c = new IdleCompactController(cfg, pushCompact);
    c.onContextTokens(50000);
    c.onResult();
    vi.advanceTimersByTime(30000);
    expect(c.compactInFlight).toBe(true);
    // Real turn's result arrives — no compact_boundary seen yet
    expect(c.onResult()).toBe(false);
    // Compact actually runs afterwards
    c.onCompactBoundary();
    expect(c.onResult()).toBe(true);
    expect(c.compactInFlight).toBe(false);
  });

  it('never swallows later results when the compact turn yields no result', () => {
    const c = new IdleCompactController(cfg, pushCompact);
    c.onContextTokens(50000);
    c.onResult();
    vi.advanceTimersByTime(30000);
    expect(pushed).toBe(1);
    // SDK never emits boundary nor a result for the pushed /compact
    expect(c.onResult()).toBe(false);
    expect(c.onResult()).toBe(false);
    // And no further compacts are attempted while stuck in flight
    vi.advanceTimersByTime(120000);
    expect(pushed).toBe(1);
  });

  it('a user message while compact is in flight does not clear in-flight state', () => {
    const c = new IdleCompactController(cfg, pushCompact);
    c.onContextTokens(50000);
    c.onResult();
    vi.advanceTimersByTime(30000);
    c.onUserMessage();
    expect(c.compactInFlight).toBe(true);
    c.onCompactBoundary();
    expect(c.onResult()).toBe(true);
  });

  it('dispose cancels the pending timer', () => {
    const c = new IdleCompactController(cfg, pushCompact);
    c.onContextTokens(50000);
    c.onResult();
    c.dispose();
    vi.advanceTimersByTime(60000);
    expect(pushed).toBe(0);
  });
});

describe('messageToNotice', () => {
  it('maps a REJECTED rate_limit_event to a rate_limit notice', () => {
    const n = messageToNotice({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected' },
    });
    expect(n).toEqual({ kind: 'rate_limit', text: '账号限流中，等待重试…' });
  });

  it('ignores allowed / allowed_warning rate_limit_event (normal operation)', () => {
    expect(
      messageToNotice({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }),
    ).toBeNull();
    expect(
      messageToNotice({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed_warning' },
      }),
    ).toBeNull();
  });

  it('maps task_notification (has summary) to a task notice with status', () => {
    const n = messageToNotice({
      type: 'system',
      subtype: 'task_notification',
      status: 'completed',
      summary: 'Adversarially review DOTA plan',
    });
    expect(n).toEqual({
      kind: 'task',
      text: '子任务：Adversarially review DOTA plan',
      subStatus: 'completed',
    });
  });

  it('maps task_started (has description, no summary) to a task notice', () => {
    const n = messageToNotice({
      type: 'system',
      subtype: 'task_started',
      description: '跑 DOTA',
    });
    expect(n).toEqual({ kind: 'task', text: '子任务：跑 DOTA', subStatus: 'started' });
  });

  it('maps task_progress using summary when present, else description', () => {
    expect(
      messageToNotice({ type: 'system', subtype: 'task_progress', description: '读文件' }),
    ).toEqual({ kind: 'task', text: '子任务：读文件', subStatus: 'progress' });
    expect(
      messageToNotice({
        type: 'system',
        subtype: 'task_progress',
        description: '读文件',
        summary: '正在审查方案',
      }),
    ).toEqual({ kind: 'task', text: '子任务：正在审查方案', subStatus: 'progress' });
  });

  it('surfaces terminal failed / stopped task status', () => {
    expect(
      messageToNotice({
        type: 'system', subtype: 'task_notification', status: 'failed', summary: '构建挂了',
      }),
    ).toEqual({ kind: 'task', text: '子任务失败：构建挂了', subStatus: 'failed' });
    expect(
      messageToNotice({
        type: 'system', subtype: 'task_notification', status: 'stopped', summary: '用户中止',
      }),
    ).toEqual({ kind: 'task', text: '子任务已中止：用户中止', subStatus: 'stopped' });
  });

  it('falls back to a bare prefix when task has neither summary nor description', () => {
    expect(
      messageToNotice({ type: 'system', subtype: 'task_progress' }),
    ).toEqual({ kind: 'task', text: '子任务', subStatus: 'progress' });
  });

  it('returns null for ordinary messages', () => {
    expect(messageToNotice({ type: 'assistant' })).toBeNull();
    expect(messageToNotice({ type: 'result' })).toBeNull();
    expect(messageToNotice({ type: 'system', subtype: 'init' })).toBeNull();
  });
});
