import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { RegisteredGroup } from './types.js';

// Tests for the `type: 'file'` branch of the IPC watcher — the path that turns
// an agent's mcp__nanoclaw__send_file tool call into a real attachment in chat.

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ipc-file-'));
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadIpc(dataDir: string) {
  vi.doMock('./config.js', () => ({
    DATA_DIR: dataDir,
    IPC_POLL_INTERVAL: 50,
    TIMEZONE: 'UTC',
  }));
  vi.doMock('./logger.js', () => ({
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  }));
  return import('./ipc.js');
}

function makeGroups(): Record<string, RegisteredGroup> {
  return {
    'feishu_main@feishu': {
      name: 'Feishu Main',
      folder: 'feishu_main',
      trigger: 'always',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    },
    'feishu_recruit@feishu': {
      name: 'Recruit',
      folder: 'feishu_recruit',
      trigger: 'always',
      added_at: '2024-01-01T00:00:00.000Z',
    },
  };
}

function writeFileMessage(
  ipcBaseDir: string,
  sourceGroup: string,
  filename: string,
  payload: object,
) {
  const dir = path.join(ipcBaseDir, sourceGroup, 'messages');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(payload));
}

function baseDeps(overrides: Partial<any> = {}) {
  return {
    sendMessage: vi.fn(),
    sendFile: vi.fn(),
    registeredGroups: () => makeGroups(),
    registerGroup: vi.fn(),
    syncGroups: vi.fn(),
    getAvailableGroups: () => [],
    writeGroupsSnapshot: vi.fn(),
    onTasksChanged: vi.fn(),
    onAgentEvent: vi.fn(),
    ...overrides,
  };
}

describe('IPC file handling', () => {
  it('routes type=file to deps.sendFile with chatJid + path + filename', async () => {
    const ipcBaseDir = path.join(tmpDir, 'ipc');
    writeFileMessage(ipcBaseDir, 'feishu_recruit', 'f1.json', {
      type: 'file',
      chatJid: 'feishu_recruit@feishu',
      path: '/tmp/test.md',
      filename: 'test.md',
    });

    const deps = baseDeps();
    const { startIpcWatcher } = await loadIpc(tmpDir);
    startIpcWatcher(deps as any);
    await vi.advanceTimersByTimeAsync(100);

    expect(deps.sendFile).toHaveBeenCalledTimes(1);
    const [jid, filePath, filename] = deps.sendFile.mock.calls[0];
    expect(jid).toBe('feishu_recruit@feishu');
    expect(filePath).toBe('/tmp/test.md');
    expect(filename).toBe('test.md');
  });

  it('resolves targetSelf to sourceGroup jid', async () => {
    const ipcBaseDir = path.join(tmpDir, 'ipc');
    writeFileMessage(ipcBaseDir, 'feishu_recruit', 'f2.json', {
      type: 'file',
      targetSelf: true,
      path: '/tmp/x.md',
    });

    const deps = baseDeps();
    const { startIpcWatcher } = await loadIpc(tmpDir);
    startIpcWatcher(deps as any);
    await vi.advanceTimersByTimeAsync(100);

    expect(deps.sendFile).toHaveBeenCalledTimes(1);
    expect(deps.sendFile.mock.calls[0][0]).toBe('feishu_recruit@feishu');
  });

  it('blocks non-main groups from sending to other groups (authorization)', async () => {
    const ipcBaseDir = path.join(tmpDir, 'ipc');
    // feishu_recruit (non-main) tries to send to feishu_main@feishu (another group)
    writeFileMessage(ipcBaseDir, 'feishu_recruit', 'f3.json', {
      type: 'file',
      chatJid: 'feishu_main@feishu',
      path: '/tmp/x.md',
    });

    const deps = baseDeps();
    const { startIpcWatcher } = await loadIpc(tmpDir);
    startIpcWatcher(deps as any);
    await vi.advanceTimersByTimeAsync(100);

    expect(deps.sendFile).not.toHaveBeenCalled();
  });

  it('main group can send to any registered chatJid', async () => {
    const ipcBaseDir = path.join(tmpDir, 'ipc');
    writeFileMessage(ipcBaseDir, 'feishu_main', 'f4.json', {
      type: 'file',
      chatJid: 'feishu_recruit@feishu',
      path: '/tmp/x.md',
    });

    const deps = baseDeps();
    const { startIpcWatcher } = await loadIpc(tmpDir);
    startIpcWatcher(deps as any);
    await vi.advanceTimersByTimeAsync(100);

    expect(deps.sendFile).toHaveBeenCalledTimes(1);
    expect(deps.sendFile.mock.calls[0][0]).toBe('feishu_recruit@feishu');
  });

  it('drops the IPC file after dispatch even on sendFile error (no infinite retry)', async () => {
    const ipcBaseDir = path.join(tmpDir, 'ipc');
    writeFileMessage(ipcBaseDir, 'feishu_recruit', 'f5.json', {
      type: 'file',
      chatJid: 'feishu_recruit@feishu',
      path: '/tmp/x.md',
    });

    const deps = baseDeps({
      sendFile: vi.fn().mockRejectedValue(new Error('upload failed')),
    });
    const { startIpcWatcher } = await loadIpc(tmpDir);
    startIpcWatcher(deps as any);
    await vi.advanceTimersByTimeAsync(100);

    // File should be moved to errors/ (consistent with message error behavior)
    const errorsDir = path.join(ipcBaseDir, 'errors');
    if (fs.existsSync(errorsDir)) {
      expect(fs.readdirSync(errorsDir).length).toBeGreaterThanOrEqual(1);
    }
    // Either way, the original file must NOT still be queued
    const queuedFiles = fs.existsSync(
      path.join(ipcBaseDir, 'feishu_recruit', 'messages'),
    )
      ? fs
          .readdirSync(path.join(ipcBaseDir, 'feishu_recruit', 'messages'))
          .filter((f) => f.endsWith('.json'))
      : [];
    expect(queuedFiles).toHaveLength(0);
  });
});
