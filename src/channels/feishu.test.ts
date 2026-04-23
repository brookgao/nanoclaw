import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { getChannelFactory } from './registry.js';
import { parseInbound } from './feishu.js';
import {
  _initTestDatabase,
  _closeDatabase,
  getActiveCards,
  insertActiveCard,
} from '../db.js';

// Stub readEnvFile so tests don't read the real ./.env.
vi.mock('../env.js', () => ({
  readEnvFile: () => ({}),
}));

// Import triggers self-registration
import './feishu.js';

function restoreEnv(orig: NodeJS.ProcessEnv) {
  for (const k of ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_DOMAIN']) {
    if (orig[k] === undefined) delete process.env[k];
    else process.env[k] = orig[k];
  }
}

const origEnv = { ...process.env };

function makeOpts(
  overrides: Partial<{ onMessage: any; onChatMetadata: any }> = {},
) {
  return {
    onMessage: overrides.onMessage ?? vi.fn(),
    onChatMetadata: overrides.onChatMetadata ?? vi.fn(),
    registeredGroups: () => ({}),
  };
}

function makeEvent(
  overrides: Partial<{
    chat_id: string;
    chat_type: 'p2p' | 'group';
    msg_type: string;
    text: string;
    content: string;
    sender_id: string;
    sender_type: 'user' | 'app';
    message_id: string;
    mentions: Array<{ key?: string; id: { open_id: string } }>;
  }> = {},
): any {
  return {
    schema: '2.0',
    header: {
      event_type: 'im.message.receive_v1',
      create_time: '1700000000000',
    },
    event: {
      sender: {
        sender_id: { open_id: overrides.sender_id ?? 'ou_user1' },
        sender_type: overrides.sender_type ?? 'user',
      },
      message: {
        message_id:
          overrides.message_id ?? `om_${Math.random().toString(36).slice(2)}`,
        chat_id: overrides.chat_id ?? 'oc_p2p1',
        chat_type: overrides.chat_type ?? 'p2p',
        message_type: overrides.msg_type ?? 'text',
        content:
          overrides.content ??
          JSON.stringify({ text: overrides.text ?? 'hello' }),
        mentions: overrides.mentions ?? [],
      },
    },
  };
}

describe('FeishuChannel factory', () => {
  beforeEach(() => {
    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;
  });
  afterEach(() => restoreEnv(origEnv));

  it('returns null when FEISHU_APP_ID missing', () => {
    process.env.FEISHU_APP_SECRET = 'secret';
    const factory = getChannelFactory('feishu')!;
    expect(factory(makeOpts())).toBeNull();
  });

  it('returns null when FEISHU_APP_SECRET missing', () => {
    process.env.FEISHU_APP_ID = 'cli_xxx';
    const factory = getChannelFactory('feishu')!;
    expect(factory(makeOpts())).toBeNull();
  });
});

describe('FeishuChannel construction', () => {
  beforeEach(() => {
    process.env.FEISHU_APP_ID = 'cli_test';
    process.env.FEISHU_APP_SECRET = 'secret_test';
  });
  afterEach(() => restoreEnv(origEnv));

  it('constructs with name "feishu" and starts disconnected', () => {
    const ch = getChannelFactory('feishu')!(makeOpts())!;
    expect(ch).not.toBeNull();
    expect(ch.name).toBe('feishu');
    expect(ch.isConnected()).toBe(false);
  });

  it('ownsJid returns true only for feishu: prefix', () => {
    const ch = getChannelFactory('feishu')!(makeOpts())!;
    expect(ch.ownsJid('feishu:oc_abc')).toBe(true);
    expect(ch.ownsJid('telegram:123')).toBe(false);
  });
});

