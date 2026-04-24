import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { handleCreateTopicGroup } from './ipc-sync-handlers.js';

function makeDeps(overrides: any = {}) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-test-'));
  fs.mkdirSync(path.join(tmpRoot, 'groups', 'global'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpRoot, 'groups', 'global', 'CLAUDE.md'),
    '# Andy\n\nGlobal default.\n',
  );
  fs.writeFileSync(
    path.join(tmpRoot, 'groups', 'global', '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        mem0: { env: { MEM0_AGENT_ID: '__MEM0_AGENT_ID__' } },
      },
    }),
  );

  return {
    tmpRoot,
    deps: {
      feishuChannel: {
        createChat: vi.fn().mockResolvedValue({ chat_id: 'oc_new' }),
        inviteMembers: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      } as any,
      setRegisteredGroup: vi.fn(),
      onGroupRegistered: vi.fn(),
      sourceGroupJid: vi.fn().mockReturnValue('feishu:oc_source'),
      lookupRequesterOpenId: vi.fn().mockReturnValue('ou_requester'),
      projectRoot: tmpRoot,
      ensureOneCliAgent: vi.fn(),
      ...overrides,
    },
  };
}

describe('handleCreateTopicGroup', () => {
  let tmpRoots: string[] = [];
  afterEach(() => {
    for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
    tmpRoots = [];
  });

  function setup(overrides?: any) {
    const out = makeDeps(overrides);
    tmpRoots.push(out.tmpRoot);
    return out;
  }

  it('happy path: all four flags true, no warnings, side effects correct', async () => {
    const { deps, tmpRoot } = setup();

    const resp = await handleCreateTopicGroup(
      {
        name: 'Pipeline 建设',
        folder: 'feishu_pipeline',
        topic_description: '讨论 pipeline 建设',
      },
      'feishu_main',
      deps,
    );

    expect(resp).toEqual({
      chat_id: 'oc_new',
      folder: 'feishu_pipeline',
      user_invited: true,
      db_registered: true,
      folder_initialized: true,
      warnings: [],
    });
    expect(deps.feishuChannel.createChat).toHaveBeenCalled();
    expect(deps.feishuChannel.inviteMembers).toHaveBeenCalledWith('oc_new', [
      'ou_requester',
    ]);
    expect(deps.setRegisteredGroup).toHaveBeenCalledWith(
      'feishu:oc_new',
      expect.objectContaining({
        folder: 'feishu_pipeline',
        requiresTrigger: false,
      }),
    );
    expect(deps.onGroupRegistered).toHaveBeenCalled();

    const md = fs.readFileSync(
      path.join(tmpRoot, 'groups', 'feishu_pipeline', 'CLAUDE.md'),
      'utf-8',
    );
    expect(md).toContain('Global default.');
    expect(md).toContain('## Topic');
    expect(md).toContain('讨论 pipeline 建设');
  });

  it('happy path: writes .mcp.json with folder-derived MEM0_AGENT_ID', async () => {
    const { deps, tmpRoot } = setup();

    await handleCreateTopicGroup(
      {
        name: 'Pipeline 建设',
        folder: 'feishu_pipeline',
        topic_description: 'x',
      },
      'feishu_main',
      deps,
    );

    const mcpPath = path.join(
      tmpRoot,
      'groups',
      'feishu_pipeline',
      '.mcp.json',
    );
    expect(fs.existsSync(mcpPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
    expect(parsed.mcpServers.mem0.env.MEM0_AGENT_ID).toBe('andy-pipeline');
  });

  it('does NOT overwrite existing .mcp.json', async () => {
    const { deps, tmpRoot } = setup();
    fs.mkdirSync(path.join(tmpRoot, 'groups', 'feishu_x'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, 'groups', 'feishu_x', '.mcp.json'),
      '{"user":"custom"}',
    );

    await handleCreateTopicGroup(
      { name: 'x', folder: 'feishu_x', topic_description: 'y' },
      'feishu_main',
      deps,
    );

    const content = fs.readFileSync(
      path.join(tmpRoot, 'groups', 'feishu_x', '.mcp.json'),
      'utf-8',
    );
    expect(content).toBe('{"user":"custom"}');
  });

  it('chat.create failure: throws, no side effects', async () => {
    const { deps } = setup();
    deps.feishuChannel.createChat = vi
      .fn()
      .mockRejectedValue(new Error('api down'));

    await expect(
      handleCreateTopicGroup(
        { name: 'x', folder: 'feishu_x', topic_description: 'y' },
        'feishu_main',
        deps,
      ),
    ).rejects.toThrow(/api down/);

    expect(deps.feishuChannel.inviteMembers).not.toHaveBeenCalled();
    expect(deps.setRegisteredGroup).not.toHaveBeenCalled();
  });

  it('invite failure: user_invited=false with warning, DB + folder still created', async () => {
    const { deps, tmpRoot } = setup();
    deps.feishuChannel.inviteMembers = vi
      .fn()
      .mockRejectedValue(new Error('no perm'));

    const resp = await handleCreateTopicGroup(
      { name: 'x', folder: 'feishu_x', topic_description: 'y' },
      'feishu_main',
      deps,
    );

    expect(resp.user_invited).toBe(false);
    expect(resp.db_registered).toBe(true);
    expect(resp.folder_initialized).toBe(true);
    expect(resp.warnings).toEqual([expect.stringContaining('invite_failed')]);
    expect(
      fs.existsSync(path.join(tmpRoot, 'groups', 'feishu_x', 'CLAUDE.md')),
    ).toBe(true);
  });

  it('DB failure: db_registered=false with warning, folder still created', async () => {
    const { deps, tmpRoot } = setup();
    deps.setRegisteredGroup = vi.fn().mockImplementation(() => {
      throw new Error('sqlite locked');
    });

    const resp = await handleCreateTopicGroup(
      { name: 'x', folder: 'feishu_x', topic_description: 'y' },
      'feishu_main',
      deps,
    );

    expect(resp.db_registered).toBe(false);
    expect(resp.folder_initialized).toBe(true);
    expect(resp.warnings).toEqual([
      expect.stringContaining('db_register_failed'),
    ]);
    expect(
      fs.existsSync(path.join(tmpRoot, 'groups', 'feishu_x', 'CLAUDE.md')),
    ).toBe(true);
  });

  it('does NOT overwrite existing CLAUDE.md', async () => {
    const { deps, tmpRoot } = setup();
    fs.mkdirSync(path.join(tmpRoot, 'groups', 'feishu_x'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmpRoot, 'groups', 'feishu_x', 'CLAUDE.md'),
      'user-customized content',
    );

    await handleCreateTopicGroup(
      { name: 'x', folder: 'feishu_x', topic_description: 'new topic' },
      'feishu_main',
      deps,
    );

    const md = fs.readFileSync(
      path.join(tmpRoot, 'groups', 'feishu_x', 'CLAUDE.md'),
      'utf-8',
    );
    expect(md).toBe('user-customized content');
  });

  it('invalid folder rejects', async () => {
    const { deps } = setup();
    await expect(
      handleCreateTopicGroup(
        { name: 'x', folder: '../evil', topic_description: 'y' },
        'feishu_main',
        deps,
      ),
    ).rejects.toThrow(/invalid folder/i);
  });

  it('no source chat rejects', async () => {
    const { deps } = setup({ sourceGroupJid: vi.fn().mockReturnValue(null) });
    await expect(
      handleCreateTopicGroup(
        { name: 'x', folder: 'feishu_x', topic_description: 'y' },
        'feishu_main',
        deps,
      ),
    ).rejects.toThrow(/cannot resolve source chat/i);
  });

  it('no recent user message rejects', async () => {
    const { deps } = setup({
      lookupRequesterOpenId: vi.fn().mockReturnValue(null),
    });
    await expect(
      handleCreateTopicGroup(
        { name: 'x', folder: 'feishu_x', topic_description: 'y' },
        'feishu_main',
        deps,
      ),
    ).rejects.toThrow(/no recent user message/i);
  });

  it('happy path also calls ensureOneCliAgent and sends welcome', async () => {
    const { deps } = setup();

    await handleCreateTopicGroup(
      {
        name: 'Pipeline 建设',
        folder: 'feishu_pipeline',
        topic_description: '讨论 pipeline',
      },
      'feishu_main',
      deps,
    );

    expect(deps.ensureOneCliAgent).toHaveBeenCalledWith(
      'feishu:oc_new',
      expect.objectContaining({ folder: 'feishu_pipeline' }),
    );
    expect(deps.feishuChannel.sendMessage).toHaveBeenCalledWith(
      'feishu:oc_new',
      expect.stringContaining('新群就绪'),
    );
  });

  it('welcome send failure: records warning, does not affect other flags', async () => {
    const { deps } = setup();
    deps.feishuChannel.sendMessage = vi
      .fn()
      .mockRejectedValue(new Error('api offline'));

    const resp = await handleCreateTopicGroup(
      { name: 'x', folder: 'feishu_x', topic_description: 'y' },
      'feishu_main',
      deps,
    );

    expect(resp.user_invited).toBe(true);
    expect(resp.db_registered).toBe(true);
    expect(resp.folder_initialized).toBe(true);
    expect(resp.warnings).toEqual([expect.stringContaining('welcome_failed')]);
  });
});
