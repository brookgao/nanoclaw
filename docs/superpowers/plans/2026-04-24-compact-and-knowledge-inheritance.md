# Compact Threshold & Knowledge Inheritance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lower compact thresholds to prevent 420K-token context bloat, and build a knowledge distillation pipeline so agent groups share learnings via a global wiki.

**Architecture:** Two independent features. Part A updates DB rows for compact thresholds (no code changes). Part B adds learning extraction in the pre-compact hook, a global wiki mount in container-runner, a knowledge-distiller container skill, and three trigger mechanisms (threshold flag, daily scheduler, manual command).

**Tech Stack:** TypeScript, vitest, SQLite (better-sqlite3), Docker bind mounts, Claude Agent SDK hooks

---

### Task 1: Seed compact thresholds into registered_groups DB

**Files:**
- Create: `scripts/seed-compact-thresholds.ts`

This is a one-time script that reads each group's current `container_config` JSON and merges in `autoCompactWindow` if missing.

- [ ] **Step 1: Write the seed script**

```typescript
// scripts/seed-compact-thresholds.ts
import Database from 'better-sqlite3';
import path from 'path';

const STORE_DIR = path.join(process.cwd(), 'store');
const DB_PATH = path.join(STORE_DIR, 'messages.db');

const THRESHOLDS: Record<string, number> = {
  feishu_main: 80000,
  feishu_dm: 80000,
  'feishu_pm-doc-quality': 50000,
  'feishu_pm-openspec-quality': 50000,
  'feishu_langgraph-pm': 50000,
};
const DEFAULT_THRESHOLD = 60000;

const db = new Database(DB_PATH);

interface GroupRow {
  jid: string;
  folder: string;
  name: string;
  container_config: string | null;
}

const rows = db.prepare('SELECT jid, folder, name, container_config FROM registered_groups').all() as GroupRow[];

const update = db.prepare('UPDATE registered_groups SET container_config = ? WHERE jid = ?');

for (const row of rows) {
  const config = row.container_config ? JSON.parse(row.container_config) : {};
  if (config.autoCompactWindow != null) {
    console.log(`${row.folder}: already has autoCompactWindow=${config.autoCompactWindow}, skipping`);
    continue;
  }
  const threshold = THRESHOLDS[row.folder] ?? DEFAULT_THRESHOLD;
  config.autoCompactWindow = threshold;
  update.run(JSON.stringify(config), row.jid);
  console.log(`${row.folder}: set autoCompactWindow=${threshold}`);
}

db.close();
console.log('Done.');
```

- [ ] **Step 2: Run the script**

Run: `npx tsx scripts/seed-compact-thresholds.ts`

Expected output:
```
feishu_main: set autoCompactWindow=80000
feishu_dm: set autoCompactWindow=80000
feishu_langgraph-fix: set autoCompactWindow=60000
feishu_harness: set autoCompactWindow=60000
feishu_pipeline: set autoCompactWindow=60000
feishu_langgraph-pm: set autoCompactWindow=50000
feishu_newcomer-price: set autoCompactWindow=60000
feishu_pm-openspec-quality: set autoCompactWindow=50000
feishu_pm-doc-quality: set autoCompactWindow=50000
Done.
```

- [ ] **Step 3: Verify with sqlite3**

Run: `sqlite3 store/messages.db "SELECT folder, json_extract(container_config, '$.autoCompactWindow') FROM registered_groups"`

Expected: Every row has a numeric value.

- [ ] **Step 4: Commit**

```bash
git add scripts/seed-compact-thresholds.ts
git commit -m "feat: seed autoCompactWindow thresholds for all groups"
```

---

### Task 2: Extract learning extraction logic into a testable module

**Files:**
- Create: `container/agent-runner/src/learning-extractor.ts`
- Create: `container/agent-runner/src/learning-extractor.test.ts`

The extraction logic is a pure function: takes an array of `ParsedMessage[]` (already defined in index.ts) and returns structured learnings. Keeping it in a separate file makes it unit-testable without importing the full agent-runner.

- [ ] **Step 1: Write the failing test**

