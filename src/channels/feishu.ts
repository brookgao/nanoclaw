import * as lark from '@larksuiteoapi/node-sdk';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel, NewMessage } from '../types.js';
import { logger } from '../logger.js';
import { readEnvFile } from '../env.js';

const JID_PREFIX = 'feishu:';

type Domain = 'feishu' | 'lark';

export class FeishuChannel implements Channel {
  public readonly name = 'feishu';
  private client: any;
  private ws: any;
  private connected = false;
  private botOpenId: string | null = null;

  // Dedup for WS reconnect replay.
  private seenMessageIds = new Set<string>();
  private seenOrder: string[] = [];
  private readonly DEDUP_CAP = 500;

  constructor(
    private appId: string,
    private appSecret: string,
    private opts: ChannelOpts,
    private domain: Domain = 'feishu',
  ) {
    const baseDomain =
      domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
    this.client = new lark.Client({ appId, appSecret, domain: baseDomain, disableTokenCache: false });
    this.ws = new lark.WSClient({ appId, appSecret, domain: baseDomain });
  }

  private remember(id: string): boolean {
    if (this.seenMessageIds.has(id)) return false;
    this.seenMessageIds.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > this.DEDUP_CAP) {
      const evicted = this.seenOrder.shift()!;
      this.seenMessageIds.delete(evicted);
    }
    return true;
  }

  // Exposed for tests; also called from WS event handler.
  handleEvent(payload: any): void {
    const ev = payload?.event;
    if (!ev?.message) return;
    const m = ev.message;

    // 1) Self-filter: drop non-user senders (app / bot echo).
    const senderType: string = ev.sender?.sender_type ?? '';
    const senderOpenId: string = ev.sender?.sender_id?.open_id ?? '';
    if (senderType !== 'user') {
      logger.debug({ senderType }, '[feishu] drop non-user sender');
      return;
    }
    if (this.botOpenId && senderOpenId === this.botOpenId) {
      logger.debug('[feishu] drop self-message');
      return;
    }

    // 2) Dedup on message_id.
    if (!this.remember(m.message_id)) {
      logger.debug({ message_id: m.message_id }, '[feishu] dedup hit');
      return;
    }

    // 3) Only text.
    if (m.message_type !== 'text') {
      logger.debug({ message_type: m.message_type }, '[feishu] ignore non-text');
      return;
    }

    let text = '';
    try {
      text = JSON.parse(m.content)?.text ?? '';
    } catch {
      logger.warn({ content: m.content }, '[feishu] malformed content');
      return;
    }

    const chatId: string = m.chat_id;
    const chatType: string = m.chat_type;
    const mentions: Array<{ key?: string; id?: { open_id?: string } }> = m.mentions ?? [];

    if (chatType === 'p2p') {
      this.deliver(chatId, m.message_id, senderOpenId, text, payload.header?.create_time, false);
      return;
    }

    if (chatType === 'group') {
      if (!this.botOpenId) {
        logger.debug('[feishu] group msg before botOpenId resolved, ignored');
        return;
      }
      const botMention = mentions.find((x) => x.id?.open_id === this.botOpenId);
      if (!botMention) {
        logger.debug({ chatId }, '[feishu] group msg without @bot, ignored');
        return;
      }
      let cleaned = text;
      if (botMention.key) {
        cleaned = cleaned.split(botMention.key).join('').trim();
      }
      this.deliver(chatId, m.message_id, senderOpenId, cleaned, payload.header?.create_time, true);
      return;
    }
  }

  private deliver(
    chatId: string,
    messageId: string,
    senderOpenId: string,
    content: string,
    createTime: string | undefined,
    isGroup: boolean,
  ): void {
    const jid = `${JID_PREFIX}${chatId}`;
    const ts = createTime
      ? new Date(Number(createTime)).toISOString()
      : new Date().toISOString();
    this.opts.onChatMetadata(jid, ts, undefined, 'feishu', isGroup);
    const msg: NewMessage = {
      id: messageId,
      chat_jid: jid,
      sender: senderOpenId,
      sender_name: senderOpenId,
      content,
      timestamp: ts,
    };
    this.opts.onMessage(jid, msg);
  }

  async connect(): Promise<void> {
    // Resolve bot open_id via REST (SDK has no typed `bot.info.get` in v1.60).
    try {
      const res: any = await this.client.request({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
      });
      this.botOpenId =
        res?.data?.bot?.open_id ?? res?.bot?.open_id ?? null;
      logger.info({ botOpenId: this.botOpenId }, '[feishu] bot info resolved');
    } catch (err) {
      this.botOpenId = null;
      logger.warn(
        { err: (err as Error).message },
        '[feishu] failed to resolve bot open_id',
      );
    }

    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        this.handleEvent({
          event: data,
          header: { create_time: String(Date.now()) },
        });
      },
    });

    // WSClient.start returns a promise that resolves once connected.
    await this.ws.start({ eventDispatcher: dispatcher });
    this.connected = true;
    logger.info('[feishu] WS connected');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.ownsJid(jid)) {
      throw new Error(`FeishuChannel cannot send to non-feishu jid: ${jid}`);
    }
    const chatId = jid.slice(JID_PREFIX.length);
    try {
      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
    } catch (err) {
      logger.error(
        { err: (err as Error).message, chatId },
        '[feishu] send failed',
      );
      // Swallow: orchestrator stays alive.
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(JID_PREFIX);
  }

  async disconnect(): Promise<void> {
    try {
      (this.ws as any).close?.();
    } catch {
      /* noop */
    }
    this.connected = false;
  }
}

export function createFeishuChannel(opts: ChannelOpts): Channel | null {
  // Project convention: read .env via readEnvFile (secrets not loaded into process.env).
  // Fall back to process.env for tests that set env vars directly.
  const fileEnv = readEnvFile(['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_DOMAIN']);
  const appId = fileEnv.FEISHU_APP_ID || process.env.FEISHU_APP_ID;
  const appSecret = fileEnv.FEISHU_APP_SECRET || process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) return null;
  const domainRaw = fileEnv.FEISHU_DOMAIN || process.env.FEISHU_DOMAIN;
  const domain: Domain = domainRaw === 'lark' ? 'lark' : 'feishu';
  logger.info({ domain }, '[feishu] channel enabled');
  return new FeishuChannel(appId, appSecret, opts, domain);
}

registerChannel('feishu', createFeishuChannel);
