import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import type {
  CreateTopicGroupReq,
  CreateTopicGroupResp,
  RegisteredGroup,
} from './types.js';

export interface CreateTopicGroupDeps {
  feishuChannel: {
    createChat(args: {
      name: string;
      description: string;
    }): Promise<{ chat_id: string }>;
    inviteMembers(chatId: string, openIds: string[]): Promise<void>;
    sendMessage(jid: string, text: string): Promise<void>;
  };
  setRegisteredGroup: (jid: string, group: RegisteredGroup) => void;
  onGroupRegistered: (jid: string, group: RegisteredGroup) => void;
  sourceGroupJid: (folder: string) => string | null;
  lookupRequesterOpenId: (jid: string) => string | null;
  projectRoot: string;
  ensureOneCliAgent?: (jid: string, group: RegisteredGroup) => void;
}

export async function handleCreateTopicGroup(
  req: CreateTopicGroupReq,
  sourceGroupFolder: string,
  deps: CreateTopicGroupDeps,
): Promise<CreateTopicGroupResp> {
  if (!isValidGroupFolder(req.folder)) {
    throw new Error(`invalid folder: ${req.folder}`);
  }

  const srcJid = deps.sourceGroupJid(sourceGroupFolder);
  if (!srcJid) {
    throw new Error(`cannot resolve source chat for ${sourceGroupFolder}`);
  }
  const requesterOpenId = deps.lookupRequesterOpenId(srcJid);
  if (!requesterOpenId) {
    throw new Error('no recent user message found to identify requester');
  }

  const warnings: string[] = [];

  // Step a — fatal
  const { chat_id } = await deps.feishuChannel.createChat({
    name: req.name,
    description: req.topic_description,
  });

  // Step b — non-fatal
  let user_invited = false;
  try {
    await deps.feishuChannel.inviteMembers(chat_id, [requesterOpenId]);
    user_invited = true;
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    warnings.push(`invite_failed: ${m}`);
    logger.warn({ chat_id, err: m }, '[sync-ipc] inviteMembers failed');
  }

  // Step c — non-fatal
  let db_registered = false;
  try {
    const jid = `feishu:${chat_id}`;
    const group: RegisteredGroup = {
      name: req.name,
      folder: req.folder,
      trigger: `@${ASSISTANT_NAME}`,
      added_at: new Date().toISOString(),
      requiresTrigger: false,
    };
    deps.setRegisteredGroup(jid, group);
    deps.onGroupRegistered(jid, group);
    db_registered = true;

    // Ensure OneCLI agent entry exists for credential routing.
    // Fire-and-forget inside ensureOneCliAgent; safe to call.
    if (deps.ensureOneCliAgent) {
      try {
        deps.ensureOneCliAgent(jid, group);
      } catch (err) {
        warnings.push(
          `onecli_ensure_failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    warnings.push(`db_register_failed: ${m}`);
    logger.warn({ chat_id, err: m }, '[sync-ipc] DB register failed');
  }

  // Steps d+e — non-fatal
  let folder_initialized = false;
  try {
    const groupDir = path.join(deps.projectRoot, 'groups', req.folder);
    fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
    const tmplPath = path.join(
      deps.projectRoot,
      'groups',
      'global',
      'CLAUDE.md',
    );
    const mdPath = path.join(groupDir, 'CLAUDE.md');
    if (!fs.existsSync(mdPath) && fs.existsSync(tmplPath)) {
      const tmpl = fs.readFileSync(tmplPath, 'utf-8');
      const appended = tmpl + `\n\n## Topic\n\n${req.topic_description}\n`;
      fs.writeFileSync(mdPath, appended);
    }
    folder_initialized = true;
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    warnings.push(`folder_init_failed: ${m}`);
    logger.warn(
      { folder: req.folder, err: m },
      '[sync-ipc] folder init failed',
    );
  }

  // Step f — Welcome message in new chat (non-fatal)
  try {
    const welcome = `🎉 新群就绪\n\n**话题**：${req.topic_description}\n\n直接发消息即可，不用 @ 我。`;
    await deps.feishuChannel.sendMessage(`feishu:${chat_id}`, welcome);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    warnings.push(`welcome_failed: ${m}`);
    logger.warn({ chat_id, err: m }, '[sync-ipc] welcome message send failed');
  }

  return {
    chat_id,
    folder: req.folder,
    user_invited,
    db_registered,
    folder_initialized,
    warnings,
  };
}
