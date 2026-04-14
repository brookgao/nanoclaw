import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getChannelFactory } from './registry.js';

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

function makeOpts(overrides: Partial<{ onMessage: any; onChatMetadata: any }> = {}) {
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
    header: { event_type: 'im.message.receive_v1', create_time: '1700000000000' },
    event: {
      sender: {
        sender_id: { open_id: overrides.sender_id ?? 'ou_user1' },
        sender_type: overrides.sender_type ?? 'user',
      },
      message: {
        message_id: overrides.message_id ?? `om_${Math.random().toString(36).slice(2)}`,
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
    const ch = getChannelFactory('feishu')!(makeOpts({ onMessage, onChatMetadata }))! as any;

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

  it('ignores non-text message types', () => {
    const onMessage = vi.fn();
    const ch = getChannelFactory('feishu')!(makeOpts({ onMessage }))! as any;
    ch.handleEvent(makeEvent({ msg_type: 'image' }));
    expect(onMessage).not.toHaveBeenCalled();
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

  it('calls im.message.create with chat_id and text payload', async () => {
    const ch = getChannelFactory('feishu')!(makeOpts())! as any;
    const createSpy = vi
      .fn()
      .mockResolvedValue({ code: 0, data: { message_id: 'om_x' } });
    ch.client = { im: { message: { create: createSpy } } };

    await ch.sendMessage('feishu:oc_g1', 'hello world');

    expect(createSpy).toHaveBeenCalledTimes(1);
    const call = createSpy.mock.calls[0][0];
    expect(call.params.receive_id_type).toBe('chat_id');
    expect(call.data.receive_id).toBe('oc_g1');
    expect(call.data.msg_type).toBe('text');
    expect(JSON.parse(call.data.content).text).toBe('hello world');
  });

  it('throws informative error for non-feishu jid', async () => {
    const ch = getChannelFactory('feishu')!(makeOpts())!;
    await expect(ch.sendMessage('telegram:123', 'x')).rejects.toThrow(/feishu/);
  });

  it('logs and swallows API errors without throwing', async () => {
    const ch = getChannelFactory('feishu')!(makeOpts())! as any;
    ch.client = {
      im: { message: { create: vi.fn().mockRejectedValue(new Error('429 rate limit')) } },
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
