# Compact Threshold & Knowledge Inheritance Design

## Problem

1. **Context bloat**: Agent containers accumulate massive context (420K tokens / 64 turns) because `autoCompactWindow` defaults to 120K. A single response takes 17 minutes with that much cached context.
2. **Knowledge silos**: Each group's learnings are isolated. When a new group is created, it starts from zero — no way to inherit knowledge from existing groups.
3. **No knowledge distillation**: The pre-compact hook archives transcripts to `conversations/` but never extracts reusable knowledge from them.

## Solution

Two features: (A) lower compact thresholds across all groups, (B) build a knowledge distillation pipeline with three trigger modes and a global shared wiki.

---

## Part A: Compact Threshold

Update `registered_groups.container_config` in messages.db to set `autoCompactWindow` for groups that don't have one.

| Group | Current | Target | Rationale |
|-------|---------|--------|-----------|
| feishu_pm-doc-quality | 120K (default) | 50K | Hit 420K, 17min response |
| feishu_pm-openspec-quality | 120K (default) | 50K | Same workload pattern |
| feishu_langgraph-pm | 120K (default) | 50K | Same workload pattern |
| feishu_main | 120K (default) | 80K | Heavier workload, needs more context |
| feishu_dm | 120K (default) | 80K | Heavier workload |
| All others | 120K (default) | 60K | Reasonable default |

50K ≈ 15-20 turns before compact. Response time should stay under 2-3 minutes.

**Implementation**: Single SQL UPDATE per group on `registered_groups.container_config` JSON. No code changes needed — `container-runner.ts` already reads `autoCompactWindow` from containerConfig.

---

## Part B: Knowledge Distillation Pipeline

### Architecture Overview

Three stages: Extract → Promote → Share.

```
┌─────────────────────────────────────────────────┐
│ Stage 1: Extract (on every compact)             │
│                                                 │
│ pre-compact hook → parse transcript             │
│ → extract conclusions → session-learnings.md    │
│ → if entries >= 10, write .needs-promotion flag  │
└──────────────────────┬──────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────┐
│ Stage 2: Promote (3 triggers)                   │
│                                                 │
│ ┌───────────┐ ┌───────────┐ ┌────────────────┐  │
│ │ Threshold │ │ Scheduled │ │ Manual command │  │
│ │ .needs-   │ │ daily     │ │ "整理知识"     │  │
│ │ promotion │ │ 02:00     │ │ in any group   │  │
│ └─────┬─────┘ └─────┬─────┘ └───────┬────────┘  │
│       └─────────────┼───────────────┘            │
│                     ▼                            │
│            knowledge-distiller                   │
│            (container skill)                     │
└──────────────────────┬──────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────┐
│ Stage 3: Write to global wiki                   │
│                                                 │
│ groups/global/wiki/<group-name>/*.md             │
│ → update FTS5 index                             │
│ → mark entries [promoted] in session-learnings  │
└─────────────────────────────────────────────────┘
```

### Stage 1: Extract (pre-compact hook enhancement)

**File**: `container/agent-runner/src/index.ts` — `createPreCompactHook()`

After the existing transcript archival, add:

1. Parse the archived transcript's assistant messages
2. Extract conclusion-like content using pattern matching:
   - Lines containing decision keywords: 结论、决定、教训、发现、原因是、解决方案、根因、要点、关键
   - Lines following patterns like "所以...", "最终...", "总结..."
   - Structured sections: bullet points after headings like "## 结论", "## 要点"
3. Format as dated entries and append to `/workspace/group/memory/session-learnings.md`:
   ```
   [2026-04-24] <one-line summary> | 来源: <conversation-filename>
   ```
4. Count total unpromoted entries. If >= 10, write `/workspace/group/memory/.needs-promotion` flag file.

**No LLM call needed** — heuristic extraction is sufficient for this stage. The LLM-based distillation happens in Stage 2.

### Stage 2: Knowledge Distiller

**New file**: `container/skills/knowledge-distiller/SKILL.md`

A container skill that the agent executes. Core logic:

1. Read `memory/session-learnings.md`, filter entries without `[promoted]` prefix
2. Group related entries by topic
3. For each topic group, generate a wiki page:
   - Title, summary, key points, source references
4. Write to `/workspace/shared-wiki/<group-name>/<topic>.md`
5. Update the FTS5 index (`wiki.db`) via `sqlite3` CLI
6. Mark processed entries with `[promoted]` prefix in session-learnings.md
7. Remove `.needs-promotion` flag if it exists

