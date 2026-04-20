#!/usr/bin/env bash
# Regression tests for Afei (Andy) autonomy documentation.
# Covers:
#   1. feishu_langgraph-fix CLAUDE.md documents /start-session self-heal
#   2. Health-check example uses correct session name dev-claude-andy
#   3. autonomy-framework.md lists authorized routine actions
#   4. FTS5 index returns autonomy-framework for "已授权" query
#
# RED (pre-fix): assertions 1, 2, 3, 4 all fail.
# GREEN (post-fix): all pass.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LANGGRAPH_CLAUDE="$REPO_ROOT/groups/feishu_langgraph-fix/CLAUDE.md"
AUTONOMY_FW="$REPO_ROOT/groups/feishu_main/wiki/operations/autonomy-framework.md"
DB="$REPO_ROOT/store/messages.db"

pass=0
fail=0

check() {
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "  ✓ $label"
    pass=$((pass + 1))
  else
    echo "  ✗ $label"
    fail=$((fail + 1))
  fi
}

echo "[1] feishu_langgraph-fix CLAUDE.md teaches /start-session self-heal"
check "mentions POST /start-session" grep -q "/start-session" "$LANGGRAPH_CLAUDE"
check "tells Afei to self-heal on no-session" grep -qE "no-session.*(自愈|不.{0,4}问|自己)" "$LANGGRAPH_CLAUDE"

echo "[2] Health-check example uses correct session name"
check "example shows session=dev-claude-andy" \
  grep -qE '"session":\s*"dev-claude-andy"' "$LANGGRAPH_CLAUDE"

echo "[3] autonomy-framework lists authorized routine actions"
check "has '已授权的例行动作' section" grep -q "已授权的例行动作" "$AUTONOMY_FW"
check "lists tmux-bridge session self-heal" \
  grep -qE "(start-session|会话自愈)" "$AUTONOMY_FW"
check "lists seed source → container restart flow" \
  grep -qE "(seed.*wt-deploy|seed.*重启|wt-deploy.*seed)" "$AUTONOMY_FW"

echo "[4] FTS5 index returns autonomy-framework for authorized-actions queries"
# unicode61 tokenizer splits non-letters on Latin tokens and treats each
# CJK char as its own token. Short 2-char CJK queries can be filtered out;
# longer phrases and quoted Latin tokens both work reliably.
if [[ -f "$DB" ]]; then
  for q in '已授权的例行动作' '"start-session"'; do
    hit=$(sqlite3 "$DB" \
      "SELECT path FROM wiki_fts WHERE wiki_fts MATCH '$q' AND path LIKE '%autonomy-framework%' LIMIT 1;" \
      2>/dev/null || echo "")
    if [[ -n "$hit" ]]; then
      echo "  ✓ FTS5 returns autonomy-framework for $q"
      pass=$((pass + 1))
    else
      echo "  ✗ FTS5 returns autonomy-framework for $q"
      fail=$((fail + 1))
    fi
  done
else
  echo "  ✗ FTS5 checks skipped — DB missing at $DB"
  fail=$((fail + 2))
fi

echo
echo "Result: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
