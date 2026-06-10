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

# D) PR-create approval gate
# ====================================================================
# Background: 2026-06-09 #3175 incident — Andy received "可以动手" and
# went straight to `gh pr create`, skipping plan→critic→user-approval.
# This block requires a fresh, unconsumed approval marker file before
# allowing any path that opens a PR.
#
# Gated paths:
#   - `gh pr create ...`           (the standard path)
#   - `gh api .../pulls -X POST`   (the REST bypass — critic C4)
#   - `curl ... github.com/.../pulls -X POST`  (the raw API bypass — critic C4)
#
# Pre-check: cross-group reuse via inline `NANOCLAW_GROUP_DIR=` env
# (critic C1) is denied first, before the PR-create check fires.

# C1: deny inline env override that swaps the approval dir to another group
if printf '%s' "$CMD" | grep -qiE "\bNANOCLAW_GROUP_DIR=[^[:space:]]"; then
  deny "❌ Nanoclaw 安全护栏：禁止内联覆盖 NANOCLAW_GROUP_DIR。
原因：这是跨群盗用 approval marker 的攻击向量 —— 拿别的群（如 feishu_dm）的新鲜
approval 给本群 PR 开门。任何 PR 必须用本群的合法 approval。

命中命令:
  $CMD"
fi

# Detect PR-creating commands
PR_CREATE_RE="${ANCHOR}(\bgh\b[^|;&]*\bpr\b[^|;&]*\bcreate\b)"
GH_API_PULLS_RE="${ANCHOR}\bgh\b[^|;&]*\bapi\b[^|;&]*/pulls\b[^|;&]*(-X[[:space:]]*POST|--method[[:space:]]*POST)"
GH_API_PULLS_DEFAULT_RE="${ANCHOR}\bgh\b[^|;&]*\bapi\b[^|;&]*/pulls\b[^|;&]*(-f[[:space:]]|--field[[:space:]]|--raw-field[[:space:]])"
CURL_API_PULLS_RE="${ANCHOR}\bcurl\b[^|;&]*api\.github\.com[^|;&]*/pulls\b"

is_pr_create="no"
for re in "$PR_CREATE_RE" "$GH_API_PULLS_RE" "$GH_API_PULLS_DEFAULT_RE" "$CURL_API_PULLS_RE"; do
  if printf '%s' "$CMD" | grep -qiE "$re"; then
    is_pr_create="yes"
    break
  fi
done

if [[ "$is_pr_create" == "yes" ]]; then
  GROUP_DIR="${NANOCLAW_GROUP_DIR:-}"
  if [[ -z "$GROUP_DIR" ]]; then
    deny "❌ Nanoclaw 安全护栏：NANOCLAW_GROUP_DIR 未设置，无法校验 approval marker。
（这通常表示在 nanoclaw 体系外手工跑 PR-create 命令 —— 不该发生。
如确需在 host 上手工操作，先 unload nanoclaw 服务并直接在 shell 跑。）

命中命令:
  $CMD"
  fi

  APPROVALS_DIR="$GROUP_DIR/.approvals"
  fresh_file=""
  if [[ -d "$APPROVALS_DIR" ]]; then
    NOW_S=$(date -u +%s)
    # Iterate only .json files (skip .consumed.json and .tmp)
    while IFS= read -r f; do
      [[ -z "$f" ]] && continue
      [[ "$f" == *.consumed.json ]] && continue
      [[ "$f" == *.tmp ]] && continue
      [[ -f "$f" ]] || continue
      TTL_RAW=$(jq -r '.ttl_until // ""' "$f" 2>/dev/null)
      [[ -z "$TTL_RAW" ]] && continue
      # macOS-safe date parsing (critic C2): strip milliseconds & trailing Z,
      # then parse as plain ISO 8601 in UTC.
      TTL_CLEAN=$(printf '%s' "$TTL_RAW" | sed 's/\.[0-9]*Z$//; s/Z$//')
      TTL_S=$(date -u -j -f '%Y-%m-%dT%H:%M:%S' "$TTL_CLEAN" +%s 2>/dev/null || \
              date -u -d "$TTL_CLEAN" +%s 2>/dev/null || \
              echo 0)
      if (( TTL_S > NOW_S )); then
        fresh_file="$f"
        break
      fi
    done < <(find "$APPROVALS_DIR" -maxdepth 1 -name '*.json' -not -name '*.consumed.json' 2>/dev/null)
  fi

  if [[ -z "$fresh_file" ]]; then
    deny "❌ Nanoclaw 安全护栏：未找到有效的用户批准 (approval marker)。

任何 PR-create 命令 (\`gh pr create\` / \`gh api .../pulls\` / \`curl .../pulls\`)
必须先有用户口头批准。两条合法路径：
  (A) 方案挡四步：writing-plans → critic → 用户说「按 plan 改 / go ahead / 实施吧」
  (B) DOTA 全流程：Phase 1-7 完成后用户在 Phase 8 入口说「按 plan 改」

approval marker 由 nanoclaw 主进程在收到用户批准消息时自动写入：
  \$NANOCLAW_GROUP_DIR/.approvals/<id>.json

禁止动作：
  - 自己 \`touch\` / \`echo >\` 伪造 marker 文件 → 违反硬红线，commit log 会审计
  - 通过 \`NANOCLAW_GROUP_DIR=...\` 内联跨群盗用 marker（已被拦）

命中命令:
  $CMD"
  fi

  # Consume the marker — atomic rename, one approval = one PR-create call
  # (critic C3). If user wants another PR, they must approve again.
  mv "$fresh_file" "${fresh_file%.json}.consumed.json" 2>/dev/null || true
fi

exit 0
