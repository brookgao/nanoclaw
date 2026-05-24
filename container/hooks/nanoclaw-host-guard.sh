#!/bin/bash
# Nanoclaw PreToolUse hook: deny Bash that operates on user's main dev directories.
#
# Background:
#   2026-05-22 incident — a scheduled nanoclaw task did commit/stash/checkout/push
#   on the user's in-progress feat branch under /Users/admin/Desktop/vibe-coding/nine,
#   nearly losing uncommitted work. This hook is the runtime safety net.
#
# Design:
#   - Matches COMMAND-FORM patterns (cd / git -C / --git-dir= / GIT_DIR= / find / xargs)
#     not bare substring, to avoid false-positive on cat/echo of literal paths.
#   - Covers single-quote, double-quote, $HOME literal, ~/, and container paths.
#   - Fail-closed: malformed input → deny.
#
# Spec: docs/specs/2026-05-24-task-workdir-safety-guard.md §5.4

set -uo pipefail

# Dependency check (Codex R5 m1): jq missing → fail-closed
command -v jq >/dev/null 2>&1 || {
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"❌ nanoclaw-host-guard 依赖 jq 但未找到 — fail-closed。"}}\n'
  exit 0
}

INPUT=$(cat)
TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""')

# Fail-closed BEFORE non-Bash early-exit (critic R3 M3)
if [[ -z "$TOOL" ]]; then
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Hook 输入 JSON 解析失败或缺 tool_name 字段 — fail-closed 保护拦截。"
    }
  }'
  exit 0
fi

# Only inspect Bash (Edit/Write are sandboxed at group dir level)
[[ "$TOOL" != "Bash" ]] && exit 0

CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')

# Runtime-constructed forbidden prefixes (Codex R5 M4: not hardcoded to /Users/admin)
HOME_DESKTOP="$HOME/Desktop/vibe-coding"
# Escape regex metacharacters in HOME_DESKTOP
ESC_HOME_DESKTOP=$(printf '%s' "$HOME_DESKTOP" | sed 's/[\/&.]/\\&/g')
ESC_WORKSPACE='\/workspace\/extra\/vibe-coding'

deny() {
  jq -n --arg r "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $r
    }
  }'
  exit 0
}

# Forbidden command-form regexes (synced with src/task-scheduler.ts buildForbiddenCommandRegexes)
# Quote class [\"'] covers both double and single quote (critic R3 M1)
FORBIDDEN_REGEXES=(
  # cd / pushd <forbidden>
  "\b(cd|pushd)[[:space:]]+[\"']?(${ESC_HOME_DESKTOP}|${ESC_WORKSPACE})\b"
  # git -C / --git-dir= / --work-tree= <forbidden>
  "\bgit[[:space:]]+(-C[[:space:]]+|--git-dir=|--work-tree=)[\"']?(${ESC_HOME_DESKTOP}|${ESC_WORKSPACE})\b"
  # GIT_DIR= / GIT_WORK_TREE= env var
  "\bGIT_DIR=[\"']?(${ESC_HOME_DESKTOP}|${ESC_WORKSPACE})\b"
  "\bGIT_WORK_TREE=[\"']?(${ESC_HOME_DESKTOP}|${ESC_WORKSPACE})\b"
  # Tilde literal (~ not expanded in command string)
  "\b(cd|pushd)[[:space:]]+[\"']?~/Desktop/vibe-coding\b"
  "\bgit[[:space:]]+(-C[[:space:]]+|--git-dir=|--work-tree=)[\"']?~/Desktop/vibe-coding\b"
  # \$HOME / \${HOME} literal (Codex R5 M3)
  "\b(cd|pushd)[[:space:]]+[\"']?\\\$\{?HOME\}?/Desktop/vibe-coding\b"
  "\bgit[[:space:]]+(-C[[:space:]]+|--git-dir=|--work-tree=)[\"']?\\\$\{?HOME\}?/Desktop/vibe-coding\b"
  # find/xargs partial (Codex R5 M4 — known-limitation, see spec)
  "\b(find|xargs)\b.*[\"']?(${ESC_HOME_DESKTOP}|${ESC_WORKSPACE})\b"
)

for re in "${FORBIDDEN_REGEXES[@]}"; do
  if printf '%s' "$CMD" | grep -qE "$re"; then
    deny "❌ Nanoclaw 安全护栏：禁止访问用户主开发目录或容器内 /workspace/extra/vibe-coding/。
该目录可能正被用户用于 in-progress 工作（2026-05-22 事故）。

改用 nanoclaw 专属 worktree：
  cd <repo-root> && git worktree add ~/nanoclaw-worktrees/<name> <branch>
然后任务里 cd ~/nanoclaw-worktrees/<name>

详见 spec: docs/specs/2026-05-24-task-workdir-safety-guard.md

命中命令:
  $CMD"
  fi
done

exit 0
