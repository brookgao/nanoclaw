---
name: knowledge-distiller
description: Promote session-learnings to the global wiki. Triggered by user command ("整理知识"), scheduled daily, or when learning count exceeds threshold.
---

# Knowledge Distiller

Promote unpromoted entries from `memory/session-learnings.md` into the group's own wiki at `wiki/learnings/`.

## Path Rules (宿主机模式)

所有路径用相对路径（相对于 cwd = 群组目录）。不要用 `/workspace/` 开头的路径。
- session-learnings: `memory/session-learnings.md`
- wiki 输出目录: `wiki/learnings/`
- wiki 索引: `wiki/index.md`
- wiki 日志: `wiki/log.md`
- FTS5 数据库: `../../store/messages.db`

## Steps

1. Read `memory/session-learnings.md`
2. Collect lines matching `[YYYY-MM-DD]` that do NOT start with `[promoted]`
3. If no unpromoted entries, report "No new learnings to promote" and stop
4. Group related entries by topic similarity
5. For each topic group:
   a. Determine a short topic slug (e.g., `db-connection-pooling`)
   b. Create or update `wiki/learnings/<topic-slug>.md` with:
      - `# <Topic Title>`
      - `## Key Points` — bullet list of the distilled learnings
      - `## Sources` — list of `来源:` references from the original entries
   c. If the file already exists, merge new points into it rather than overwriting
6. Update FTS5 index:
   ```bash
   WIKI_DB="../../store/messages.db"
   
   # For each wiki page written, upsert into FTS5:
   # sqlite3 "$WIKI_DB" "DELETE FROM wiki_fts WHERE path = '<relative-path>';"
   # sqlite3 "$WIKI_DB" "INSERT INTO wiki_fts(path, title, summary, body) VALUES (...);"
   ```
7. Update `wiki/index.md` and append to `wiki/log.md`
8. Mark each promoted entry: prepend `[promoted]` to the line in `session-learnings.md`
9. Delete `.needs-promotion` flag if it exists:
   ```bash
   rm -f memory/.needs-promotion
   ```
10. Report: "Promoted N learnings to wiki"

## Important

- Do NOT delete entries from session-learnings.md — only prepend `[promoted]`.
- Keep wiki pages concise: each page should be < 500 words.
