import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { RegisteredGroup } from './types.js';

// All 4 targetSelf scenarios are tested by writing IPC message files into a
// real temp dir and running startIpcWatcher with fake timers.
// ipcWatcherRunning is module-level state, so we reset modules between tests.

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-targetself-'));
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
  const mod = await import('./ipc.js');
  return mod;
}

function makeGroups(): Record<string, RegisteredGroup> {
  return {
    'feishu_dm@feishu': {
      name: 'Feishu DM',
      folder: 'feishu_dm',
      trigger: 'always',
      added_at: '2024-01-01T00:00:00.000Z',
    },
    'feishu_main@feishu': {
      name: 'Feishu Main',
      folder: 'feishu_main',
      trigger: 'always',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    },
  };
}

function writeMessageFile(
  ipcBaseDir: string,
  sourceGroup: string,
  filename: string,
  payload: object,
) {
  const dir = path.join(ipcBaseDir, sourceGroup, 'messages');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(payload));
}

describe('IPC targetSelf resolution', () => {
  it('targetSelf:true + no chatJid → resolves chatJid from registeredGroups and sends message', async () => {
    const ipcBaseDir = path.join(tmpDir, 'ipc');
    writeMessageFile(ipcBaseDir, 'feishu_dm', 'msg1.json', {
      type: 'message',
      targetSelf: true,
      text: 'hello self',
    });

    const groups = makeGroups();
    const sentMessages: Array<{ jid: string; text: string }> = [];
    const deps = {
      sendMessage: async (jid: string, text: string) => {
        sentMessages.push({ jid, text });
      },
      registeredGroups: () => groups,
      registerGroup: vi.fn(),
      syncGroups: vi.fn(),
      getAvailableGroups: () => [],
      writeGroupsSnapshot: vi.fn(),
      onTasksChanged: vi.fn(),
      onAgentEvent: vi.fn(),
    };

    const { startIpcWatcher } = await loadIpc(tmpDir);
    startIpcWatcher(deps as any);

    await vi.advanceTimersByTimeAsync(100);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toEqual({ jid: 'feishu_dm@feishu', text: 'hello self' });
  });

  it('targetSelf:false → does nothing (chatJid stays unresolved, message not sent)', async () => {
    const ipcBaseDir = path.join(tmpDir, 'ipc');
    writeMessageFile(ipcBaseDir, 'feishu_dm', 'msg2.json', {
      type: 'message',
      targetSelf: false,
      text: 'hello self',
    });

    const groups = makeGroups();
    const sentMessages: Array<{ jid: string; text: string }> = [];
    const deps = {
      sendMessage: async (jid: string, text: string) => {
        sentMessages.push({ jid, text });
      },
      registeredGroups: () => groups,
      registerGroup: vi.fn(),
      syncGroups: vi.fn(),
      getAvailableGroups: () => [],
      writeGroupsSnapshot: vi.fn(),
      onTasksChanged: vi.fn(),
      onAgentEvent: vi.fn(),
    };

    const { startIpcWatcher } = await loadIpc(tmpDir);
    startIpcWatcher(deps as any);

    await vi.advanceTimersByTimeAsync(100);

    // targetSelf:false means no resolution; no chatJid means message is skipped
    expect(sentMessages).toHaveLength(0);
  });

  it('targetSelf:true + chatJid already set → does not overwrite chatJid', async () => {
    const ipcBaseDir = path.join(tmpDir, 'ipc');
    // feishu_main is isMain so it can send to any JID; chatJid is already set
    // to feishu_dm@feishu and must not be overwritten to feishu_main@feishu
    writeMessageFile(ipcBaseDir, 'feishu_main', 'msg3.json', {
      type: 'message',
      targetSelf: true,
      chatJid: 'feishu_dm@feishu',
      text: 'explicit jid',
    });

    const groups = makeGroups();
    const sentMessages: Array<{ jid: string; text: string }> = [];
    const deps = {
      sendMessage: async (jid: string, text: string) => {
        sentMessages.push({ jid, text });
      },
      registeredGroups: () => groups,
      registerGroup: vi.fn(),
      syncGroups: vi.fn(),
      getAvailableGroups: () => [],
      writeGroupsSnapshot: vi.fn(),
      onTasksChanged: vi.fn(),
      onAgentEvent: vi.fn(),
    };

    const { startIpcWatcher } = await loadIpc(tmpDir);
    startIpcWatcher(deps as any);

    await vi.advanceTimersByTimeAsync(100);

    // chatJid was already set to feishu_dm@feishu and must not be overwritten
    // to feishu_main@feishu (which is what targetSelf would resolve to)
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].jid).toBe('feishu_dm@feishu');
  });

  it('targetSelf:true + no matching JID for sourceGroup → chatJid stays undefined, message not sent', async () => {
    const ipcBaseDir = path.join(tmpDir, 'ipc');
    // sourceGroup 'unknown_group' has no registered JID
    writeMessageFile(ipcBaseDir, 'unknown_group', 'msg4.json', {
      type: 'message',
      targetSelf: true,
      text: 'unregistered source',
    });

    const groups = makeGroups();
    const sentMessages: Array<{ jid: string; text: string }> = [];
    const deps = {
      sendMessage: async (jid: string, text: string) => {
        sentMessages.push({ jid, text });
      },
      registeredGroups: () => groups,
      registerGroup: vi.fn(),
      syncGroups: vi.fn(),
      getAvailableGroups: () => [],
      writeGroupsSnapshot: vi.fn(),
      onTasksChanged: vi.fn(),
      onAgentEvent: vi.fn(),
    };

    const { startIpcWatcher } = await loadIpc(tmpDir);
    startIpcWatcher(deps as any);

    await vi.advanceTimersByTimeAsync(100);

    // No JID found for unknown_group → chatJid stays undefined → message skipped
    expect(sentMessages).toHaveLength(0);
  });
});
