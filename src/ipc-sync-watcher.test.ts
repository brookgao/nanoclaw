import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { processSyncRequest } from './ipc.js';

describe('processSyncRequest', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-sync-'));
    fs.mkdirSync(path.join(tmp, 'sync_requests'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'sync_responses'), { recursive: true });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('dispatches create_topic_group and writes success response', async () => {
    const reqPath = path.join(tmp, 'sync_requests', 'abc.json');
    fs.writeFileSync(
      reqPath,
      JSON.stringify({
        action: 'create_topic_group',
        name: 'x',
        folder: 'feishu_x',
        topic_description: 'y',
      }),
    );

    const handler = vi.fn().mockResolvedValue({
      chat_id: 'oc_z',
      folder: 'feishu_x',
      user_invited: true,
      db_registered: true,
      folder_initialized: true,
      warnings: [],
    });

    await processSyncRequest(reqPath, tmp, 'feishu_main', {
      handleCreateTopicGroup: handler,
      createTopicGroupDeps: {} as any,
    });

    const respPath = path.join(tmp, 'sync_responses', 'abc.json');
    expect(fs.existsSync(respPath)).toBe(true);
    const resp = JSON.parse(fs.readFileSync(respPath, 'utf-8'));
    expect(resp).toEqual({
      data: expect.objectContaining({ chat_id: 'oc_z' }),
    });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'x', folder: 'feishu_x' }),
      'feishu_main',
      expect.anything(),
    );
    expect(fs.existsSync(reqPath)).toBe(false);
  });

  it('writes {error} response when handler throws', async () => {
    const reqPath = path.join(tmp, 'sync_requests', 'err.json');
    fs.writeFileSync(
      reqPath,
      JSON.stringify({
        action: 'create_topic_group',
        name: 'x',
        folder: 'f',
        topic_description: 't',
      }),
    );

    const handler = vi.fn().mockRejectedValue(new Error('boom'));

    await processSyncRequest(reqPath, tmp, 'feishu_main', {
      handleCreateTopicGroup: handler,
      createTopicGroupDeps: {} as any,
    });

    const respPath = path.join(tmp, 'sync_responses', 'err.json');
    const resp = JSON.parse(fs.readFileSync(respPath, 'utf-8'));
    expect(resp).toEqual({ error: 'boom' });
  });

  it('writes error for unknown action', async () => {
    const reqPath = path.join(tmp, 'sync_requests', 'unk.json');
    fs.writeFileSync(reqPath, JSON.stringify({ action: 'not_a_real_action' }));

    await processSyncRequest(reqPath, tmp, 'feishu_main', {
      handleCreateTopicGroup: vi.fn(),
      createTopicGroupDeps: {} as any,
    });

    const respPath = path.join(tmp, 'sync_responses', 'unk.json');
    const resp = JSON.parse(fs.readFileSync(respPath, 'utf-8'));
    expect(resp.error).toMatch(/unknown.*action/i);
  });

  it('rejects create_topic_group from non-main/dm source', async () => {
    const reqPath = path.join(tmp, 'sync_requests', 'p.json');
    fs.writeFileSync(
      reqPath,
      JSON.stringify({
        action: 'create_topic_group',
        name: 'x',
        folder: 'f',
        topic_description: 't',
      }),
    );

    const handler = vi.fn();
    await processSyncRequest(reqPath, tmp, 'feishu_pipeline', {
      handleCreateTopicGroup: handler,
      createTopicGroupDeps: {} as any,
    });

    const resp = JSON.parse(
      fs.readFileSync(path.join(tmp, 'sync_responses', 'p.json'), 'utf-8'),
    );
    expect(resp.error).toMatch(/not authorized/i);
    expect(handler).not.toHaveBeenCalled();
  });
});
