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
