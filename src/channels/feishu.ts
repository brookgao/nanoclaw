import * as lark from '@larksuiteoapi/node-sdk';
import { extname } from 'path';
import { registerChannel, ChannelOpts } from './registry.js';
import { AgentEvent, Channel, NewMessage } from '../types.js';
import { logger } from '../logger.js';
import { readEnvFile } from '../env.js';
import { stripInternalTags } from '../router.js';
import { TokenUsage, formatTokenFooter } from '../token-footer.js';
import { insertActiveCard, deleteActiveCard, getActiveCards } from '../db.js';
import {
  ZOMBIE_SWEEP_INTERVAL_MS,
  ZOMBIE_CARD_THRESHOLD_MS,
} from '../config.js';
import {
  processImageKeys,
  type FailReason,
  type ImageAttachment,
} from '../image.js';

const JID_PREFIX = 'feishu:';

const TEXT_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.csv',
  '.xml',
  '.html',
  '.htm',
  '.css',
  '.js',
  '.ts',
  '.jsx',
  '.tsx',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.rb',
  '.sh',
  '.sql',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.env',
  '.log',
  '.svg',
]);
const FILE_MAX_BYTES = 500 * 1024;

// --- Interactive card streaming ---

interface ToolEvent {
  tool: string;
  args: Record<string, any>;
  toolUseId: string;
  status: 'running' | 'done' | 'error';
  resultPreview?: string; // truncated output from tool_result event
}

interface CardSession {
  runId: string;
  messageId: string;
  startedAt: number;
  prompt: string;
  toolEvents: ToolEvent[];
  finalText?: string;
  tokenFooter?: string;
  debounceTimer?: ReturnType<typeof setTimeout>;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  pendingPatch: boolean;
  // When false, buildCard omits the tool-calls section and tokenFooter.
  // Sourced from RegisteredGroup.containerConfig.cardVerbose at session creation.
  verbose: boolean;
}

function _formatToolEntry(ev: ToolEvent): string {
  const icon =
    ev.status === 'running' ? '⏳' : ev.status === 'done' ? '✓' : '✗';
  let detail = '';
  if (ev.args) {
    const cmd = ev.args.command ?? ev.args.cmd;
    const file =
      ev.args.file_path ?? ev.args.path ?? ev.args.pattern ?? ev.args.query;
    if (cmd) detail = String(cmd).slice(0, 80);
    else if (file) detail = String(file).slice(0, 80);
  }
  const name = ev.tool || 'unknown';
  return detail ? `${icon} ${name} \`${detail}\`` : `${icon} ${name}`;
}

// Extract user's actual message from the formatted prompt (strip XML wrapper)
function extractUserMessage(prompt: string): string {
  // Prompt format: <context.../>\n<messages>\n<message sender="..." time="...">TEXT</message>\n</messages>
  // Extract content from the last <message>...</message> tag, or last </m ...>...</m> tag
  const msgMatch = prompt.match(
    /<(?:message|m)[^>]*>([^<]+)<\/(?:message|m)>/g,
  );
  if (msgMatch) {
    // Get last message's content
    const last = msgMatch[msgMatch.length - 1];
    const content = last.replace(/<[^>]+>/g, '').trim();
    if (content) return content.slice(0, 200);
  }
  // Fallback: strip all XML tags
  const stripped = prompt
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.slice(0, 200);
}

// Last N tools get full collapsible panels (call + result). Older are compact summary.
const MAX_PANEL_TOOLS = 15;
const MAX_ARG_CHARS = 300;
const MAX_RESULT_CHARS = 600;

