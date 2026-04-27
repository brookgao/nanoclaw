import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { runHostAgent } from './host-runner.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export function hasUnpromotedEntries(learningsPath: string): boolean {
  if (!fs.existsSync(learningsPath)) return false;
  const content = fs.readFileSync(learningsPath, 'utf-8');
  return content
    .split('\n')
    .some(
      (line) =>
        /^\[\d{4}-\d{2}-\d{2}\]/.test(line) && !line.startsWith('[promoted]'),
    );
}

export function shouldPromote(memoryDir: string): boolean {
  return fs.existsSync(path.join(memoryDir, '.needs-promotion'));
}

export function clearPromotionFlag(memoryDir: string): void {
  const flagPath = path.join(memoryDir, '.needs-promotion');
  try {
    fs.unlinkSync(flagPath);
  } catch {
    /* ignore */
  }
}

export async function spawnDistiller(
  group: RegisteredGroup,
  chatJid: string,
): Promise<void> {
  const groupDir = resolveGroupFolderPath(group.folder);
  const globalWikiDir = path.join(GROUPS_DIR, 'global', 'wiki');

  logger.info({ group: group.folder }, 'Spawning knowledge distiller');

  clearPromotionFlag(path.join(groupDir, 'memory'));

  try {
    await runHostAgent(
      {
        ...group,
        containerConfig: {
          ...group.containerConfig,
        },
      },
      {
        prompt: `Run the /knowledge-distiller skill now. Write wiki pages to ${globalWikiDir} (read-write). The shared wiki at ${globalWikiDir} contains existing wiki content.`,
        groupFolder: group.folder,
        chatJid,
        isMain: group.isMain === true,
        isScheduledTask: true,
        assistantName: 'Distiller',
      },
      () => {},
    );
    logger.info({ group: group.folder }, 'Knowledge distiller completed');
  } catch (err) {
    logger.error(
      {
        group: group.folder,
        err: err instanceof Error ? err.message : String(err),
      },
      'Knowledge distiller failed',
    );
  }
}