```typescript
// container/agent-runner/src/learning-extractor.test.ts
import { describe, it, expect } from 'vitest';
import { extractLearnings, formatLearningEntry } from './learning-extractor.js';

describe('extractLearnings', () => {
  it('extracts lines containing decision keywords from assistant messages', () => {
    const messages = [
      { role: 'user' as const, content: '为什么这个接口报错了' },
      { role: 'assistant' as const, content: '经过排查，根因是数据库连接池耗尽。解决方案是增加连接池上限到 50。' },
    ];
    const result = extractLearnings(messages);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0]).toContain('根因');
  });

  it('extracts lines following conclusion patterns', () => {
    const messages = [
      { role: 'assistant' as const, content: '分析了三种方案后，\n\n总结：使用 WAL 模式可以解决并发写入问题。' },
    ];
    const result = extractLearnings(messages);
    expect(result.some(l => l.includes('WAL'))).toBe(true);
  });

  it('returns empty array when no learnings found', () => {
    const messages = [
      { role: 'user' as const, content: '你好' },
      { role: 'assistant' as const, content: '你好！有什么可以帮助你的吗？' },
    ];
    const result = extractLearnings(messages);
    expect(result).toEqual([]);
  });

  it('only extracts from assistant messages, not user messages', () => {
    const messages = [
      { role: 'user' as const, content: '结论是什么' },
      { role: 'assistant' as const, content: '请提供更多信息。' },
    ];
    const result = extractLearnings(messages);
    expect(result).toEqual([]);
  });

  it('deduplicates identical extractions', () => {
    const messages = [
      { role: 'assistant' as const, content: '根因是 X。\n再次确认，根因是 X。' },
    ];
    const result = extractLearnings(messages);
    expect(result.length).toBe(1);
  });
});

describe('formatLearningEntry', () => {
  it('formats with date and source', () => {
    const entry = formatLearningEntry('数据库连接池需要增大', 'conversation-debug-db.md');
    expect(entry).toMatch(/^\[\d{4}-\d{2}-\d{2}\]/);
    expect(entry).toContain('数据库连接池需要增大');
    expect(entry).toContain('来源: conversation-debug-db.md');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd container/agent-runner && npx vitest run src/learning-extractor.test.ts`

Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// container/agent-runner/src/learning-extractor.ts

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

const DECISION_KEYWORDS = [
  '结论', '决定', '教训', '发现', '原因是', '解决方案',
  '根因', '要点', '关键', '修复方法', '最佳实践',
];

const CONCLUSION_PATTERNS = [
  /^总结[：:]/m,
  /^所以[，,]/m,
  /^最终[，,]/m,
  /^因此[，,]/m,
  /## (?:结论|要点|总结|教训)/m,
];

export function extractLearnings(messages: ParsedMessage[]): string[] {
  const learnings = new Set<string>();

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;

    const lines = msg.content.split('\n').map(l => l.trim()).filter(Boolean);

    for (const line of lines) {
      if (line.length < 10 || line.length > 500) continue;

      const hasKeyword = DECISION_KEYWORDS.some(kw => line.includes(kw));
      const hasPattern = CONCLUSION_PATTERNS.some(p => p.test(line));

      if (hasKeyword || hasPattern) {
        // Clean up markdown formatting
        const cleaned = line
          .replace(/^#+\s*/, '')
          .replace(/^\*\*(.+)\*\*$/, '$1')
          .replace(/^[-*]\s*/, '');
        if (cleaned.length >= 10) {
          learnings.add(cleaned);
        }
      }
    }
  }

  return [...learnings];
}