// Build a single collapsible_panel element for one tool event
function buildToolPanel(ev: ToolEvent): object {
  const icon =
    ev.status === 'running' ? '⏳' : ev.status === 'done' ? '✓' : '✗';
  const name = ev.tool || 'unknown';

  // Header summary (what shows when collapsed)
  let headerDetail = '';
  const cmd = ev.args?.command ?? ev.args?.cmd;
  const file =
    ev.args?.file_path ?? ev.args?.path ?? ev.args?.pattern ?? ev.args?.query;
  if (cmd) headerDetail = String(cmd).slice(0, 80);
  else if (file) headerDetail = String(file).slice(0, 80);
  const headerText = headerDetail
    ? `${icon} ${name} \`${headerDetail}\``
    : `${icon} ${name}`;

  // Body (shows when expanded)
  const bodyElements: object[] = [];
  const argsStr = JSON.stringify(ev.args ?? {}, null, 2);
  const argsTrunc =
    argsStr.length > MAX_ARG_CHARS
      ? argsStr.slice(0, MAX_ARG_CHARS) + '\n...(truncated)'
      : argsStr;
  bodyElements.push({
    tag: 'markdown',
    content: '**参数**\n```json\n' + argsTrunc + '\n```',
  });

  if (ev.resultPreview) {
    const resultTrunc =
      ev.resultPreview.length > MAX_RESULT_CHARS
        ? ev.resultPreview.slice(0, MAX_RESULT_CHARS) + '\n...(truncated)'
        : ev.resultPreview;
    // Escape backtick sequences that would break the code fence
    const safeResult = resultTrunc.replace(/`{3,}/g, (m) =>
      '`'.repeat(m.length).replace(/`/g, '\\`'),
    );
    bodyElements.push({
      tag: 'markdown',
      content: '**结果**\n```\n' + safeResult + '\n```',
    });
  } else if (ev.status === 'running') {
    bodyElements.push({ tag: 'markdown', content: '_运行中，暂无结果_' });
  }

  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: { tag: 'markdown', content: headerText },
      vertical_align: 'center',
      icon: {
        tag: 'standard_icon',
        token: 'down-small-ccm_outlined',
        size: '12px 12px',
      },
    },
    elements: bodyElements,
  };
}

// Build Feishu interactive card v2 JSON from session state
function buildCard(session: CardSession): object {
  const isFinal = session.finalText !== undefined;
  const elapsedMs = Date.now() - session.startedAt;
  const elapsed =
    elapsedMs >= 60000
      ? `${(elapsedMs / 60000).toFixed(1)}min`
      : `${(elapsedMs / 1000).toFixed(1)}s`;
  const subtitle = isFinal ? `已完成 (${elapsed})` : `运行中… (${elapsed})`;
  const template = isFinal ? 'green' : 'blue';
  const promptPreview = extractUserMessage(session.prompt);

  const elements: object[] = [
    { tag: 'markdown', content: `**任务**\n> ${promptPreview}` },
  ];

  // Concise mode (default): skip tool-calls section + tokenFooter.
  // Verbose mode (containerConfig.cardVerbose=true): show full progress detail.
  if (session.verbose) {
    elements.push({ tag: 'hr' });
    const tools = session.toolEvents;
    if (tools.length === 0) {
      elements.push({ tag: 'markdown', content: '**工具调用**\n_（暂无）_' });
    } else if (isFinal) {
      // Completed: one-line summary grouped by tool type
      const groups = new Map<string, number>();
      for (const e of tools) {
        const n = e.tool || 'unknown';
        groups.set(n, (groups.get(n) || 0) + 1);
      }
      const summary = Array.from(groups.entries())
        .map(([n, c]) => (c > 1 ? `${n} ×${c}` : n))
        .join(', ');
      elements.push({
        tag: 'markdown',
        content: `**工具调用** (共 ${tools.length} 个): ${summary}`,
      });
    } else {
      // Running: compact one-line entries so user sees live progress
      const toolLines = tools.map((ev) => _formatToolEntry(ev)).join('\n');
      elements.push({
        tag: 'markdown',
        content: `**工具调用** (共 ${tools.length} 个)\n${toolLines}`,
      });
    }
  }

  if (isFinal) {
    elements.push({ tag: 'hr' });
    if (session.finalText) {
      const MAX_BODY = 9000;
      const truncated = session.finalText.length > MAX_BODY;
      const body =
        session.finalText.slice(0, MAX_BODY) +
        (truncated ? '\n\n_[内容过长，已截断]_' : '');
      const content =
        session.verbose && session.tokenFooter
          ? `${body}\n\n${session.tokenFooter}`
          : body;
      elements.push({ tag: 'markdown', content });
    } else if (session.verbose && session.tokenFooter) {
      elements.push({ tag: 'markdown', content: session.tokenFooter });
    }
  }

  return {
    schema: '2.0',
    header: {
      title: { tag: 'plain_text', content: '阿飞' },
      subtitle: { tag: 'plain_text', content: subtitle },
      template,
    },
    body: { elements },
  };
}

function buildInterruptedCard(session: {
  prompt: string;
  startedAt: number;
  toolEvents: ToolEvent[];
}): object {
  const elapsedMs = Date.now() - session.startedAt;
  const elapsed =
    elapsedMs >= 60000
      ? `${(elapsedMs / 60000).toFixed(1)}min`
      : `${(elapsedMs / 1000).toFixed(1)}s`;
  const promptPreview = extractUserMessage(session.prompt);

  const elements: object[] = [
    { tag: 'markdown', content: `**任务**\n> ${promptPreview}` },
    { tag: 'hr' },
  ];

  const tools = session.toolEvents;
  if (tools.length > 0) {
    const groups = new Map<string, number>();
    for (const e of tools) {
      const n = e.tool || 'unknown';
      groups.set(n, (groups.get(n) || 0) + 1);
    }
    const summary = Array.from(groups.entries())
      .map(([n, c]) => (c > 1 ? `${n} ×${c}` : n))
      .join(', ');
    elements.push({
      tag: 'markdown',
      content: `**工具调用** (共 ${tools.length} 个): ${summary}`,
    });
  }

  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'markdown',
    content: '服务重启，请重新发送消息',
  });

  return {
    schema: '2.0',
    header: {
      title: { tag: 'plain_text', content: '阿飞' },
      subtitle: { tag: 'plain_text', content: `⚠️ 已中断 (${elapsed})` },
      template: 'red',
    },
    body: { elements },
  };
}

type Domain = 'feishu' | 'lark';

// Wrap markdown text in a minimal interactive card so Feishu renders
// headings, fenced code blocks, horizontal rules and lists natively.
export function buildMarkdownCard(md: string): object {
  return {
    schema: '2.0',
    body: { elements: [{ tag: 'markdown', content: md }] },
  };
}

type PostSegment =
  | { tag: 'text'; text: string }
  | { tag: 'at'; user_id: string }
  | { tag: 'img'; image_key: string }
  | { tag: string; [k: string]: unknown };

type PostContent = { title?: string; content: PostSegment[][] };

type FeishuMention = {
  key?: string;
  id?: { open_id?: string };
  name?: string;
};

export type ParsedInbound = {
  text: string;
  imageKeys: string[];
  botMentioned: boolean;
  fileKey?: string;
  fileName?: string;
};

const MAX_IMAGES_PER_MESSAGE = 5;
const IMAGE_ONLY_PLACEHOLDER = '[图片]';

export function parseInbound(
  m: {
    message_type: string;
    content: string;
    mentions?: FeishuMention[];
  },
  botOpenId: string | null,
): ParsedInbound | null {
  const mentions = m.mentions ?? [];
  const botMentioned =
    !!botOpenId && mentions.some((x) => x.id?.open_id === botOpenId);

  if (m.message_type === 'file') {
    try {
      const c = JSON.parse(m.content);
      const fileKey: string | undefined = c?.file_key;
      const fileName: string = c?.file_name ?? 'unknown';
      if (!fileKey) return null;
      return { text: '', imageKeys: [], botMentioned, fileKey, fileName };
    } catch {
      return null;
    }
  }

  if (m.message_type === 'text') {
    try {
      const text = JSON.parse(m.content)?.text ?? '';
      return { text, imageKeys: [], botMentioned };
    } catch {
      return null;
    }
  }

  if (m.message_type === 'image') {
    try {
      const key = JSON.parse(m.content)?.image_key ?? '';
      if (!key) return null;
      // Inject placeholder so downstream DB filter (content != '') lets it through.
      return { text: IMAGE_ONLY_PLACEHOLDER, imageKeys: [key], botMentioned };
    } catch {
      return null;
    }
  }

  if (m.message_type !== 'post') return null;

  let parsed: PostContent;
  try {
    parsed = JSON.parse(m.content);
  } catch {
    return null;
  }

  const paragraphs = parsed.content ?? [];
  const textLines: string[] = [];
  const imageKeys: string[] = [];

  for (const segs of paragraphs) {
    const parts: string[] = [];
    for (const seg of segs) {
      if (seg.tag === 'text' && typeof (seg as any).text === 'string') {
        parts.push((seg as any).text);
      } else if (seg.tag === 'at' && typeof (seg as any).user_id === 'string') {
        const uid = (seg as any).user_id as string;
        if (uid === botOpenId) continue;
        const mention = mentions.find((x) => x.id?.open_id === uid);
        const name = mention?.name ?? uid;
        parts.push(`@${name}`);
      } else if (
        seg.tag === 'img' &&
        typeof (seg as any).image_key === 'string'
      ) {
        imageKeys.push((seg as any).image_key);
      }
      // unknown tags: silently ignored
    }
    const line = parts.join('').trim();
    if (line) textLines.push(line);
  }

  const originalImageCount = imageKeys.length;
  const truncatedKeys = imageKeys.slice(0, MAX_IMAGES_PER_MESSAGE);
  let text = textLines.join('\n');
  if (originalImageCount > MAX_IMAGES_PER_MESSAGE) {
    text =
      `${text}\n[系统: 本条消息含 ${originalImageCount} 张图，仅处理前 ${MAX_IMAGES_PER_MESSAGE} 张]`.trim();
  }

  if (!text && truncatedKeys.length === 0) return null;
  // Inject placeholder so downstream DB filter (content != '') lets image-only posts through.
  if (!text && truncatedKeys.length > 0) text = IMAGE_ONLY_PLACEHOLDER;

  return { text, imageKeys: truncatedKeys, botMentioned };
}

// Format a quoted parent message into a human-readable block we append to the
// child message's text. Used to surface "the message you replied to" into the
// prompt, so the agent sees the doc card / quoted text / etc. that the user
// is referring to.
export function formatQuotedParent(
  parent:
    | {
        msg_type?: string;
        body?: { content?: string };
        mentions?: FeishuMention[];
      }
    | null
    | undefined,
  parentSenderName: string,
  botOpenId: string | null,
  maxLen: number = 500,
): string {
  if (!parent) return '';
  const msgType = parent.msg_type ?? '';
  const rawContent = parent.body?.content ?? '';

  // Try the structured parser first for types we already understand.
  const parsed = parseInbound(
    {
      message_type: msgType,
      content: rawContent,
      mentions: parent.mentions ?? [],
    },
    botOpenId,
  );

  let inner: string;
  if (parsed && parsed.text) {
    inner = parsed.text;
  } else {
    // share_chat / wiki / interactive / system / etc — surface the raw content
    // so the agent can find tokens, URLs, doc IDs without us having to know
    // every flavor of feishu card.
    inner = `(${msgType}) ${rawContent}`;
  }

  if (inner.length > maxLen) inner = inner.slice(0, maxLen) + '…';

  const label = parentSenderName ? `引用 @${parentSenderName} 的消息: ` : '引用: ';
  return `\n\n[${label}${inner}]`;
}

function buildFailureMessage(
  failures: Array<{ key: string; reason: FailReason }>,
  totalImageCount: number,
): string {
  const failCount = failures.length;
  if (totalImageCount > 1 && failCount < totalImageCount) {
    return `🖼️ ${totalImageCount} 张图有 ${failCount} 张没收到，能把这些重发下吗？`;
  }
  const reason = failures[0]?.reason ?? 'download_failed';
  if (reason === 'too_large') return `🖼️ 图太大(>10MB)，能压缩后重发吗？`;
  if (reason === 'bad_format')
    return `🖼️ 这张图我读不了（可能损坏或格式不支持），能换一张发吗？`;
  const reasonZh: Record<FailReason, string> = {
    expired: '过期',
    timeout: '超时',
    too_large: '过大',
    bad_format: '格式',
    invalid_key: '过期',
    download_failed: '网络异常',
  };
  return `🖼️ 图没收到(${reasonZh[reason]})，能重发吗？`;
}

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

  // Interactive card sessions: one card per active agent run per chat
  private cardSessions = new Map<string, CardSession>();
  private zombieSweepTimer?: NodeJS.Timeout;
  private readonly CARD_DEBOUNCE_MS = 500;

  // Cache open_id → display name to avoid repeated API calls
  private nameCache = new Map<string, string>();

  constructor(
    private appId: string,
    private appSecret: string,
    private opts: ChannelOpts,
    private domain: Domain = 'feishu',
  ) {
    const baseDomain =
      domain === 'lark'
        ? 'https://open.larksuite.com'
        : 'https://open.feishu.cn';
    this.client = new lark.Client({
      appId,
      appSecret,
      domain: baseDomain,
      disableTokenCache: false,
    });
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

  private async resolveSenderName(openId: string): Promise<string> {
    const cached = this.nameCache.get(openId);
    if (cached) return cached;
    try {
      const resp = await this.client.contact.user.get({
        path: { user_id: openId },
        params: { user_id_type: 'open_id' },
      });
      const name = resp?.data?.user?.name;
      if (name) {
        this.nameCache.set(openId, name);
        return name;
      }
    } catch (err) {
      logger.debug(
        { openId, err: (err as Error).message },
        '[feishu] resolveSenderName failed, using open_id',
      );
    }
    return openId;
  }

  // Exposed for tests; also called from WS event handler.
  async handleEvent(payload: any): Promise<void> {
    const ev = payload?.event;
    if (!ev?.message) return;
    const m = ev.message;

    // 1) Self-filter: drop non-user / self
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

    // 2) Dedup
    if (!this.remember(m.message_id)) {
      logger.debug({ message_id: m.message_id }, '[feishu] dedup hit');
      return;
    }

    // 3) Parse
    const parsed = parseInbound(m, this.botOpenId);
    if (!parsed) {
      logger.debug(
        { message_type: m.message_type },
        '[feishu] parseInbound dropped',
      );
      return;
    }

    const chatId: string = m.chat_id;
    const chatType: string = m.chat_type;

    // 4) Group chat gate: require @bot mention (preserving requiresTrigger/isMain override)
    if (chatType === 'group') {
      if (!this.botOpenId) {
        logger.debug('[feishu] group msg before botOpenId resolved, ignored');
        return;
      }
      const jid = `${JID_PREFIX}${chatId}`;
      const groups = this.opts.registeredGroups();
      const group = groups[jid];
      const skipMentionCheck =
        group?.requiresTrigger === false || group?.isMain;
      if (!parsed.botMentioned && !skipMentionCheck) {
        logger.debug({ chatId }, '[feishu] group msg without @bot, ignored');
        return;
      }
    } else if (chatType !== 'p2p') {
      logger.debug({ chatType }, '[feishu] unknown chat type, dropped');
      return;
    }

    // 5) Strip bot-mention display text in group chat
    let cleanedText = parsed.text;
    if (chatType !== 'p2p') {
      const mentions: Array<{ key?: string; id?: { open_id?: string } }> =
        m.mentions ?? [];
      const botMention = mentions.find((x) => x.id?.open_id === this.botOpenId);
      if (botMention?.key) {
        cleanedText = cleanedText.split(botMention.key).join('').trim();
      }
    }

    // 6) Process images if present
    let attachments: ImageAttachment[] = [];
    if (parsed.imageKeys.length > 0) {
      this.reactAck(m.message_id); // 👀 immediately
      const result = await processImageKeys(
        parsed.imageKeys,
        (k) => this.downloadImage(m.message_id, k),
        logger,
      );
      if (result.failures.length > 0) {
        this.reactFail(m.message_id);
        const failMsg = buildFailureMessage(
          result.failures,
          parsed.imageKeys.length,
        );
        try {
          await this.sendMessage(`${JID_PREFIX}${chatId}`, failMsg);
        } catch (err) {
          logger.warn(
            { err: (err as Error).message },
            '[feishu] send failure notice errored',
          );
        }
        logger.warn(
          { msg_id: m.message_id, failures: result.failures },
          '[feishu] image failure',
        );
        return;
      }
      attachments = result.attachments;
      logger.info(
        {
          msg_id: m.message_id,
          image_count: attachments.length,
          total_base64_bytes: attachments.reduce(
            (s, a) => s + a.base64.length,
            0,
          ),
          est_input_tokens: attachments.length * 1568,
          feishu_keys: attachments.map((a) => a.sourceKey),
        },
        '[feishu] image attached',
      );
    } else {
      this.reactAck(m.message_id); // 👀 for pure-text path (existing behavior preserved)
    }

    // 7) Resolve parent message: handle replied-to context (text/wiki cards)
    //    AND file attachments shared via reply. Fetched once for both paths.
    let fileKey = parsed.fileKey;
    let fileName = parsed.fileName;
    let fileMessageId = m.message_id;
    let replyToInfo:
      | { messageId: string; content: string; senderName: string }
      | undefined;

    if (m.parent_id) {
      try {
        const parentRes: any = await this.client.request({
          method: 'GET',
          url: `/open-apis/im/v1/messages/${m.parent_id}`,
        });
        const parentMsg = parentRes?.data?.items?.[0];
        if (parentMsg) {
          // File path (preserved): pull file_key from a replied-to file message.
          if (
            !fileKey &&
            parentMsg.msg_type === 'file' &&
            parentMsg.body?.content
          ) {
            const pc = JSON.parse(parentMsg.body.content);
            if (pc.file_key) {
              fileKey = pc.file_key;
              fileName = pc.file_name ?? 'unknown';
              fileMessageId = m.parent_id;
            }
          }

          // Non-file parents: surface quoted content (text / post / wiki card /
          // share_chat / etc.) so the agent sees what the user is referring to.
          if (parentMsg.msg_type !== 'file') {
            const parentSenderId = parentMsg.sender?.id ?? '';
            const parentSenderName = parentSenderId
              ? await this.resolveSenderName(parentSenderId).catch(
                  () => parentSenderId,
                )
              : '';
            const block = formatQuotedParent(
              parentMsg,
              parentSenderName,
              this.botOpenId,
            );
            if (block) {
              cleanedText += block;
              const innerParsed = parseInbound(
                {
                  message_type: parentMsg.msg_type ?? '',
                  content: parentMsg.body?.content ?? '',
                  mentions: parentMsg.mentions ?? [],
                },
                this.botOpenId,
              );
              const innerText =
                innerParsed?.text ||
                `(${parentMsg.msg_type ?? 'unknown'}) ${parentMsg.body?.content ?? ''}`;
              replyToInfo = {
                messageId: m.parent_id,
                content: innerText,
                senderName: parentSenderName,
              };
            }
          }
        }
      } catch (err) {
        logger.debug(
          { err: (err as Error).message, parentId: m.parent_id },
          '[feishu] failed to fetch parent message',
        );
      }
    }

    // 8) Process file attachment if present
    if (fileKey) {
      const ext = extname(fileName ?? '').toLowerCase();
      const isTextExt = TEXT_EXTENSIONS.has(ext) || ext === '';
      if (isTextExt) {
        try {
          const buf = await this.downloadFile(fileMessageId, fileKey);
          let fileText = buf.toString('utf-8');
          const sizeKB = (buf.length / 1024).toFixed(1);
          const replacements = (fileText.match(/�/g) ?? []).length;
          if (replacements > fileText.length * 0.05) {
            cleanedText += `\n\n[📎 ${fileName} (${sizeKB} KB) - 不支持的文件类型，请转为文本格式发送]`;
          } else {
            if (buf.length > FILE_MAX_BYTES) {
              fileText = fileText.slice(0, FILE_MAX_BYTES);
              fileText += `\n[... 文件已截断，原始大小 ${sizeKB} KB，仅显示前 500 KB]`;
            }
            cleanedText += `\n\n---📎 ${fileName} (${sizeKB} KB)---\n${fileText}\n---文件结束---`;
          }
        } catch (err) {
          this.reactFail(m.message_id);
          const failMsg = `📎 文件下载失败: ${fileName}`;
          try {
            await this.sendMessage(`${JID_PREFIX}${chatId}`, failMsg);
          } catch (sendErr) {
            logger.warn(
              { err: (sendErr as Error).message },
              '[feishu] send file failure notice errored',
            );
          }
          logger.warn(
            { err: (err as Error).message, fileName },
            '[feishu] file download failed',
          );
          return;
        }
      } else {
        cleanedText += `\n\n[📎 ${fileName} - 不支持的文件类型，请转为文本格式发送]`;
      }
      if (!cleanedText.trim()) cleanedText = `[文件: ${fileName}]`;
    }

    // 8) Resolve sender name and deliver
    const senderName = await this.resolveSenderName(senderOpenId);
    this.deliver(
      chatId,
      m.message_id,
      senderOpenId,
      senderName,
      cleanedText,
      payload.header?.create_time,
      chatType !== 'p2p',
      attachments,
      replyToInfo,
    );
  }

  private deliver(
    chatId: string,
    messageId: string,
    senderOpenId: string,
    senderName: string,
    content: string,
    createTime: string | undefined,
    isGroup: boolean,
    images: ImageAttachment[] = [],
    replyTo?: { messageId: string; content: string; senderName: string },
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
      sender_name: senderName,
      content,
      timestamp: ts,
      images: images.length > 0 ? images : undefined,
      reply_to_message_id: replyTo?.messageId,
      reply_to_message_content: replyTo?.content,
      reply_to_sender_name: replyTo?.senderName,
    };
    this.opts.onMessage(jid, msg);
  }

  private reactAck(messageId: string): void {
    // Fire-and-forget: acknowledge receipt with an emoji reaction. Best-effort.
    this.client.im.messageReaction
      .create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: 'OK' } },
      })
      .catch((err: Error) => {
        logger.debug(
          { err: err.message, messageId },
          '[feishu] ack reaction failed',
        );
      });
  }

  private reactFail(messageId: string): void {
    // Fire-and-forget: negative reaction to signal download failure. Best-effort.
    this.client.im.messageReaction
      .create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: 'CRY' } },
      })
      .catch((err: Error) => {
        logger.debug(
          { err: err.message, messageId },
          '[feishu] reactFail ignored',
        );
      });
  }

  async downloadFile(messageId: string, fileKey: string): Promise<Buffer> {
    const res: any = await this.client.request(
      {
        method: 'GET',
        url: `/open-apis/im/v1/messages/${messageId}/resources/${fileKey}`,
        params: { type: 'file' },
        responseType: 'arraybuffer',
      },
      { maxContentLength: 10 * 1024 * 1024, timeout: 15000 },
    );
    if (Buffer.isBuffer(res)) return res;
    if (res instanceof ArrayBuffer) return Buffer.from(res);
    if (res?.data) return Buffer.from(res.data);
    return Buffer.from(res);
  }

  async downloadImage(messageId: string, imageKey: string): Promise<Buffer> {
    const res: any = await this.client.request(
      {
        method: 'GET',
        url: `/open-apis/im/v1/messages/${messageId}/resources/${imageKey}`,
        params: { type: 'image' },
        responseType: 'arraybuffer',
      },
      { maxContentLength: 10 * 1024 * 1024, timeout: 8000 },
    );
    // client.request may return raw ArrayBuffer/Buffer or { data: ArrayBuffer }
    if (Buffer.isBuffer(res)) return res;
    if (res instanceof ArrayBuffer) return Buffer.from(res);
    if (res?.data) return Buffer.from(res.data);
    return Buffer.from(res);
  }

  async connect(): Promise<void> {
    // Resolve bot open_id via REST (SDK has no typed `bot.info.get` in v1.60).
    try {
      const res: any = await this.client.request({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
      });
      this.botOpenId = res?.data?.bot?.open_id ?? res?.bot?.open_id ?? null;
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
        logger.info(
          {
            chat_id: data?.message?.chat_id,
            chat_type: data?.message?.chat_type,
            msg_type: data?.message?.message_type,
          },
          '[feishu] RAW im.message.receive_v1',
        );
        this.handleEvent({
          event: data,
          header: { create_time: String(Date.now()) },
        }).catch((err) =>
          logger.error(
            { err: (err as Error).message },
            '[feishu] handleEvent unhandled error',
          ),
        );
      },
    });

    // WSClient.start returns a promise that resolves once connected.
    await this.ws.start({ eventDispatcher: dispatcher });
    this.connected = true;
    logger.info('[feishu] WS connected');
  }

  async sendMessage(
    jid: string,
    text: string,
    options?: { suppressForCard?: boolean; plainText?: boolean },
  ): Promise<void> {
    if (!this.ownsJid(jid)) {
      throw new Error(`FeishuChannel cannot send to non-feishu jid: ${jid}`);
    }
    if (options?.suppressForCard && this.cardSessions.get(jid)?.messageId) {
      logger.debug(
        { jid },
        '[feishu] sendMessage suppressed: card session active',
      );
      return;
    }
    const chatId = jid.slice(JID_PREFIX.length);

    // Plain text mode: supports <at user_id="...">name</at> mentions.
    // Used by scheduled tasks where card rendering strips at-mentions.
    const msgType = options?.plainText ? 'text' : 'interactive';
    const content = options?.plainText
      ? JSON.stringify({ text })
      : JSON.stringify(buildMarkdownCard(text));

    try {
      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: msgType,
          content,
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

  async createChat(args: {
    name: string;
    description: string;
  }): Promise<{ chat_id: string }> {
    let res: any;
    try {
      res = await this.client.im.chat.create({
        data: {
          name: args.name,
          description: args.description,
          chat_mode: 'group',
          chat_type: 'private',
        },
        params: { user_id_type: 'open_id' },
      });
    } catch (err) {
      logger.error(
        { err: (err as Error).message, name: args.name },
        '[feishu] createChat failed',
      );
      throw err;
    }
    const chat_id = res?.data?.chat_id ?? res?.chat_id;
    if (!chat_id) throw new Error('im.chat.create returned no chat_id');
    return { chat_id };
  }

  async inviteMembers(chatId: string, openIds: string[]): Promise<void> {
    try {
      await this.client.im.chatMembers.create({
        path: { chat_id: chatId },
        params: { member_id_type: 'open_id' },
        data: { id_list: openIds },
      });
    } catch (err) {
      logger.error(
        { err: (err as Error).message, chatId, count: openIds.length },
        '[feishu] inviteMembers failed',
      );
      throw err;
    }
  }

  private async schedulePatch(jid: string, immediate = false): Promise<void> {
    const session = this.cardSessions.get(jid);
    if (!session) return;

    // Clear existing timer
    if (session.debounceTimer) {
      clearTimeout(session.debounceTimer);
      session.debounceTimer = undefined;
    }

    const doPatch = async () => {
      const s = this.cardSessions.get(jid);
      if (!s) return;
      s.pendingPatch = false;
      const card = buildCard(s);
      try {
        await this.client.im.message.patch({
          path: { message_id: s.messageId },
          data: { content: JSON.stringify(card) },
        });
      } catch (err) {
        logger.warn(
          { err: (err as Error).message, jid },
          '[feishu] card patch failed',
        );
      }
    };

    if (immediate) {
      session.pendingPatch = true;
      await doPatch();
    } else {
      if (session.pendingPatch) return; // already scheduled
      session.pendingPatch = true;
      session.debounceTimer = setTimeout(() => {
        doPatch().catch((err) =>
          logger.warn({ err }, '[feishu] debounced patch error'),
        );
      }, this.CARD_DEBOUNCE_MS);
    }
  }

  async onAgentEvent(jid: string, event: AgentEvent): Promise<void> {
    if (!this.ownsJid(jid)) return;
    const chatId = jid.slice(JID_PREFIX.length);

    if (event.kind === 'start') {
      const prompt = String(event.payload.prompt ?? '');

      // Scheduled tasks only send their final text output — no execution card.
      if (prompt.startsWith('[SCHEDULED TASK')) {
        logger.info(
          { jid, runId: event.runId },
          '[feishu] scheduled task, skipping card session',
        );
        return;
      }

      // Cancel any existing session, but don't create the Feishu card yet —
      // only create when we see the first tool_use. Zero-tool answers (e.g. 2+2=4)
      // fall through to plain sendMessage() below, avoiding a useless card shell.
      const existing = this.cardSessions.get(jid);

      // A duplicate start with the same runId comes from SDK auto-compact
      // emitting a fresh system/init inside the same agent run. Resetting
      // would orphan the live Feishu card and wipe tool history, so keep
      // the session intact and let subsequent tool_use events patch the
      // existing card.
      if (existing && existing.runId === event.runId) {
        logger.debug(
          { jid, runId: event.runId },
          '[feishu] ignoring duplicate start for same runId (likely SDK compact)',
        );
        return;
      }

      if (existing?.debounceTimer) clearTimeout(existing.debounceTimer);
      if (existing?.heartbeatTimer) clearInterval(existing.heartbeatTimer);

      const verbose =
        this.opts.registeredGroups()[jid]?.containerConfig?.cardVerbose ??
        false;
      this.cardSessions.set(jid, {
        runId: event.runId,
        messageId: '', // empty until first tool_use lazy-creates it
        startedAt: event.timestamp,
        prompt,
        toolEvents: [],
        pendingPatch: false,
        verbose,
      });
      return;
    }

    const session = this.cardSessions.get(jid);
    if (!session || session.runId !== event.runId) return;

    if (event.kind === 'tool_use') {
      session.toolEvents.push({
        tool: String(event.payload.tool ?? ''),
        args: (event.payload.args as Record<string, any>) ?? {},
        toolUseId: String(event.payload.toolUseId ?? ''),
        status: 'running',
      });
      // Lazy-create the card on first tool_use. Subsequent tool_uses patch.
      if (!session.messageId) {
        await this.createCard(jid, chatId, session);
      } else {
        await this.schedulePatch(jid);
      }
    } else if (event.kind === 'tool_result') {
      const toolUseId = String(event.payload.toolUseId ?? '');
      const status =
        event.payload.status === 'error' ? 'error' : ('done' as const);
      const preview = event.payload.textPreview
        ? String(event.payload.textPreview)
        : undefined;
      const entry = session.toolEvents.find((e) => e.toolUseId === toolUseId);
      if (entry) {
        entry.status = status;
        entry.resultPreview = preview;
      }
      if (session.messageId) await this.schedulePatch(jid);
    } else if (event.kind === 'final') {
      const text = stripInternalTags(String(event.payload.text ?? ''));
      const usage = event.payload.usage as TokenUsage | undefined;

      if (!session.messageId) {
        // Zero-tool run — don't send here; the existing stdout callback in
        // index.ts already sends the final text as a plain message.
        // Sending here too would cause duplicate messages.
        if (session.heartbeatTimer) clearInterval(session.heartbeatTimer);
        this.cardSessions.delete(jid);
        logger.info(
          { jid },
          '[feishu] zero-tool run, deferring to stdout path',
        );
        return;
      }

      session.finalText = text;
      session.tokenFooter = usage ? formatTokenFooter(usage) : undefined;
      for (const e of session.toolEvents) {
        if (e.status === 'running') e.status = 'done';
      }

      const hasSendMessage = session.toolEvents.some((e) =>
        e.tool.includes('send_message'),
      );
      if (!text && hasSendMessage && session.messageId) {
        this.client.im.message
          .delete({ path: { message_id: session.messageId } })
          .catch((err: Error) =>
            logger.debug(
              { err: err.message },
              '[feishu] delete redundant card failed',
            ),
          );
      } else {
        await this.schedulePatch(jid, true);
      }

      if (session.heartbeatTimer) clearInterval(session.heartbeatTimer);
      this.cardSessions.delete(jid);
      deleteActiveCard(jid);
      logger.info({ jid }, '[feishu] card session completed');
    }
  }

  async onSessionEnded(jid: string): Promise<void> {
    const session = this.cardSessions.get(jid);
    if (!session) {
      // No live session — either zero-tool run (already cleaned), or the
      // `final` event already ran the normal cleanup path. Nothing to do.
      return;
    }

    if (session.messageId) {
      try {
        const card = buildInterruptedCard(session);
        await this.client.im.message.patch({
          path: { message_id: session.messageId },
          data: { content: JSON.stringify(card) },
        });
      } catch (err) {
        logger.warn(
          { err: (err as Error).message, jid, messageId: session.messageId },
          '[feishu] interrupted card patch failed in onSessionEnded',
        );
      }
    }

    if (session.heartbeatTimer) clearInterval(session.heartbeatTimer);
    if (session.debounceTimer) clearTimeout(session.debounceTimer);
    this.cardSessions.delete(jid);
    deleteActiveCard(jid);
    logger.info({ jid }, '[feishu] session force-ended (onSessionEnded)');
  }

  private async createCard(
    jid: string,
    chatId: string,
    session: CardSession,
  ): Promise<void> {
    const card = buildCard(session);
    try {
      const res: any = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });
      const messageId: string = res?.data?.message_id ?? res?.message_id ?? '';
      if (!messageId) {
        logger.warn(
          { jid, res },
          '[feishu] card create returned no message_id',
        );
        return;
      }
      session.messageId = messageId;
      insertActiveCard({
        jid,
        messageId,
        runId: session.runId,
        startedAt: session.startedAt,
        prompt: extractUserMessage(session.prompt),
      });
      logger.info({ jid, messageId }, '[feishu] card session started');
      // Heartbeat: refresh timer in header every 15s so user knows agent is alive
      // even during long single-tool runs (e.g. pip install, test suite).
      session.heartbeatTimer = setInterval(() => {
        const current = this.cardSessions.get(jid);
        if (!current || current.runId !== session.runId) return;
        this.schedulePatch(jid).catch((err) =>
          logger.warn({ err }, '[feishu] heartbeat patch error'),
        );
      }, 15000);
    } catch (err) {
      logger.error(
        { err: (err as Error).message, jid },
        '[feishu] card create failed',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(JID_PREFIX);
  }

  async cleanupStaleCards(): Promise<void> {
    const staleCards = getActiveCards().filter((c) =>
      c.jid.startsWith(JID_PREFIX),
    );
    if (staleCards.length === 0) return;

    for (const card of staleCards) {
      const interruptedCard = buildInterruptedCard({
        prompt: card.prompt ?? '',
        startedAt: card.started_at,
        toolEvents: [],
      });
      try {
        await this.client.im.message.patch({
          path: { message_id: card.message_id },
          data: { content: JSON.stringify(interruptedCard) },
        });
      } catch (err) {
        logger.warn(
          {
            err: (err as Error).message,
            jid: card.jid,
            messageId: card.message_id,
          },
          '[feishu] stale card patch failed (message may have been deleted)',
        );
      }
      deleteActiveCard(card.jid);
    }

    logger.info(
      { count: staleCards.length },
      '[feishu] cleaned up stale cards from previous process',
    );
  }

  async sweepZombieCards(): Promise<void> {
    const now = Date.now();
    const zombies = getActiveCards().filter(
      (c) =>
        c.jid.startsWith(JID_PREFIX) &&
        !this.cardSessions.has(c.jid) &&
        now - c.started_at > ZOMBIE_CARD_THRESHOLD_MS,
    );

    if (zombies.length === 0) return;

    for (const card of zombies) {
      const interruptedCard = buildInterruptedCard({
        prompt: card.prompt ?? '',
        startedAt: card.started_at,
        toolEvents: [],
      });
      try {
        await this.client.im.message.patch({
          path: { message_id: card.message_id },
          data: { content: JSON.stringify(interruptedCard) },
        });
      } catch (err) {
        logger.warn(
          { err: (err as Error).message, jid: card.jid },
          '[feishu] zombie sweep patch failed',
        );
      }
      deleteActiveCard(card.jid);
    }

    logger.info(
      { count: zombies.length },
      '[feishu] zombie sweep cleaned stale cards',
    );
  }

  startZombieSweep(): void {
    if (this.zombieSweepTimer) return;
    if (ZOMBIE_SWEEP_INTERVAL_MS <= 0) return;
    this.zombieSweepTimer = setInterval(() => {
      this.sweepZombieCards().catch((err) =>
        logger.warn(
          { err: (err as Error).message },
          '[feishu] zombie sweep tick error',
        ),
      );
    }, ZOMBIE_SWEEP_INTERVAL_MS);
    logger.info(
      { intervalMs: ZOMBIE_SWEEP_INTERVAL_MS },
      '[feishu] zombie sweep timer started',
    );
  }

  stopZombieSweep(): void {
    if (this.zombieSweepTimer) {
      clearInterval(this.zombieSweepTimer);
      this.zombieSweepTimer = undefined;
    }
  }

  async disconnect(): Promise<void> {
    this.stopZombieSweep();
    for (const [jid, session] of this.cardSessions) {
      if (session.debounceTimer) clearTimeout(session.debounceTimer);
      if (session.heartbeatTimer) clearInterval(session.heartbeatTimer);
      if (session.messageId) {
        const card = buildInterruptedCard(session);
        try {
          await this.client.im.message.patch({
            path: { message_id: session.messageId },
            data: { content: JSON.stringify(card) },
          });
        } catch (err) {
          logger.warn(
            { err: (err as Error).message, jid },
            '[feishu] interrupted card patch failed on shutdown',
          );
        }
      }
      // Always drop the DB row, even for sessions that never created a card
      // (zero-tool runs interrupted mid-flight, etc.). Otherwise the row
      // leaks past shutdown.
      deleteActiveCard(jid);
    }
    this.cardSessions.clear();

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
  const fileEnv = readEnvFile([
    'FEISHU_APP_ID',
    'FEISHU_APP_SECRET',
    'FEISHU_DOMAIN',
  ]);
  const appId = fileEnv.FEISHU_APP_ID || process.env.FEISHU_APP_ID;
  const appSecret = fileEnv.FEISHU_APP_SECRET || process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) return null;
  const domainRaw = fileEnv.FEISHU_DOMAIN || process.env.FEISHU_DOMAIN;
  const domain: Domain = domainRaw === 'lark' ? 'lark' : 'feishu';
  logger.info({ domain }, '[feishu] channel enabled');
  return new FeishuChannel(appId, appSecret, opts, domain);
}

registerChannel('feishu', createFeishuChannel);