describe('FeishuChannel inbound p2p', () => {
  beforeEach(() => {
    process.env.FEISHU_APP_ID = 'cli_test';
    process.env.FEISHU_APP_SECRET = 'secret_test';
  });
  afterEach(() => restoreEnv(origEnv));

  it('routes p2p text to onMessage with feishu:<chat_id> jid and emits metadata', () => {
    const onMessage = vi.fn();
    const onChatMetadata = vi.fn();
    const ch = getChannelFactory('feishu')!(
      makeOpts({ onMessage, onChatMetadata }),
    )! as any;

    ch.handleEvent(makeEvent({ chat_id: 'oc_p2p1', text: 'hi andy' }));

    expect(onMessage).toHaveBeenCalledTimes(1);
    const [jid, msg] = onMessage.mock.calls[0];
    expect(jid).toBe('feishu:oc_p2p1');
    expect(msg.content).toBe('hi andy');
    expect(msg.sender).toBe('ou_user1');

    expect(onChatMetadata).toHaveBeenCalledTimes(1);
    const metaArgs = onChatMetadata.mock.calls[0];
    expect(metaArgs[0]).toBe('feishu:oc_p2p1');
    expect(metaArgs[3]).toBe('feishu');
    expect(metaArgs[4]).toBe(false);
  });
});