export function formatLearningEntry(learning: string, source: string): string {
  const date = new Date().toISOString().split('T')[0];
  return `[${date}] ${learning} | 来源: ${source}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd container/agent-runner && npx vitest run src/learning-extractor.test.ts`

Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/learning-extractor.ts container/agent-runner/src/learning-extractor.test.ts
git commit -m "feat: add learning extraction module for pre-compact hook"
```

---

### Task 3: Integrate learning extraction into pre-compact hook

**Files:**
- Modify: `container/agent-runner/src/index.ts:216-262` (createPreCompactHook)

After the existing transcript archival, add learning extraction + `.needs-promotion` flag.

- [ ] **Step 1: Export `ParsedMessage` and `parseTranscript` from index.ts**

In `container/agent-runner/src/index.ts`, change the `ParsedMessage` interface and `parseTranscript` function from private to exported:

Find:
```typescript
interface ParsedMessage {
```
Replace with:
```typescript
export interface ParsedMessage {
```

Find:
```typescript
function parseTranscript(content: string): ParsedMessage[] {
```
Replace with:
```typescript
export function parseTranscript(content: string): ParsedMessage[] {
```

- [ ] **Step 2: Update learning-extractor.ts to import ParsedMessage**

In `container/agent-runner/src/learning-extractor.ts`, replace the local `ParsedMessage` interface with the import:

Find:
```typescript
interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}
```
Replace with:
```typescript
import type { ParsedMessage } from './index.js';
```

- [ ] **Step 3: Add learning extraction to createPreCompactHook**

In `container/agent-runner/src/index.ts`, add the import at the top (after existing imports):

```typescript
import { extractLearnings, formatLearningEntry } from './learning-extractor.js';
```

Then in `createPreCompactHook()`, after the `log(`Archived conversation to ${filePath}`);` line (line ~253), insert:

```typescript
      // Extract learnings from the conversation and append to session-learnings.md
      const learnings = extractLearnings(messages);
      if (learnings.length > 0) {
        const memoryDir = '/workspace/group/memory';
        fs.mkdirSync(memoryDir, { recursive: true });
        const learningsFile = path.join(memoryDir, 'session-learnings.md');

        // Create file with header if it doesn't exist
        if (!fs.existsSync(learningsFile)) {
          fs.writeFileSync(learningsFile, '# Session Learnings\n\nPost-compact extraction. When 10+ unpromoted entries accumulate, promote to wiki.\n\n');
        }

        const entries = learnings.map(l => formatLearningEntry(l, filename));
        fs.appendFileSync(learningsFile, entries.join('\n') + '\n');
        log(`Extracted ${learnings.length} learnings to session-learnings.md`);

        // Check if promotion threshold reached
        const content = fs.readFileSync(learningsFile, 'utf-8');
        const unpromotedCount = content.split('\n')
          .filter(line => /^\[\d{4}-\d{2}-\d{2}\]/.test(line) && !line.startsWith('[promoted]'))
          .length;
        if (unpromotedCount >= 10) {
          const flagPath = path.join(memoryDir, '.needs-promotion');
          fs.writeFileSync(flagPath, String(unpromotedCount));
          log(`Promotion threshold reached (${unpromotedCount} entries), wrote .needs-promotion flag`);
        }
      }
```

- [ ] **Step 4: Run existing agent-runner tests to verify no regression**

Run: `cd container/agent-runner && npx vitest run`

Expected: All existing tests PASS

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/index.ts container/agent-runner/src/learning-extractor.ts
git commit -m "feat: integrate learning extraction into pre-compact hook"
```

---

### Task 4: Create global wiki directory and knowledge-distiller skill

**Files:**
- Create: `groups/global/wiki/index.md`
- Create: `container/skills/knowledge-distiller/SKILL.md`

- [ ] **Step 1: Create global wiki directory structure**

```bash
mkdir -p groups/global/wiki
```

- [ ] **Step 2: Write global wiki index**

```markdown
<!-- groups/global/wiki/index.md -->
# Global Wiki

Cross-group knowledge base. Auto-populated by the knowledge-distiller skill.

## Groups

_Subdirectories are created automatically as groups promote learnings._
```

- [ ] **Step 3: Write the knowledge-distiller skill**

```markdown
<!-- container/skills/knowledge-distiller/SKILL.md -->
---
name: knowledge-distiller
description: Promote session-learnings to the global wiki. Triggered by user command ("整理知识"), scheduled daily, or when learning count exceeds threshold.
---

# Knowledge Distiller

Promote unpromoted entries from `memory/session-learnings.md` into the shared global wiki at `/workspace/shared-wiki/`.

## Steps

1. Read `memory/session-learnings.md`
2. Collect lines matching `[YYYY-MM-DD]` that do NOT start with `[promoted]`
3. If no unpromoted entries, report "No new learnings to promote" and stop
4. Group related entries by topic similarity
5. For each topic group:
   a. Determine a short topic slug (e.g., `db-connection-pooling`)
   b. Read the group name from the working directory basename
   c. Create or update `/workspace/shared-wiki/<group-name>/<topic-slug>.md` with:
      - `# <Topic Title>`
      - `## Key Points` — bullet list of the distilled learnings
      - `## Sources` — list of `来源:` references from the original entries
   d. If the file already exists, merge new points into it rather than overwriting
6. Update FTS5 index:
   ```bash
   WIKI_DIR="/workspace/shared-wiki"
   WIKI_DB="$WIKI_DIR/wiki.db"
   GROUP=$(basename /workspace/group)
   
   # Create FTS5 table if not exists
   sqlite3 "$WIKI_DB" "CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(path, title, summary, body, source_group, tokenize='porter unicode61');"
   
   # For each wiki page written, upsert into FTS5:
   # sqlite3 "$WIKI_DB" "DELETE FROM wiki_fts WHERE path = '<path>';"
   # sqlite3 "$WIKI_DB" "INSERT INTO wiki_fts(path, title, summary, body, source_group) VALUES (...);"
   ```
7. Mark each promoted entry: prepend `[promoted]` to the line in `session-learnings.md`
8. Delete `.needs-promotion` flag if it exists:
   ```bash
   rm -f memory/.needs-promotion
   ```
9. Report: "Promoted N learnings to wiki under <group-name>/"

## Important

- `/workspace/shared-wiki` must be mounted **read-write** for this skill. If it's read-only, report the error and stop.
- Do NOT delete entries from session-learnings.md — only prepend `[promoted]`.
- Keep wiki pages concise: each page should be < 500 words.
```

- [ ] **Step 4: Commit**

```bash
git add groups/global/wiki/index.md container/skills/knowledge-distiller/SKILL.md
git commit -m "feat: add global wiki structure and knowledge-distiller skill"
```

---

### Task 5: Universal global wiki mount in container-runner

**Files:**
- Modify: `src/container-runner.ts:72-288` (buildVolumeMounts)
- Modify: `src/container-runner.test.ts`

Replace per-group shared-wiki mounts with a single universal mount. The distiller trigger (Task 6) will use an `rw` variant.

- [ ] **Step 1: Write the failing test**

Add a test case to `src/container-runner.test.ts` that verifies the global wiki mount is present for all groups:

```typescript
describe('buildVolumeMounts global wiki', () => {
  it('mounts global wiki readonly for non-main groups', () => {
    // Create the global wiki dir
    fs.mkdirSync('/tmp/nanoclaw-test-groups/global/wiki', { recursive: true });
    
    const group: RegisteredGroup = {
      name: 'Test',
      folder: 'feishu_test',
      trigger: '@Andy',
      added_at: new Date().toISOString(),
    };
    const mounts = buildVolumeMounts(group, false);
    const wikiMount = mounts.find(m => m.containerPath === '/workspace/shared-wiki');
    expect(wikiMount).toBeDefined();
    expect(wikiMount!.readonly).toBe(true);
    expect(wikiMount!.hostPath).toContain('global/wiki');
  });

  it('mounts global wiki readonly for main group', () => {
    fs.mkdirSync('/tmp/nanoclaw-test-groups/global/wiki', { recursive: true });
    
    const group: RegisteredGroup = {
      name: 'Main',
      folder: 'feishu_main',
      trigger: '',
      added_at: new Date().toISOString(),
      isMain: true,
    };
    const mounts = buildVolumeMounts(group, true);
    const wikiMount = mounts.find(m => m.containerPath === '/workspace/shared-wiki');
    expect(wikiMount).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/container-runner.test.ts`

Expected: FAIL — no `/workspace/shared-wiki` mount found

- [ ] **Step 3: Add universal wiki mount to buildVolumeMounts**

In `src/container-runner.ts`, in `buildVolumeMounts()`, add after the global memory directory mount blocks (after the `}` closing the `if (isMain) { ... } else { ... }` block, around line ~146):

```typescript
  // Universal global wiki mount — all groups get read-only access to cross-group knowledge
  const globalWikiDir = path.join(GROUPS_DIR, 'global', 'wiki');
  if (fs.existsSync(globalWikiDir)) {
    mounts.push({
      hostPath: globalWikiDir,
      containerPath: '/workspace/shared-wiki',
      readonly: true,
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/container-runner.test.ts`

Expected: PASS

- [ ] **Step 5: Remove per-group shared-wiki mounts from DB**

The groups feishu_dm, feishu_langgraph-fix, and feishu_harness have `shared-wiki` in their `additionalMounts`. Create a migration script to remove them since the universal mount replaces them:

```typescript
// scripts/remove-per-group-shared-wiki-mounts.ts
import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'store', 'messages.db');
const db = new Database(DB_PATH);

interface GroupRow {
  jid: string;
  folder: string;
  container_config: string | null;
}

const rows = db.prepare('SELECT jid, folder, container_config FROM registered_groups').all() as GroupRow[];
const update = db.prepare('UPDATE registered_groups SET container_config = ? WHERE jid = ?');

for (const row of rows) {
  if (!row.container_config) continue;
  const config = JSON.parse(row.container_config);
  if (!config.additionalMounts) continue;

  const before = config.additionalMounts.length;
  config.additionalMounts = config.additionalMounts.filter(
    (m: { containerPath?: string }) => m.containerPath !== 'shared-wiki'
  );
  const after = config.additionalMounts.length;

  if (before !== after) {
    if (config.additionalMounts.length === 0) delete config.additionalMounts;
    update.run(JSON.stringify(config), row.jid);
    console.log(`${row.folder}: removed shared-wiki mount (${before} -> ${after})`);
  }
}

db.close();
console.log('Done.');
```

Run: `npx tsx scripts/remove-per-group-shared-wiki-mounts.ts`

Expected: feishu_dm, feishu_langgraph-fix, feishu_harness report mount removal.

- [ ] **Step 6: Verify DB change**

Run: `sqlite3 store/messages.db "SELECT folder, container_config FROM registered_groups WHERE folder IN ('feishu_dm','feishu_langgraph-fix','feishu_harness')"`

Expected: No `shared-wiki` in any `additionalMounts` array.

- [ ] **Step 7: Commit**

```bash
git add src/container-runner.ts src/container-runner.test.ts scripts/remove-per-group-shared-wiki-mounts.ts
git commit -m "feat: universal global wiki mount, remove per-group shared-wiki"
```

---

### Task 6: Post-container threshold trigger (spawn distiller)

**Files:**
- Modify: `src/index.ts:393-495` (runAgent function)
- Create: `src/knowledge-promoter.ts`
- Create: `src/knowledge-promoter.test.ts`

After a container exits, check for the `.needs-promotion` flag and spawn a distiller container.

- [ ] **Step 1: Write the failing test**

```typescript
// src/knowledge-promoter.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { hasUnpromotedEntries, shouldPromote } from './knowledge-promoter.js';

describe('hasUnpromotedEntries', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns false when file does not exist', () => {
    expect(hasUnpromotedEntries(path.join(tmp, 'missing.md'))).toBe(false);
  });

  it('returns true when unpromoted entries exist', () => {
    const file = path.join(tmp, 'session-learnings.md');
    fs.writeFileSync(file, '# Session Learnings\n\n[2026-04-24] Some learning | 来源: test.md\n');
    expect(hasUnpromotedEntries(file)).toBe(true);
  });

  it('returns false when all entries are promoted', () => {
    const file = path.join(tmp, 'session-learnings.md');
    fs.writeFileSync(file, '# Session Learnings\n\n[promoted] [2026-04-24] Some learning | 来源: test.md\n');
    expect(hasUnpromotedEntries(file)).toBe(false);
  });
});

describe('shouldPromote', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns true when .needs-promotion flag exists', () => {
    fs.writeFileSync(path.join(tmp, '.needs-promotion'), '12');
    expect(shouldPromote(tmp)).toBe(true);
  });

  it('returns false when no flag exists', () => {
    expect(shouldPromote(tmp)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/knowledge-promoter.test.ts`

Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/knowledge-promoter.ts
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { runContainerAgent } from './container-runner.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export function hasUnpromotedEntries(learningsPath: string): boolean {
  if (!fs.existsSync(learningsPath)) return false;
  const content = fs.readFileSync(learningsPath, 'utf-8');
  return content.split('\n').some(
    line => /^\[\d{4}-\d{2}-\d{2}\]/.test(line) && !line.startsWith('[promoted]')
  );
}

export function shouldPromote(memoryDir: string): boolean {
  return fs.existsSync(path.join(memoryDir, '.needs-promotion'));
}

export function clearPromotionFlag(memoryDir: string): void {
  const flagPath = path.join(memoryDir, '.needs-promotion');
  try { fs.unlinkSync(flagPath); } catch { /* ignore */ }
}

export async function spawnDistiller(group: RegisteredGroup, chatJid: string): Promise<void> {
  const groupDir = resolveGroupFolderPath(group.folder);
  const globalWikiDir = path.join(GROUPS_DIR, 'global', 'wiki');

  logger.info({ group: group.folder }, 'Spawning knowledge distiller');

  // Clear the flag before spawning so concurrent checks don't double-trigger
  clearPromotionFlag(path.join(groupDir, 'memory'));

  try {
    await runContainerAgent(
      {
        ...group,
        containerConfig: {
          ...group.containerConfig,
          // Override shared-wiki to read-write for the distiller
          additionalMounts: [
            ...(group.containerConfig?.additionalMounts ?? []),
            {
              hostPath: globalWikiDir,
              containerPath: 'shared-wiki-rw',
              readonly: false,
            },
          ],
        },
      },
      {
        prompt: 'Run the /knowledge-distiller skill now. Write wiki pages to /workspace/extra/shared-wiki-rw/ (it is mounted read-write). The readonly /workspace/shared-wiki is for reading existing wiki content only.',
        groupFolder: group.folder,
        chatJid,
        isMain: group.isMain === true,
        isScheduledTask: true,
        assistantName: 'Distiller',
      },
      () => {}, // No process tracking needed for fire-and-forget
    );
    logger.info({ group: group.folder }, 'Knowledge distiller completed');
  } catch (err) {
    logger.error(
      { group: group.folder, err: err instanceof Error ? err.message : String(err) },
      'Knowledge distiller failed',
    );
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/knowledge-promoter.test.ts`

Expected: PASS

- [ ] **Step 5: Integrate into runAgent in src/index.ts**

In `src/index.ts`, add the import:

```typescript
import { shouldPromote, spawnDistiller } from './knowledge-promoter.js';
```

In the `runAgent()` function, after the `return 'success';` line at the end of the try block (line ~490), add a post-container check. Replace:

```typescript
    return 'success';
  } catch (err) {
```

With:

```typescript
    // Check for knowledge promotion threshold after successful container exit
    const memoryDir = path.join(resolveGroupFolderPath(group.folder), 'memory');
    if (shouldPromote(memoryDir)) {
      // Fire-and-forget: don't block the message loop
      spawnDistiller(group, chatJid).catch(err =>
        logger.warn({ group: group.name, err }, 'Background distiller failed')
      );
    }

    return 'success';
  } catch (err) {
```

- [ ] **Step 6: Run full test suite**

Run: `npm test`

Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/knowledge-promoter.ts src/knowledge-promoter.test.ts src/index.ts
git commit -m "feat: post-container threshold trigger for knowledge promotion"
```

---

### Task 7: Daily scheduled knowledge promotion

**Files:**
- Modify: `src/task-scheduler.ts`
- Modify: `src/index.ts` (startSchedulerLoop call site)

Add a built-in daily job that iterates all groups and spawns a distiller for each with unpromoted entries.

- [ ] **Step 1: Add daily promotion function to task-scheduler.ts**

In `src/task-scheduler.ts`, add imports:

```typescript
import { GROUPS_DIR } from './config.js';
import { hasUnpromotedEntries, spawnDistiller } from './knowledge-promoter.js';
```

Add the daily promotion function before `startSchedulerLoop()`:

```typescript
let lastPromotionDate = '';

async function runDailyKnowledgePromotion(deps: SchedulerDependencies): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  if (today === lastPromotionDate) return;

  const hour = new Date().getHours();
  if (hour !== 2) return; // Only run at 02:00

  lastPromotionDate = today;
  logger.info('Running daily knowledge promotion');

  const groups = deps.registeredGroups();
  for (const [chatJid, group] of Object.entries(groups)) {
    const learningsPath = path.join(
      resolveGroupFolderPath(group.folder),
      'memory',
      'session-learnings.md',
    );
    if (hasUnpromotedEntries(learningsPath)) {
      logger.info({ group: group.folder }, 'Daily promotion: group has unpromoted entries');
      spawnDistiller(group, chatJid).catch(err =>
        logger.warn({ group: group.folder, err }, 'Daily promotion failed'),
      );
    }
  }
}
```

- [ ] **Step 2: Call daily promotion from the scheduler loop**

In the `loop` function inside `startSchedulerLoop()`, add the daily promotion call at the start of the try block:

Find:
```typescript
    try {
      const dueTasks = getDueTasks();
```

Replace with:
```typescript
    try {
      await runDailyKnowledgePromotion(deps);
      const dueTasks = getDueTasks();
```

- [ ] **Step 3: Add missing path import**

In `src/task-scheduler.ts`, verify `path` is imported. If not, add:

```typescript
import path from 'path';
```

(It's not currently imported — the file uses `resolveGroupFolderPath` but never `path.join` directly. Add the import.)

- [ ] **Step 4: Run tests**

Run: `npm test`

Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/task-scheduler.ts
git commit -m "feat: daily scheduled knowledge promotion at 02:00"
```

---

### Task 8: Manual trigger — CLAUDE.md rules for all groups

**Files:**
- Modify: `groups/global/CLAUDE.md`

Add the manual trigger rule to the global CLAUDE.md (shared by all non-main groups).

- [ ] **Step 1: Add knowledge distiller rule to global CLAUDE.md**

Append to `groups/global/CLAUDE.md`:

```markdown

## 知识整理

当用户说"整理知识"、"promote learnings"、或"知识提炼"时，执行 `/knowledge-distiller` skill。

如果 `/workspace/shared-wiki` 是只读的，回复用户：
> 当前环境只读，无法写入共享 wiki。知识整理需要通过系统自动触发（每日凌晨 2 点或积累满 10 条时自动运行）。

### 搜索共享知识库

在回答问题前，可以搜索共享 wiki 了解其他群的历史经验：

```bash
sqlite3 /workspace/shared-wiki/wiki.db "SELECT path, title, snippet(wiki_fts, 3, '>>>', '<<<', '...', 30) FROM wiki_fts WHERE wiki_fts MATCH '<搜索词>' LIMIT 5;"
```

如果 wiki.db 不存在，直接用 `grep -ri` 搜索 `/workspace/shared-wiki/` 目录。
```

- [ ] **Step 2: Add the same rule to feishu_main's CLAUDE.md**

Feishu_main doesn't load global CLAUDE.md (it IS the main group). Add the same section to `groups/feishu_main/CLAUDE.md` — append the same `## 知识整理` section content at the end of the file.

- [ ] **Step 3: Commit**

```bash
git add groups/global/CLAUDE.md groups/feishu_main/CLAUDE.md
git commit -m "feat: add manual knowledge promotion trigger to CLAUDE.md"
```

---

### Task 9: Create blank session-learnings.md for groups that lack it

**Files:**
- Modify: `src/index.ts:149-194` (registerGroup function)

When a new group is registered, ensure `memory/session-learnings.md` exists.

- [ ] **Step 1: Add session-learnings template to registerGroup**

In `src/index.ts`, in the `registerGroup()` function, after the CLAUDE.md template copy block (after the closing `}` of the `if (!fs.existsSync(groupMdFile))` block around line ~185), add:

```typescript
  // Ensure memory directory and session-learnings.md exist for knowledge pipeline
  const memoryDir = path.join(groupDir, 'memory');
  const learningsFile = path.join(memoryDir, 'session-learnings.md');
  if (!fs.existsSync(learningsFile)) {
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(
      learningsFile,
      '# Session Learnings\n\nPost-compact extraction. When 10+ unpromoted entries accumulate, promote to wiki.\n\n',
    );
    logger.info({ folder: group.folder }, 'Created session-learnings.md template');
  }
```

- [ ] **Step 2: Seed existing groups that lack the file**

```bash
for dir in groups/feishu_*/; do
  mkdir -p "$dir/memory"
  if [ ! -f "$dir/memory/session-learnings.md" ]; then
    echo -e "# Session Learnings\n\nPost-compact extraction. When 10+ unpromoted entries accumulate, promote to wiki.\n" > "$dir/memory/session-learnings.md"
    echo "Created: $dir/memory/session-learnings.md"
  fi
done
```

- [ ] **Step 3: Run tests**

Run: `npm test`

Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/index.ts groups/*/memory/session-learnings.md
git commit -m "feat: auto-create session-learnings.md on group registration"
```

---

### Task 10: Build and verify end-to-end

- [ ] **Step 1: Build the project**

Run: `npm run build`

Expected: Clean build, no errors

- [ ] **Step 2: Run full test suite**

Run: `npm test`

Expected: All tests PASS

- [ ] **Step 3: Rebuild container image**

Run: `./container/build.sh`

Expected: Container builds successfully with new learning-extractor module

- [ ] **Step 4: Verify compact threshold is active**

Run: `sqlite3 store/messages.db "SELECT folder, json_extract(container_config, '$.autoCompactWindow') as acw FROM registered_groups ORDER BY folder"`

Expected: Every group shows a numeric threshold value.

- [ ] **Step 5: Verify global wiki mount works**

Run a quick container test:
```bash
docker run --rm -v $(pwd)/groups/global/wiki:/workspace/shared-wiki:ro nanoclaw-agent:latest ls /workspace/shared-wiki/
```

Expected: Shows `index.md`

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat: compact threshold & knowledge inheritance pipeline complete"
```