**Three trigger mechanisms:**

#### Trigger 1: Threshold (post-container check)

**File**: `src/index.ts` — after container exits

```typescript
// After container completes, check for promotion flag
const flagPath = path.join(groupDir, 'memory', '.needs-promotion');
if (fs.existsSync(flagPath)) {
  // Spawn distiller container for this group
  spawnDistiller(group);
  fs.unlinkSync(flagPath);
}
```

`spawnDistiller()` is a lightweight helper that calls `runContainer()` with a system prompt instructing the agent to execute the knowledge-distiller skill.

#### Trigger 2: Scheduled (daily task)

**File**: `src/task-scheduler.ts`

Add a built-in scheduled job (not a DB-registered task, since it needs host-level access to all groups):

```typescript
// Daily at 02:00 — iterate all groups, spawn distiller for each with unpromoted entries
function runDailyKnowledgePromotion() {
  for (const group of getAllGroups()) {
    const learningsPath = path.join(groupDir(group), 'memory', 'session-learnings.md');
    if (hasUnpromotedEntries(learningsPath)) {
      spawnDistiller(group);
    }
  }
}
```

This runs at the host level, not inside a container — each group gets its own distiller container with its own memory mounted.

#### Trigger 3: Manual command

**File**: Each group's `CLAUDE.md`

Add rule:
```
When user says "整理知识" or "promote learnings", read memory/session-learnings.md,
execute the knowledge-distiller skill to promote unpromoted entries to the global wiki.
```

### Stage 3: Global Wiki Structure

**Directory**: `groups/global/wiki/`

```
groups/global/wiki/
├── index.md                    ← auto-generated table of contents
├── wiki.db                     ← FTS5 index (all groups)
├── feishu_main/                ← symlink to existing wiki or migrated content
├── feishu_pm-doc-quality/      ← auto-generated by distiller
│   ├── spu-duplicate-logic.md
│   ├── doc-formatting-rules.md
│   └── ...
├── feishu_dm/
└── ...
```

**FTS5 schema** (same as existing, extended):
```sql
CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(
  path, title, summary, body, source_group,
  tokenize='porter unicode61'
);
```

### Container Mount Changes

**File**: `src/container-runner.ts`

For all groups, automatically add a readonly mount:
```typescript
// Always mount global wiki for cross-group knowledge access
args.push('-v', `${globalWikiDir}:/workspace/shared-wiki:ro`);
```

Remove per-group `shared-wiki` mounts from individual group `registered_groups.container_config` in DB (currently set for feishu_dm, langgraph-fix, harness). Replace with this single universal mount in code.

For groups that need write access during distillation, the distiller container gets an `rw` mount instead.

### New Group Inheritance

When a new group is registered (via `registerGroup()` in `db.ts`), it automatically gets:
1. The global wiki mount (no config needed — it's universal)
2. A blank `memory/session-learnings.md` template
3. CLAUDE.md instructions referencing the shared wiki for search

No migration or copy step needed — the new group can immediately search all historical knowledge via FTS5.

---

## Files Changed

| File | Change |
|------|--------|
| `container/agent-runner/src/index.ts` | Enhance pre-compact hook: extract learnings + threshold flag |
| `container/skills/knowledge-distiller/SKILL.md` | New skill: distill session-learnings → global wiki |
| `src/container-runner.ts` | Universal global wiki mount; remove per-group shared-wiki mounts |
| `src/index.ts` | Post-container threshold check → spawn distiller |
| `src/db.ts` | Seed compact thresholds into registered_groups |
| Group CLAUDE.md files | Add "整理知识" manual trigger rule |
| `groups/global/wiki/` | New directory structure + FTS5 index |

## Out of Scope

- Migrating feishu_main's existing wiki to global wiki (can be done later with symlink)
- Cross-group IPC or real-time knowledge sync
- Automatic conflict resolution if two groups write the same wiki topic

## Risks

1. **Heuristic extraction quality**: Pattern matching may miss some learnings or capture noise. Mitigation: the daily LLM-based distiller cleans up and consolidates.
2. **FTS5 concurrent writes**: If two distiller containers run simultaneously, they could corrupt wiki.db. Mitigation: use SQLite WAL mode and serialize distiller runs (only one at a time via a lock file).
3. **Distiller cost**: Each distiller run uses LLM tokens. Mitigation: threshold of 10 entries prevents too-frequent runs; daily schedule is at most once per day per group.
