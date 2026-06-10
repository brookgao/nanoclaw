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

# ===== Action-mode bans (independent of working directory) =====
# These intercept dangerous OPERATIONS even from legitimate worktrees.
# Background: 2026-06-09 PRD-review-dev incident — Andy ran `git push origin
# dev` from a clean worktree, bypassing PR workflow. Path-based FORBIDDEN_REGEXES
# above didn't catch it (worktree path was legit). These regexes patch that.
#
# Design notes (synced with src/nanoclaw-host-guard.test.ts):
#   - Command-position anchor `(^|[[:space:]&;|])\bgit\b` — git must start
#     a command (line start, after ; & |, or after whitespace following one).
#     This prevents `echo "git push origin dev"` from being denied as a
#     false-positive on string literals (reviewer I2).
#   - `\bgit\b[^|;&]*\bpush\b` (not git[[:space:]]+push) so `git -c cfg push`
#     and `git --no-pager push` are caught (plan critic C3).
#   - No \$ end-anchor on branch name; trailing flags (e.g. dev --force) must
#     still match (plan critic C1).
#   - `+` is allowed as ref prefix to catch force-update refspec
#     `git push origin +dev` (review C2).
#   - grep -qiE (case-insensitive) catches `DEV`/`Main` aliases (review I1).
#   - [^|;&] blocks crossing command separators within one line. grep is
#     line-oriented, so multi-line input is matched per line.
#   - KNOWN GAP: variable expansion `BRANCH=dev; git push origin $BRANCH` is
#     not parsed; only the literal string is matched (review I3).

ANCHOR='(^|[;&|])[[:space:]]*'

# A) Push to protected branches (dev/main/master) — must go through PR
ACTION_BANS_PROTECTED_BRANCH=(
  # bare branch or +force-update prefix: origin dev / origin +dev / origin "dev"
  "${ANCHOR}\bgit\b[^|;&]*\bpush\b[^|;&]*([[:space:]]|\+)['\"]?(dev|main|master)['\"]?([[:space:]]|\$)"
  # any src:dst with protected dst: HEAD:dev, local:dev, :dev (delete), +local:dev
  "${ANCHOR}\bgit\b[^|;&]*\bpush\b[^|;&]*:(dev|main|master)([[:space:]]|\$|['\"])"
  # refs/heads/(dev|main|master) — also covers +refs/heads/dev
  "${ANCHOR}\bgit\b[^|;&]*\bpush\b[^|;&]*refs/heads/(dev|main|master)([[:space:]]|\$|['\"])"
  # --mirror / --all push every local ref (including dev/main) to remote
  "${ANCHOR}\bgit\b[^|;&]*\bpush\b[^|;&]*--(mirror|all)\b"
)

for re in "${ACTION_BANS_PROTECTED_BRANCH[@]}"; do
  if printf '%s' "$CMD" | grep -qiE "$re"; then
    deny "❌ Nanoclaw 安全护栏：禁止直推保护分支 (dev/main/master)。
必须走标准 PR 流程：
  git push origin <feature-branch>
  gh pr create --base dev --head <feature-branch> ...
  # 等用户说「合了 / merge」+ echo PR 号确认 → gh pr merge

停下来报告用户，等明确授权后才能尝试别的路径。

命中命令:
  $CMD"
  fi
done

# B) Force push — destructive on ANY branch (could overwrite peer work)
ACTION_BANS_FORCE_PUSH=(
  # --force / --force-with-lease / --force-with-lease=<ref> (\b at e|- or e|=)
  "${ANCHOR}\bgit\b[^|;&]*\bpush\b[^|;&]*--force\b"
  # bundled short flags containing -f: -f / -fu / -uf
  "${ANCHOR}\bgit\b[^|;&]*\bpush\b[^|;&]*[[:space:]]-[a-zA-Z]*f[a-zA-Z]*([[:space:]]|\$)"
)

for re in "${ACTION_BANS_FORCE_PUSH[@]}"; do
  if printf '%s' "$CMD" | grep -qiE "$re"; then
    deny "❌ Nanoclaw 安全护栏：禁止强制推 (--force / -f / --force-with-lease)。
强制推会覆盖远程别人的工作。
停下来报告用户，等明确授权；禁止自行绕路。

命中命令:
  $CMD"
  fi
done

# C) Bypassing commit hooks or GPG signing
ACTION_BANS_BYPASS_VERIFY=(
  "${ANCHOR}\bgit\b[^|;&]*\b(commit|push)\b[^|;&]*--no-verify\b"
  "${ANCHOR}\bgit\b[^|;&]*\b(commit|push)\b[^|;&]*--no-gpg-sign\b"
)

for re in "${ACTION_BANS_BYPASS_VERIFY[@]}"; do
  if printf '%s' "$CMD" | grep -qiE "$re"; then
    deny "❌ Nanoclaw 安全护栏：禁止跳过 commit hook / GPG 签名 (--no-verify / --no-gpg-sign)。
团队 hook / 签名是 CI 前置门。
停下来报告用户，等明确授权；禁止自行绕路。

命中命令:
  $CMD"
  fi
done

exit 0