describe('FeishuChannel inbound group', () => {
  beforeEach(() => {
    process.env.FEISHU_APP_ID = 'cli_test';
    process.env.FEISHU_APP_SECRET = 'secret_test';
  });
  afterEach(() => restoreEnv(origEnv));

  it('delivers group message when bot is @-mentioned and strips only bot mention', () => {
    const onMessage = vi.fn();
    const ch = getChannelFactory('feishu')!(makeOpts({ onMessage }))! as any;
    ch.botOpenId = 'ou_bot';

    ch.handleEvent(
      makeEvent({
        chat_id: 'oc_g1',
        chat_type: 'group',
        text: '@_user_1 please cc @_user_2',
        mentions: [
          { key: '@_user_1', id: { open_id: 'ou_bot' } },
          { key: '@_user_2', id: { open_id: 'ou_human' } },
        ],
      }),
    );

    expect(onMessage).toHaveBeenCalledTimes(1);
    const [jid, msg] = onMessage.mock.calls[0];
    expect(jid).toBe('feishu:oc_g1');
    expect(msg.content).toBe('please cc @_user_2');
  });

  it('ignores group message without any @mention', () => {
    const onMessage = vi.fn();
    const ch = getChannelFactory('feishu')!(makeOpts({ onMessage }))! as any;
    ch.botOpenId = 'ou_bot';
    ch.handleEvent(makeEvent({ chat_type: 'group', mentions: [] }));
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('ignores group message when @mention is not the bot', () => {
    const onMessage = vi.fn();
    const ch = getChannelFactory('feishu')!(makeOpts({ onMessage }))! as any;
    ch.botOpenId = 'ou_bot';
    ch.handleEvent(
      makeEvent({
        chat_type: 'group',
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_someone_else' } }],
      }),
    );
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('drops messages sent by the bot itself (self-loop guard)', () => {
    const onMessage = vi.fn();
    const ch = getChannelFactory('feishu')!(makeOpts({ onMessage }))! as any;
    ch.botOpenId = 'ou_bot';

    ch.handleEvent(makeEvent({ sender_type: 'app', text: 'reply' }));
    expect(onMessage).not.toHaveBeenCalled();

    ch.handleEvent(makeEvent({ sender_id: 'ou_bot', message_id: 'om_other' }));
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('dedups on message_id (WS reconnect replay)', () => {
    const onMessage = vi.fn();
    const ch = getChannelFactory('feishu')!(makeOpts({ onMessage }))! as any;
    const ev = makeEvent({ message_id: 'om_dup', text: 'once' });
    ch.handleEvent(ev);
    ch.handleEvent(ev);
    ch.handleEvent(ev);
    expect(onMessage).toHaveBeenCalledTimes(1);
  });
});

describe('FeishuChannel sendMessage', () => {
  beforeEach(() => {
    process.env.FEISHU_APP_ID = 'cli_test';
    process.env.FEISHU_APP_SECRET = 'secret_test';
  });
  afterEach(() => restoreEnv(origEnv));

  it('calls im.message.create with an interactive markdown card', async () => {
    const ch = getChannelFactory('feishu')!(makeOpts())! as any;
    const createSpy = vi
      .fn()
      .mockResolvedValue({ code: 0, data: { message_id: 'om_x' } });
    ch.client = { im: { message: { create: createSpy } } };

    await ch.sendMessage('feishu:oc_g1', '# Title\n\n```py\nprint(1)\n```');

    expect(createSpy).toHaveBeenCalledTimes(1);
    const call = createSpy.mock.calls[0][0];
    expect(call.params.receive_id_type).toBe('chat_id');
    expect(call.data.receive_id).toBe('oc_g1');
    expect(call.data.msg_type).toBe('interactive');
    const card = JSON.parse(call.data.content);
    expect(card.schema).toBe('2.0');
    expect(card.body.elements[0].tag).toBe('markdown');
    expect(card.body.elements[0].content).toBe(
      '# Title\n\n```py\nprint(1)\n```',
    );
  });

  it('throws informative error for non-feishu jid', async () => {
    const ch = getChannelFactory('feishu')!(makeOpts())!;
    await expect(ch.sendMessage('telegram:123', 'x')).rejects.toThrow(/feishu/);
  });

  it('logs and swallows API errors without throwing', async () => {
    const ch = getChannelFactory('feishu')!(makeOpts())! as any;
    ch.client = {
      im: {
        message: {
          create: vi.fn().mockRejectedValue(new Error('429 rate limit')),
        },
      },
    };
    await expect(ch.sendMessage('feishu:oc_g1', 'hi')).resolves.toBeUndefined();
  });
});

describe('FeishuChannel connect', () => {
  beforeEach(() => {
    process.env.FEISHU_APP_ID = 'cli_test';
    process.env.FEISHU_APP_SECRET = 'secret_test';
  });
  afterEach(() => restoreEnv(origEnv));

  it('resolves bot open_id via REST, starts WS, reports connected', async () => {
    const ch = getChannelFactory('feishu')!(makeOpts())! as any;
    ch.ws = { start: vi.fn().mockResolvedValue(undefined), close: vi.fn() };
    ch.client = {
      request: vi
        .fn()
        .mockResolvedValue({ data: { bot: { open_id: 'ou_bot_resolved' } } }),
    };

    await ch.connect();

    expect(ch.isConnected()).toBe(true);
    expect(ch.botOpenId).toBe('ou_bot_resolved');
    expect(ch.ws.start).toHaveBeenCalledTimes(1);
    expect(ch.client.request).toHaveBeenCalledWith(
      expect.objectContaining({ url: '/open-apis/bot/v3/info' }),
    );
  });

  it('stays running when bot info request fails (warn, null open_id)', async () => {
    const ch = getChannelFactory('feishu')!(makeOpts())! as any;
    ch.ws = { start: vi.fn().mockResolvedValue(undefined), close: vi.fn() };
    ch.client = { request: vi.fn().mockRejectedValue(new Error('403')) };

    await expect(ch.connect()).resolves.toBeUndefined();
    expect(ch.botOpenId).toBeNull();
    expect(ch.isConnected()).toBe(true);
  });
});

describe('parseInbound', () => {
  const botOpenId = 'ou_bot';

  it('text message → text only, no images', () => {
    const r = parseInbound(
      {
        message_type: 'text',
        content: JSON.stringify({ text: 'hello' }),
        mentions: [],
      } as any,
      botOpenId,
    );
    expect(r).toEqual({ text: 'hello', imageKeys: [], botMentioned: false });
  });

  it('image message → single image key, empty text', () => {
    const r = parseInbound(
      {
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_v3_abc' }),
        mentions: [],
      } as any,
      botOpenId,
    );
    expect(r).toEqual({
      text: '[图片]',
      imageKeys: ['img_v3_abc'],
      botMentioned: false,
    });
  });

  it('post: text + img + at(bot) → text preserved, bot at omitted, image collected, botMentioned=true', () => {
    const content = JSON.stringify({
      title: '',
      content: [
        [
          { tag: 'text', text: 'look at this ' },
          { tag: 'at', user_id: botOpenId },
          { tag: 'img', image_key: 'img_k1' },
        ],
      ],
    });
    const r = parseInbound(
      {
        message_type: 'post',
        content,
        mentions: [
          { key: '@_user_1', id: { open_id: botOpenId }, name: 'Andy' },
        ],
      } as any,
      botOpenId,
    );
    expect(r!.text).toBe('look at this');
    expect(r!.imageKeys).toEqual(['img_k1']);
    expect(r!.botMentioned).toBe(true);
  });

  it('post: at non-bot user → substituted with @name from mentions[]', () => {
    const content = JSON.stringify({
      title: '',
      content: [
        [
          { tag: 'text', text: 'hey ' },
          { tag: 'at', user_id: 'ou_other' },
          { tag: 'text', text: ' look' },
        ],
      ],
    });
    const r = parseInbound(
      {
        message_type: 'post',
        content,
        mentions: [
          { key: '@_user_2', id: { open_id: 'ou_other' }, name: '小明' },
        ],
      } as any,
      botOpenId,
    );
    expect(r!.text).toBe('hey @小明 look');
  });

  it('post: at with no matching mentions[] → fallback to user_id', () => {
    const content = JSON.stringify({
      title: '',
      content: [[{ tag: 'at', user_id: 'ou_unknown' }]],
    });
    const r = parseInbound(
      { message_type: 'post', content, mentions: [] } as any,
      botOpenId,
    );
    expect(r!.text).toBe('@ou_unknown');
  });

  it('post: >5 images → truncated to 5 + truncation marker appended', () => {
    const segs = Array.from({ length: 7 }, (_, i) => ({
      tag: 'img',
      image_key: `k${i}`,
    }));
    const content = JSON.stringify({ title: '', content: [segs] });
    const r = parseInbound(
      { message_type: 'post', content, mentions: [] } as any,
      botOpenId,
    );
    expect(r!.imageKeys).toHaveLength(5);
    expect(r!.imageKeys).toEqual(['k0', 'k1', 'k2', 'k3', 'k4']);
    expect(r!.text).toContain('[系统: 本条消息含 7 张图，仅处理前 5 张]');
  });

  it('post: multiple paragraphs joined with newlines', () => {
    const content = JSON.stringify({
      title: '',
      content: [
        [{ tag: 'text', text: 'line 1' }],
        [{ tag: 'text', text: 'line 2' }],
      ],
    });
    const r = parseInbound(
      { message_type: 'post', content, mentions: [] } as any,
      botOpenId,
    );
    expect(r!.text).toBe('line 1\nline 2');
  });

  it('post: unknown tag → silently skipped', () => {
    const content = JSON.stringify({
      title: '',
      content: [
        [
          { tag: 'text', text: 'before ' },
          { tag: 'emoji', emoji_type: 'SMILE' },
          { tag: 'text', text: 'after' },
        ],
      ],
    });
    const r = parseInbound(
      { message_type: 'post', content, mentions: [] } as any,
      botOpenId,
    );
    expect(r!.text).toBe('before after');
  });

  it('malformed post content JSON → returns null', () => {
    const r = parseInbound(
      { message_type: 'post', content: '{not json', mentions: [] } as any,
      botOpenId,
    );
    expect(r).toBeNull();
  });

  it('other types (audio/video/file/sticker) → returns null', () => {
    for (const t of ['audio', 'video', 'file', 'sticker']) {
      const r = parseInbound(
        { message_type: t, content: '{}', mentions: [] } as any,
        botOpenId,
      );
      expect(r).toBeNull();
    }
  });

  it('post: empty text + zero images → returns null', () => {
    const r = parseInbound(
      {
        message_type: 'post',
        content: JSON.stringify({ title: '', content: [[]] }),
        mentions: [],
      } as any,
      botOpenId,
    );
    expect(r).toBeNull();
  });
});

describe('FeishuChannel image pipeline', () => {
  beforeEach(() => {
    process.env.FEISHU_APP_ID = 'cli_test';
    process.env.FEISHU_APP_SECRET = 'secret_test';
  });
  afterEach(() => restoreEnv(origEnv));

  function makeClientMock() {
    return {
      im: {
        messageReaction: {
          create: vi.fn().mockResolvedValue({}),
        },
        message: {
          create: vi
            .fn()
            .mockResolvedValue({ data: { message_id: 'om_reply' } }),
        },
      },
    };
  }

  it('p2p image success → onMessage called with images attached', async () => {
    const onMessage = vi.fn();
    const ch = getChannelFactory('feishu')!(makeOpts({ onMessage }))! as any;
    ch.client = makeClientMock();
    ch.downloadImage = vi.fn(async (_msgId: string, _key: string) =>
      readFileSync(
        '/Users/admin/Desktop/vibe-coding/nanoclaw/tests/fixtures/image-normal.png',
      ),
    );

    await ch.handleEvent(
      makeEvent({
        msg_type: 'image',
        content: JSON.stringify({ image_key: 'img_good' }),
      }),
    );

    expect(onMessage).toHaveBeenCalledTimes(1);
    const msg = onMessage.mock.calls[0][1];
    expect(msg.images).toHaveLength(1);
    expect(msg.images[0].sourceKey).toBe('img_good');
    expect(msg.images[0].mediaType).toBe('image/jpeg');

    expect(ch.downloadImage).toHaveBeenCalled();
    const [firstCallMsgId, firstCallKey] = ch.downloadImage.mock.calls[0];
    expect(firstCallMsgId).toBeTruthy();
    expect(firstCallKey).toBe('img_good');
  });

  it('p2p image fail (404) → sendMessage with 🖼️, onMessage NOT called', async () => {
    const onMessage = vi.fn();
    const ch = getChannelFactory('feishu')!(makeOpts({ onMessage }))! as any;
    ch.client = makeClientMock();
    const sendSpy = vi.spyOn(ch, 'sendMessage').mockResolvedValue(undefined);
    ch.downloadImage = vi.fn(async (_msgId: string, _key: string) => {
      throw Object.assign(new Error('404'), { statusCode: 404 });
    });

    await ch.handleEvent(
      makeEvent({
        msg_type: 'image',
        content: JSON.stringify({ image_key: 'img_expired' }),
      }),
    );

    expect(onMessage).not.toHaveBeenCalled();
    expect(sendSpy).toHaveBeenCalled();
    const [, text] = sendSpy.mock.calls[0];
    expect(text).toMatch(/^🖼️ 图没收到\(过期\)/);
  });

  it('p2p mixed 2/3 fail → failure message shows counts', async () => {
    const onMessage = vi.fn();
    const ch = getChannelFactory('feishu')!(makeOpts({ onMessage }))! as any;
    ch.client = makeClientMock();
    const sendSpy = vi.spyOn(ch, 'sendMessage').mockResolvedValue(undefined);
    const good = readFileSync(
      '/Users/admin/Desktop/vibe-coding/nanoclaw/tests/fixtures/image-normal.png',
    );
    ch.downloadImage = vi.fn(async (_msgId: string, k: string) => {
      if (k === 'a' || k === 'c')
        throw Object.assign(new Error('404'), { statusCode: 404 });
      return good;
    });

    const content = JSON.stringify({
      title: '',
      content: [
        [
          { tag: 'img', image_key: 'a' },
          { tag: 'img', image_key: 'b' },
          { tag: 'img', image_key: 'c' },
        ],
      ],
    });
    await ch.handleEvent(makeEvent({ msg_type: 'post', content }));

    expect(onMessage).not.toHaveBeenCalled();
    const [, text] = sendSpy.mock.calls[0];
    expect(text).toMatch(/3 张图有 2 张没收到/);
  });

  it('p2p text message still reaches onMessage (regression)', async () => {
    const onMessage = vi.fn();
    const ch = getChannelFactory('feishu')!(makeOpts({ onMessage }))! as any;
    ch.client = makeClientMock();

    await ch.handleEvent(
      makeEvent({
        msg_type: 'text',
        content: JSON.stringify({ text: 'hello' }),
      }),
    );

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][1].content).toBe('hello');
    expect(onMessage.mock.calls[0][1].images).toBeUndefined();
  });
});

describe('FeishuChannel.createChat', () => {
  it('calls im.chat.create with correct payload and returns chat_id', async () => {
    const ch = new (await import('./feishu.js')).FeishuChannel(
      'app_id_test',
      'app_secret_test',
      makeOpts(),
    );
    const createSpy = vi
      .fn()
      .mockResolvedValue({ data: { chat_id: 'oc_new_chat_xyz' } });
    (ch as any).client = {
      im: { chat: { create: createSpy } },
    };
    (ch as any).botOpenId = 'ou_bot';

    const result = await ch.createChat({
      name: 'Pipeline 建设',
      description: '讨论 pipeline 的建设与改造',
    });

    expect(result).toEqual({ chat_id: 'oc_new_chat_xyz' });
    expect(createSpy).toHaveBeenCalledWith({
      data: {
        name: 'Pipeline 建设',
        description: '讨论 pipeline 的建设与改造',
        chat_mode: 'group',
        chat_type: 'private',
      },
      params: { user_id_type: 'open_id' },
    });
  });

  it('throws if response has no chat_id', async () => {
    const ch = new (await import('./feishu.js')).FeishuChannel(
      'id',
      'secret',
      makeOpts(),
    );
    (ch as any).client = {
      im: { chat: { create: vi.fn().mockResolvedValue({ data: {} }) } },
    };
    (ch as any).botOpenId = 'ou_bot';

    await expect(
      ch.createChat({ name: 'x', description: 'y' }),
    ).rejects.toThrow(/no chat_id/);
  });
});

describe('FeishuChannel.inviteMembers', () => {
  it('calls im.chatMembers.create with correct payload', async () => {
    const ch = new (await import('./feishu.js')).FeishuChannel(
      'id',
      'secret',
      makeOpts(),
    );
    const inviteSpy = vi.fn().mockResolvedValue({ data: {} });
    (ch as any).client = {
      im: { chatMembers: { create: inviteSpy } },
    };

    await ch.inviteMembers('oc_target', ['ou_alice', 'ou_bob']);

    expect(inviteSpy).toHaveBeenCalledWith({
      path: { chat_id: 'oc_target' },
      params: { member_id_type: 'open_id' },
      data: { id_list: ['ou_alice', 'ou_bob'] },
    });
  });

  it('propagates API errors', async () => {
    const ch = new (await import('./feishu.js')).FeishuChannel(
      'id',
      'secret',
      makeOpts(),
    );
    (ch as any).client = {
      im: {
        chatMembers: {
          create: vi.fn().mockRejectedValue(new Error('permission denied')),
        },
      },
    };

    await expect(ch.inviteMembers('oc_x', ['ou_y'])).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe('FeishuChannel onAgentEvent (card session lifecycle)', () => {
  beforeEach(() => {
    process.env.FEISHU_APP_ID = 'cli_test';
    process.env.FEISHU_APP_SECRET = 'secret_test';
    _initTestDatabase();
  });
  afterEach(() => {
    _closeDatabase();
    restoreEnv(origEnv);
  });

  function makeChannelWithMockedClient() {
    const ch = getChannelFactory('feishu')!(makeOpts())! as any;
    const createSpy = vi.fn().mockResolvedValue({
      code: 0,
      data: { message_id: 'om_card_initial' },
    });
    const patchSpy = vi.fn().mockResolvedValue({ code: 0 });
    ch.client = { im: { message: { create: createSpy, patch: patchSpy } } };
    return { ch, createSpy, patchSpy };
  }

  function startEvent(runId: string, prompt = 'hi'): any {
    return {
      type: 'agent_event',
      chatJid: 'feishu:oc_t1',
      runId,
      seq: 0,
      timestamp: Date.now(),
      kind: 'start',
      payload: { prompt },
    };
  }

  function toolUseEvent(
    runId: string,
    toolUseId: string,
    tool = 'Bash',
    seq = 1,
  ): any {
    return {
      type: 'agent_event',
      chatJid: 'feishu:oc_t1',
      runId,
      seq,
      timestamp: Date.now(),
      kind: 'tool_use',
      payload: { tool, args: { command: 'echo x' }, toolUseId },
    };
  }

  it('same runId duplicate start preserves existing card (compact-safe)', async () => {
    const { ch, createSpy, patchSpy } = makeChannelWithMockedClient();
    const jid = 'feishu:oc_t1';
    const RUN = 'run-A';

    await ch.onAgentEvent(jid, startEvent(RUN));
    await ch.onAgentEvent(jid, toolUseEvent(RUN, 'tu-1'));
    expect(createSpy).toHaveBeenCalledTimes(1);

    // Capture timer reference before the duplicate start to assert survival
    const heartbeatBefore = ch.cardSessions.get(jid).heartbeatTimer;
    expect(heartbeatBefore).toBeDefined();

    // Simulate SDK auto-compact: second start with same runId
    await ch.onAgentEvent(jid, startEvent(RUN));

    const session = ch.cardSessions.get(jid);
    expect(session.messageId).toBe('om_card_initial');
    expect(session.toolEvents).toHaveLength(1);
    expect(session.runId).toBe(RUN);
    // Timer must survive the duplicate start (same reference, not recreated)
    expect(session.heartbeatTimer).toBe(heartbeatBefore);

    // Subsequent tool_use should patch, not re-create
    await ch.onAgentEvent(jid, toolUseEvent(RUN, 'tu-2', 'Edit', 2));
    expect(createSpy).toHaveBeenCalledTimes(1);

    // Cleanup to stop the 15s heartbeat interval
    clearInterval(session.heartbeatTimer);
  });

  it('different runId triggers full session reset (new user request)', async () => {
    const { ch } = makeChannelWithMockedClient();
    const jid = 'feishu:oc_t1';

    await ch.onAgentEvent(jid, startEvent('run-A'));
    await ch.onAgentEvent(jid, toolUseEvent('run-A', 'tu-1'));
    const s1 = ch.cardSessions.get(jid);
    expect(s1.runId).toBe('run-A');
    expect(s1.toolEvents).toHaveLength(1);

    // New run arrives
    await ch.onAgentEvent(jid, startEvent('run-B', 'second message'));

    const s2 = ch.cardSessions.get(jid);
    expect(s2.runId).toBe('run-B');
    expect(s2.messageId).toBe('');
    expect(s2.toolEvents).toHaveLength(0);
    expect(s2.prompt).toBe('second message');
  });

  it('tool_events accumulate across compact-triggered duplicate starts', async () => {
    const { ch, createSpy } = makeChannelWithMockedClient();
    const jid = 'feishu:oc_t1';
    const RUN = 'run-X';

    await ch.onAgentEvent(jid, startEvent(RUN));
    await ch.onAgentEvent(jid, toolUseEvent(RUN, 'tu-1', 'Bash', 1));
    await ch.onAgentEvent(jid, startEvent(RUN)); // compact #1
    await ch.onAgentEvent(jid, toolUseEvent(RUN, 'tu-2', 'Edit', 3));
    await ch.onAgentEvent(jid, startEvent(RUN)); // compact #2
    await ch.onAgentEvent(jid, toolUseEvent(RUN, 'tu-3', 'Read', 5));

    const session = ch.cardSessions.get(jid);
    expect(session.toolEvents.map((e: any) => e.tool)).toEqual([
      'Bash',
      'Edit',
      'Read',
    ]);
    expect(createSpy).toHaveBeenCalledTimes(1);
  });
});

describe('card session DB persistence', () => {
  beforeEach(() => {
    _initTestDatabase();
  });
  afterEach(() => {
    _closeDatabase();
  });

  function makeChannel() {
    process.env.FEISHU_APP_ID = 'test-id';
    process.env.FEISHU_APP_SECRET = 'test-secret';
    const factory = getChannelFactory('feishu')!;
    const ch = factory(makeOpts())!;
    const mockCreate = vi
      .fn()
      .mockResolvedValue({ data: { message_id: 'om_card_1' } });
    const mockPatch = vi.fn().mockResolvedValue({});
    (ch as any).client = {
      im: {
        message: { create: mockCreate, patch: mockPatch },
        messageReaction: { create: vi.fn().mockResolvedValue({}) },
      },
    };
    return { ch, mockCreate, mockPatch };
  }

  it('inserts active_card row when card is created', async () => {
    const { ch } = makeChannel();
    const jid = 'feishu:oc_test123';

    await ch.onAgentEvent!(jid, {
      kind: 'start',
      runId: 'run-abc',
      timestamp: Date.now(),
      payload: { prompt: 'test prompt' },
    });
    await ch.onAgentEvent!(jid, {
      kind: 'tool_use',
      runId: 'run-abc',
      timestamp: Date.now(),
      payload: { tool: 'Bash', args: { command: 'ls' }, toolUseId: 'tu-1' },
    });

    const cards = getActiveCards();
    expect(cards).toHaveLength(1);
    expect(cards[0].jid).toBe(jid);
    expect(cards[0].message_id).toBe('om_card_1');
    expect(cards[0].run_id).toBe('run-abc');

    restoreEnv(origEnv);
  });

  it('deletes active_card row on final event', async () => {
    const { ch } = makeChannel();
    const jid = 'feishu:oc_test456';

    await ch.onAgentEvent!(jid, {
      kind: 'start',
      runId: 'run-def',
      timestamp: Date.now(),
      payload: { prompt: 'test' },
    });
    await ch.onAgentEvent!(jid, {
      kind: 'tool_use',
      runId: 'run-def',
      timestamp: Date.now(),
      payload: { tool: 'Read', args: {}, toolUseId: 'tu-2' },
    });
    expect(getActiveCards()).toHaveLength(1);

    await ch.onAgentEvent!(jid, {
      kind: 'final',
      runId: 'run-def',
      timestamp: Date.now(),
      payload: { text: 'done', usage: null },
    });
    expect(getActiveCards()).toHaveLength(0);

    restoreEnv(origEnv);
  });

  it('patches active cards as interrupted on disconnect', async () => {
    const { ch, mockPatch } = makeChannel();
    const jid = 'feishu:oc_test789';

    await ch.onAgentEvent!(jid, {
      kind: 'start',
      runId: 'run-ghi',
      timestamp: Date.now(),
      payload: { prompt: 'test prompt' },
    });
    await ch.onAgentEvent!(jid, {
      kind: 'tool_use',
      runId: 'run-ghi',
      timestamp: Date.now(),
      payload: { tool: 'Bash', args: { command: 'echo hi' }, toolUseId: 'tu-3' },
    });
    expect(getActiveCards()).toHaveLength(1);

    await ch.disconnect();

    const patchCalls = mockPatch.mock.calls;
    const lastPatch = patchCalls[patchCalls.length - 1];
    const cardContent = JSON.parse(lastPatch[0].data.content);
    expect(cardContent.header.template).toBe('red');
    expect(cardContent.header.subtitle.content).toContain('已中断');

    expect(getActiveCards()).toHaveLength(0);

    restoreEnv(origEnv);
  });

  it('cleanupStaleCards patches and deletes leftover DB rows', async () => {
    const { ch, mockPatch } = makeChannel();

    insertActiveCard({
      jid: 'feishu:oc_stale1',
      messageId: 'om_stale_1',
      runId: 'run-old-1',
      startedAt: Date.now() - 60000,
      prompt: 'old task 1',
    });
    insertActiveCard({
      jid: 'feishu:oc_stale2',
      messageId: 'om_stale_2',
      runId: 'run-old-2',
      startedAt: Date.now() - 120000,
      prompt: 'old task 2',
    });

    await (ch as any).cleanupStaleCards();

    expect(mockPatch).toHaveBeenCalledTimes(2);
    for (const call of mockPatch.mock.calls) {
      const content = JSON.parse(call[0].data.content);
      expect(content.header.template).toBe('red');
      expect(content.header.subtitle.content).toContain('已中断');
    }
    expect(getActiveCards()).toHaveLength(0);

    restoreEnv(origEnv);
  });

  it('cleanupStaleCards tolerates patch failures', async () => {
    const { ch } = makeChannel();
    (ch as any).client.im.message.patch = vi
      .fn()
      .mockRejectedValue(new Error('message deleted'));

    insertActiveCard({
      jid: 'feishu:oc_gone',
      messageId: 'om_gone',
      runId: 'run-gone',
      startedAt: Date.now() - 60000,
    });

    await (ch as any).cleanupStaleCards();
    expect(getActiveCards()).toHaveLength(0);

    restoreEnv(origEnv);
  });
});
