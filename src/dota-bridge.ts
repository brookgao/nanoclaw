import fs from 'fs';
import path from 'path';
import os from 'os';

export interface DotaBridgeResult {
  handled: boolean;
  confirmText?: string;
}

interface PendingDecision {
  decisionId: string;
  sessionId: string;
  phase: string;
  question: string;
  createdAt: string;
  project: string;
}

const DEFAULT_DECISIONS_DIR = path.join(os.homedir(), '.claude', 'dota-decisions');
const COOLDOWN_MS = 10_000;

let lastReplyAt = 0;
let lastDecisionId = '';

export function _resetForTest(): void {
  lastReplyAt = 0;
  lastDecisionId = '';
}

export function checkDotaDecision(
  messageText: string,
  replyToText: string | undefined,
  decisionsDir: string = DEFAULT_DECISIONS_DIR,
): DotaBridgeResult {
  const pendingDir = path.join(decisionsDir, 'pending');
  const repliesDir = path.join(decisionsDir, 'replies');

  // Cooldown check
  if (Date.now() - lastReplyAt < COOLDOWN_MS) {
    return { handled: true, confirmText: '已收到，忽略重复消息' };
  }

  // Read pending files
  let pendingFiles: string[];
  try {
    pendingFiles = fs.readdirSync(pendingDir).filter((f) => f.endsWith('.json'));
  } catch {
    return { handled: false };
  }

  if (pendingFiles.length === 0) {
    return { handled: false };
  }

  // Load all pending decisions
  const pendings: { file: string; data: PendingDecision }[] = [];
  for (const file of pendingFiles) {
    try {
      const data: PendingDecision = JSON.parse(
        fs.readFileSync(path.join(pendingDir, file), 'utf-8'),
      );
      pendings.push({ file, data });
    } catch {
      continue;
    }
  }

  if (pendings.length === 0) {
    return { handled: false };
  }

  // Match: if replyToText contains [ref:xxx], use that decisionId
  let matched: (typeof pendings)[0] | undefined;

  if (replyToText) {
    const refMatch = replyToText.match(/\[ref:(dota-\d+)\]/);
    if (refMatch) {
      matched = pendings.find((p) => p.data.decisionId === refMatch[1]);
    }
  }

  // Fallback: FIFO — oldest by createdAt
  if (!matched) {
    pendings.sort(
      (a, b) =>
        new Date(a.data.createdAt).getTime() -
        new Date(b.data.createdAt).getTime(),
    );
    matched = pendings[0];
  }

  // Write reply file
  fs.mkdirSync(repliesDir, { recursive: true });
  const reply = {
    decisionId: matched.data.decisionId,
    reply: messageText,
    replySource: 'feishu',
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(repliesDir, `${matched.data.decisionId}.json`),
    JSON.stringify(reply, null, 2),
  );

  // Delete pending file
  try {
    fs.unlinkSync(path.join(pendingDir, matched.file));
  } catch {
    // ignore
  }

  // Set cooldown
  lastReplyAt = Date.now();
  lastDecisionId = matched.data.decisionId;

  return {
    handled: true,
    confirmText: `✓ 已收到回复，dota 流程继续 (${matched.data.decisionId})`,
  };
}
