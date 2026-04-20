import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getChannelFactory } from './registry.js';
import { parseInbound } from './feishu.js';

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
        content: JSON.stringify({ text: overrides.text ?? 'hello' }),
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
    expect(r).toEqual({ text: '', imageKeys: ['img_v3_abc'], botMentioned: false });
  });

  it('post: text + img + at(bot) → text preserved, bot at omitted, image collected, botMentioned=true', () => {
    const content = JSON.stringify({
      title: '',
      content: [[
        { tag: 'text', text: 'look at this ' },
        { tag: 'at', user_id: botOpenId },
        { tag: 'img', image_key: 'img_k1' },
      ]],
    });
    const r = parseInbound(
      {
        message_type: 'post',
        content,
        mentions: [{ key: '@_user_1', id: { open_id: botOpenId }, name: 'Andy' }],
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
      content: [[
        { tag: 'text', text: 'hey ' },
        { tag: 'at', user_id: 'ou_other' },
        { tag: 'text', text: ' look' },
      ]],
    });
    const r = parseInbound(
      {
        message_type: 'post',
        content,
        mentions: [{ key: '@_user_2', id: { open_id: 'ou_other' }, name: '小明' }],
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
    const segs = Array.from({ length: 7 }, (_, i) => ({ tag: 'img', image_key: `k${i}` }));
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
      content: [[
        { tag: 'text', text: 'before ' },
        { tag: 'emoji', emoji_type: 'SMILE' },
        { tag: 'text', text: 'after' },
      ]],
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
