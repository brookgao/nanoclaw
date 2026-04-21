import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { callSync } from './ipc-sync.js';

describe('callSync', () => {
  let tmp: string;
  let origEnv: typeof process.env;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-sync-test-'));
    fs.mkdirSync(path.join(tmp, 'sync_requests'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'sync_responses'), { recursive: true });
    origEnv = { ...process.env };
    process.env.NANOCLAW_IPC_DIR = tmp;
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env = origEnv;
  });

  it('writes request, reads matching response, cleans up both files', async () => {
    const replier = setInterval(() => {
      const files = fs.readdirSync(path.join(tmp, 'sync_requests'));
      for (const f of files) {
        const body = JSON.parse(
          fs.readFileSync(path.join(tmp, 'sync_requests', f), 'utf-8'),
        );
        fs.writeFileSync(
          path.join(tmp, 'sync_responses', f),
          JSON.stringify({ data: { echo: body.action + ':' + body.x } }),
        );
      }
    }, 20);

    try {
      const resp = await callSync<{ x: number }, { echo: string }>(
        'ping',
        { x: 42 },
        2000,
      );
      expect(resp).toEqual({ echo: 'ping:42' });
      expect(fs.readdirSync(path.join(tmp, 'sync_requests'))).toHaveLength(0);
      expect(fs.readdirSync(path.join(tmp, 'sync_responses'))).toHaveLength(0);
    } finally {
      clearInterval(replier);
    }
  });

  it('throws on error response', async () => {
    const replier = setInterval(() => {
      const files = fs.readdirSync(path.join(tmp, 'sync_requests'));
      for (const f of files) {
        fs.writeFileSync(
          path.join(tmp, 'sync_responses', f),
          JSON.stringify({ error: 'something broke' }),
        );
      }
    }, 20);

    try {
      await expect(
        callSync('boom', { x: 1 }, 2000),
      ).rejects.toThrow(/something broke/);
    } finally {
      clearInterval(replier);
    }
  });

  it('throws on timeout', async () => {
    await expect(
      callSync('timeout_case', { x: 1 }, 300),
    ).rejects.toThrow(/timeout/);
  });

  it('concurrent calls use distinct reqid and do not cross-talk', async () => {
    const replier = setInterval(() => {
      const files = fs.readdirSync(path.join(tmp, 'sync_requests'));
      for (const f of files) {
        const body = JSON.parse(
          fs.readFileSync(path.join(tmp, 'sync_requests', f), 'utf-8'),
        );
        fs.writeFileSync(
          path.join(tmp, 'sync_responses', f),
          JSON.stringify({ data: { id: body.id } }),
        );
      }
    }, 20);

    try {
      const [a, b] = await Promise.all([
        callSync<{ id: string }, { id: string }>('x', { id: 'A' }, 2000),
        callSync<{ id: string }, { id: string }>('x', { id: 'B' }, 2000),
      ]);
      expect(a.id).toBe('A');
      expect(b.id).toBe('B');
    } finally {
      clearInterval(replier);
    }
  });
});
