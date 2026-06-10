/**
 * Approval bridge: detect user approval messages in onMessage and write a
 * file marker that host-guard validates before `gh pr create` / `gh api
 * .../pulls` / `curl .../pulls`. Closes the soft-rule loophole exposed by
 * PR #3175 (Andy skipped writing-plans/critic and went straight to PR).
 *
 * Threat model: defends against LLM SOFTLY skipping the gate; does NOT
 * defend against LLM actively forging marker files (host-mode = same uid).
 * Commit-log audit + prompt rules cover the forge case.
 *
 * Design (v2 — folded plan-critic feedback):
 *   - Consumable: hook renames .json → .consumed.json on match. One approval
 *     unlocks exactly one PR-create call. (critic C3)
 *   - Atomic write: writeApproval uses .tmp + rename.
 *   - TTL: 30 min. GC happens on every write to bound storage.
 *   - replyToText param accepted but NOT required (critic I6: stricter
 *     reply-gate too friction-heavy for v1; keyword whitelist is the gate).
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const APPROVALS_SUBDIR = '.approvals';
const TTL_MS = 30 * 60 * 1000; // 30 min — fresh window for PR-create
const GC_AFTER_MS = 60 * 60 * 1000; // delete files 1h past TTL

// Anchored on `^` so the keyword must START the message. Avoids matching
// "我之前说过按 plan 改了" type retrospective references.
const PLAN_APPROVAL_PATTERNS: RegExp[] = [
  /^按\s?plan\s?(改|实施|做|来)/i,
  /^这个?\s?plan\s?(行|可以|ok)/i,
  /^plan\s?(approved?|批准|通过)/i,
  /^go\s?ahead\b/i,
  /^实施吧/,
  /^开始(写|做|实施|动手)/,
];

export interface ApprovalCheckResult {
  matched: boolean;
  kind: 'plan' | 'dota';
}

export function checkApprovalKeywords(
  text: string,
  _replyToText?: string,
): ApprovalCheckResult {
  const trimmed = text.trim();
  for (const re of PLAN_APPROVAL_PATTERNS) {
    if (re.test(trimmed)) {
      return { matched: true, kind: 'plan' };
    }
  }
  return { matched: false, kind: 'plan' };
}

export interface WriteApprovalOpts {
  kind: 'plan' | 'dota';
  matchedText: string;
  matchedMessageId: string;
  matchedSender: string;
}

export function writeApproval(
  groupDir: string,
  opts: WriteApprovalOpts,
): string {
  const dir = path.join(groupDir, APPROVALS_SUBDIR);
  fs.mkdirSync(dir, { recursive: true });

  gcExpiredApprovals(groupDir);

  const now = new Date();
  const ttl = new Date(now.getTime() + TTL_MS);
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const rand = crypto.randomBytes(3).toString('hex');
  const filename = `${stamp}-${rand}.json`;
  const payload = {
    kind: opts.kind,
    approved_at: now.toISOString(),
    matched_text: opts.matchedText,
    matched_message_id: opts.matchedMessageId,
    matched_sender: opts.matchedSender,
    ttl_until: ttl.toISOString(),
  };

  const finalPath = path.join(dir, filename);
  const tmpPath = `${finalPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
  fs.renameSync(tmpPath, finalPath); // atomic on same fs
  return filename;
}

/**
 * Returns the path to a fresh (non-expired, non-consumed) approval file,
 * or null if none exists. The hook is expected to consume the file
 * (`consumeApproval`) after using it — one approval = one PR-create call.
 */
export function findFreshApproval(groupDir: string): string | null {
  const dir = path.join(groupDir, APPROVALS_SUBDIR);
  let files: string[];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json') && !f.endsWith('.consumed.json'));
  } catch {
    return null;
  }
  const now = Date.now();
  for (const f of files) {
    const full = path.join(dir, f);
    try {
      const data = JSON.parse(fs.readFileSync(full, 'utf-8'));
      const ttl = new Date(data.ttl_until).getTime();
      if (Number.isFinite(ttl) && now < ttl) return full;
    } catch {
      continue;
    }
  }
  return null;
}

export function hasFreshApproval(groupDir: string): boolean {
  return findFreshApproval(groupDir) !== null;
}

export function consumeApproval(filePath: string): void {
  // Atomic rename — the next findFreshApproval skips .consumed.json files
  // since we only glob .json (not .consumed.json).
  const consumedPath = filePath.replace(/\.json$/, '.consumed.json');
  fs.renameSync(filePath, consumedPath);
}

export function gcExpiredApprovals(groupDir: string): number {
  const dir = path.join(groupDir, APPROVALS_SUBDIR);
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const now = Date.now();
  let removed = 0;
  for (const f of files) {
    const full = path.join(dir, f);
    try {
      // GC consumed files older than 1h past their TTL
      if (f.endsWith('.consumed.json') || f.endsWith('.tmp')) {
        const stat = fs.statSync(full);
        if (now - stat.mtimeMs > GC_AFTER_MS) {
          fs.unlinkSync(full);
          removed++;
        }
        continue;
      }
      if (f.endsWith('.json')) {
        const data = JSON.parse(fs.readFileSync(full, 'utf-8'));
        const ttl = new Date(data.ttl_until).getTime();
        if (Number.isFinite(ttl) && now > ttl + GC_AFTER_MS) {
          fs.unlinkSync(full);
          removed++;
        }
      }
    } catch {
      continue;
    }
  }
  return removed;
}
