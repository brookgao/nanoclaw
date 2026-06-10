# Approval Hard-Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 任何代码改动开 PR 前必须有**用户批准的硬证据**（文件 marker）。两条合法路径：(A) 方案挡四步（plan → critic → 用户批准）；(B) DOTA 全流程（Phase 8 完成）。`host-guard.sh` 截获 `gh pr create`，二者都没有就 deny。彻底消灭"阿飞跳过 plan 直接 PR"的软规则漏洞。

**Architecture:** 复用 `dota-bridge.ts` 的 file-signal 模式。新增 `approval-bridge.ts` 在 nanoclaw 主进程检测用户消息里的批准关键词，向 `groups/<folder>/.approvals/` 写 `.json` 文件。`host-guard.sh` 在 `gh pr create` 之前校验该目录里有未过期（默认 30min 内）的 approval 文件，否则 deny + 提示走 plan/DOTA 路径。Threat model 是**防 LLM 软规则跳步骤**，不是防恶意攻击 —— host-mode 下 agent-runner 跟 orchestrator 同一 uid，无法做密码学级隔离。

**Tech Stack:** TypeScript, Node.js, Bash 5+, jq, vitest. 零新依赖。

---

## Threat Model（先说清楚防什么 / 不防什么）

**防**:
- ✅ LLM 看到任务后跳过 plan/critic 直接 `gh pr create` —— hook deny
- ✅ LLM 跳过 DOTA Phase 1-7 直接到 Phase 8 PR —— hook deny
- ✅ LLM 错把"OK"/"嗯" 当作 approval —— 关键词白名单严格只认祈使句
- ✅ 跨 group 串号 —— approval 文件按 `<group_folder>` 隔离

**不防**:
- ❌ LLM 故意构造 Bash 命令 `touch groups/<folder>/.approvals/fake.json` —— host-mode 同 uid，无密码学防御。靠 prompt 规则 + commit log 审计 + 用户事后 review 兜底。
- ❌ 历史 approval 复用 —— 用 TTL（30min）+ 单文件单次消费缓解。

---

## File Structure

- **新建 `src/approval-bridge.ts`** — `checkApprovalKeywords(text, replyText): {matched, kind}` 纯函数 + `writeApproval(groupFolder, opts)` 写文件。仿 `dota-bridge.ts`。
- **改 `src/index.ts`** — `onMessage` handler 紧跟 dota-bridge.ts:733 后追加 approval-bridge 检测，写 approval 文件。
- **改 `container/hooks/nanoclaw-host-guard.sh`** — 新增 `gh pr create` 命令拦截：校验 `<NANOCLAW_GROUP_DIR>/.approvals/` 有 mtime ≤ 30min 的 `.json` 文件。
- **改 `groups/global/CLAUDE.md`** — 「方案挡四步」段加一句"实施完直接 `gh pr create` 会被 hook deny，必须先得到用户口头批准"。「DOTA 三国管线」段同理，Phase 8 入口提示。
- **测试**:
  - `src/approval-bridge.test.ts` — 关键词检测 + 文件写入 + TTL 测试
  - `src/nanoclaw-host-guard.test.ts` — `gh pr create` deny/allow 测试（已有测试框架可扩展）
- **memory**: `reference_approval_hard_gate.md`（host 上，不入 PR）

---

## 关键词白名单（plan track）

```typescript
const PLAN_APPROVAL_PATTERNS = [
  /^按\s?plan\s?(改|实施|做|来)/i,         // 「按 plan 改」「按plan做」
  /^这个?\s?plan\s?(行|可以|ok|OK)/i,      // 「这个 plan 行」
  /^plan\s?(approved?|批准|通过)/i,         // 「plan 批准」/「plan approved」
  /^go\s?ahead/i,                            // 「go ahead」
  /^实施吧/,                                  // 「实施吧」
  /^开始(写|做|实施|动手)/,                   // 「开始写」/「开始动手」
];
```

**不算 approval**：
- 「OK」/「好的」/「嗯」/「收到」 (单字符确认 ≠ go-ahead)
- 「改吧」/「动手」/「你来做」 (这些是**进方案挡**的祈使，不是**批准 plan**的祈使；进了方案挡还要等 plan 写完用户再批准 plan)

## DOTA approval marker（dota track）

DOTA Phase 8 由 dota SKILL 自己控制；本 plan 不动 DOTA 内部，而是让 DOTA 走完最后一步时 agent 写 marker。简化方案：

DOTA 最终 commit message 强制含 `DOTA-Approved-By: <user-message-id>` —— 由用户在 DOTA Phase 7/8 之间发"批准"消息触发 approval-bridge 写 marker。**所以 dota track 跟 plan track 共用同一套 keyword + approval 文件**。

唯一差异：approval 文件 `kind: "plan" | "dota"`，方便 hook 给出更精准的 deny 消息（"你在 DOTA 还是方案挡？"）。

---

## Approval 文件 schema

`groups/<folder>/.approvals/<timestamp>-<rand4>.json`:

```json
{
  "kind": "plan",
  "approved_at": "2026-06-10T16:30:00.000Z",
  "matched_text": "按 plan 改",
  "matched_message_id": "om_xxx",
  "matched_sender": "ou_user_abc",
  "ttl_until": "2026-06-10T17:00:00.000Z"
}
```

TTL = approved_at + 30min。Hook 校验 `now < ttl_until`。

---

## Task 1: 新建 src/approval-bridge.ts（带测试）

**Files:**
- Create: `src/approval-bridge.ts`
- Create: `src/approval-bridge.test.ts`

- [ ] **Step 1: 写失败测试**

`src/approval-bridge.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  checkApprovalKeywords,
  writeApproval,
  hasFreshApproval,
} from './approval-bridge.js';

const tmpDir = path.join(os.tmpdir(), 'approval-bridge-test');

describe('checkApprovalKeywords', () => {
  it.each([
    ['按 plan 改', true],
    ['按plan做', true],
    ['这个 plan 行', true],
    ['plan approved', true],
    ['plan 批准', true],
    ['go ahead', true],
    ['Go Ahead', true],
    ['实施吧', true],
    ['开始动手', true],
    ['开始写代码', true],
  ])('matches: %s → %s', (text, expected) => {
    const { matched } = checkApprovalKeywords(text);
    expect(matched).toBe(expected);
  });

  it.each([
    ['OK', false],
    ['好的', false],
    ['嗯', false],
    ['收到', false],
    ['改吧', false], // 进方案挡的祈使，不是批准 plan
    ['动手', false],
    ['你来做', false],
    ['不行', false],
    ['不批准', false],
  ])('rejects: %s → %s', (text, expected) => {
    const { matched } = checkApprovalKeywords(text);
    expect(matched).toBe(expected);
  });
});

describe('writeApproval + hasFreshApproval', () => {
  beforeEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writeApproval creates .approvals/<id>.json', () => {
    writeApproval(tmpDir, {
      kind: 'plan',
      matchedText: '按 plan 改',
      matchedMessageId: 'om_1',
      matchedSender: 'ou_a',
    });
    const dir = path.join(tmpDir, '.approvals');
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    const data = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf-8'));
    expect(data.kind).toBe('plan');
    expect(data.matched_text).toBe('按 plan 改');
  });

  it('hasFreshApproval returns true within TTL', () => {
    writeApproval(tmpDir, {
      kind: 'plan',
      matchedText: '按 plan 改',
      matchedMessageId: 'om_1',
      matchedSender: 'ou_a',
    });
    expect(hasFreshApproval(tmpDir)).toBe(true);
  });

  it('hasFreshApproval returns false when expired', () => {
    const dir = path.join(tmpDir, '.approvals');
    fs.mkdirSync(dir, { recursive: true });
    // Manually write an expired approval
    const expiredApproval = {
      kind: 'plan',
      approved_at: '2020-01-01T00:00:00.000Z',
      matched_text: 'old',
      matched_message_id: 'old',
      matched_sender: 'old',
      ttl_until: '2020-01-01T00:30:00.000Z',
    };
    fs.writeFileSync(
      path.join(dir, 'old.json'),
      JSON.stringify(expiredApproval),
    );
    expect(hasFreshApproval(tmpDir)).toBe(false);
  });

  it('hasFreshApproval returns false when dir does not exist', () => {
    expect(hasFreshApproval(tmpDir)).toBe(false);
  });
});
```

Run: `npx vitest run src/approval-bridge.test.ts`
Expected: FAIL (module not exists)

- [ ] **Step 2: 实施 src/approval-bridge.ts**

```typescript
import fs from 'fs';
import path from 'path';

const APPROVALS_SUBDIR = '.approvals';
const TTL_MS = 30 * 60 * 1000; // 30 min

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
  kind: 'plan' | 'dota'; // currently both share keywords; differ in hook deny message
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
  const now = new Date();
  const ttl = new Date(now.getTime() + TTL_MS);
  const id = `${now.toISOString().replace(/[:.]/g, '-')}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
  const filename = `${id}.json`;
  const payload = {
    kind: opts.kind,
    approved_at: now.toISOString(),
    matched_text: opts.matchedText,
    matched_message_id: opts.matchedMessageId,
    matched_sender: opts.matchedSender,
    ttl_until: ttl.toISOString(),
  };
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(payload, null, 2));
  return filename;
}

export function hasFreshApproval(groupDir: string): boolean {
  const dir = path.join(groupDir, APPROVALS_SUBDIR);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return false;
  }
  const now = Date.now();
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      const ttl = new Date(data.ttl_until).getTime();
      if (now < ttl) return true;
    } catch {
      continue;
    }
  }
  return false;
}
```

Run: `npx vitest run src/approval-bridge.test.ts`
Expected: PASS

- [ ] **Step 3: commit**

```bash
git add src/approval-bridge.ts src/approval-bridge.test.ts
git commit -m "feat(approval): keyword detector + file marker writer"
```

---

## Task 2: 接入 src/index.ts onMessage

**Files:**
- Modify: `src/index.ts:733-770` (approval-bridge before dota-bridge logic, or in parallel)

- [ ] **Step 1: 加 import**

```typescript
import {
  checkApprovalKeywords,
  writeApproval,
} from './approval-bridge.js';
```

- [ ] **Step 2: 在 onMessage 已有 checkDotaDecision 调用之后追加 approval 检测**

```typescript
// Approval keyword detection — writes <group>/.approvals/<id>.json so
// host-guard can validate `gh pr create` (any code change must be preceded
// by user approval; defeats LLM skipping the four-step plan/critic gate).
if (
  chatJid.startsWith('feishu:') &&
  !msg.is_from_me &&
  !msg.is_bot_message &&
  registeredGroups[chatJid]
) {
  const result = checkApprovalKeywords(
    msg.content.trim(),
    msg.reply_to_message_content,
  );
  if (result.matched) {
    try {
      const groupDir = resolveGroupFolderPath(
        registeredGroups[chatJid].folder,
      );
      writeApproval(groupDir, {
        kind: result.kind,
        matchedText: msg.content.trim(),
        matchedMessageId: msg.id,
        matchedSender: msg.sender,
      });
      logger.info(
        { jid: chatJid, kind: result.kind },
        'approval marker written',
      );
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, jid: chatJid },
        'approval write failed',
      );
    }
  }
}
```

- [ ] **Step 3: 跑 build + 全套测试**

```bash
npm run build && npx vitest run
```
Expected: 0 errors, 500+ passing.

- [ ] **Step 4: commit**

```bash
git add src/index.ts
git commit -m "feat(orchestrator): wire approval keyword detection into onMessage"
```

---

## Task 3: host-guard 拦 gh pr create

**Files:**
- Modify: `container/hooks/nanoclaw-host-guard.sh` (add D-class ban)
- Modify: `src/nanoclaw-host-guard.test.ts` (add gh pr create test cases)

- [ ] **Step 1: 写失败测试**

```typescript
describe('nanoclaw-host-guard hook — action bans: gh pr create approval gate', () => {
  const fs = require('fs');
  const tmpdir = require('os').tmpdir();
  const path = require('path');

  function makeGroupDir(withApproval: boolean): string {
    const d = path.join(tmpdir, `hg-test-${Date.now()}-${Math.random()}`);
    fs.mkdirSync(d, { recursive: true });
    if (withApproval) {
      const approvals = path.join(d, '.approvals');
      fs.mkdirSync(approvals);
      const now = new Date();
      const ttl = new Date(now.getTime() + 30 * 60 * 1000);
      fs.writeFileSync(
        path.join(approvals, 'fresh.json'),
        JSON.stringify({
          kind: 'plan',
          approved_at: now.toISOString(),
          ttl_until: ttl.toISOString(),
          matched_text: '按 plan 改',
        }),
      );
    }
    return d;
  }

  it('denies gh pr create when no approval file', () => {
    const groupDir = makeGroupDir(false);
    const { stdout } = runHook(
      { tool_name: 'Bash', tool_input: { command: 'gh pr create --title x' } },
      { home: TEST_HOME, extra: { NANOCLAW_GROUP_DIR: groupDir } },
    );
    expect(stdout).toContain('"permissionDecision": "deny"');
    expect(stdout).toContain('approval');
  });

  it('ALLOWS gh pr create with fresh approval', () => {
    const groupDir = makeGroupDir(true);
    const { stdout } = runHook(
      { tool_name: 'Bash', tool_input: { command: 'gh pr create --title x' } },
      { home: TEST_HOME, extra: { NANOCLAW_GROUP_DIR: groupDir } },
    );
    expect(stdout).not.toContain('"permissionDecision": "deny"');
  });

  it('denies gh pr create with expired approval', () => {
    const groupDir = makeGroupDir(false);
    const approvals = path.join(groupDir, '.approvals');
    fs.mkdirSync(approvals);
    fs.writeFileSync(
      path.join(approvals, 'old.json'),
      JSON.stringify({
        ttl_until: '2020-01-01T00:00:00.000Z',
        approved_at: '2020-01-01T00:00:00.000Z',
      }),
    );
    const { stdout } = runHook(
      { tool_name: 'Bash', tool_input: { command: 'gh pr create' } },
      { home: TEST_HOME, extra: { NANOCLAW_GROUP_DIR: groupDir } },
    );
    expect(stdout).toContain('"permissionDecision": "deny"');
  });

  it('ALLOWS gh pr view / gh pr list / gh pr merge (only gh pr CREATE is gated)', () => {
    const groupDir = makeGroupDir(false);
    for (const cmd of ['gh pr view 5', 'gh pr list', 'gh pr merge 5']) {
      const { stdout } = runHook(
        { tool_name: 'Bash', tool_input: { command: cmd } },
        { home: TEST_HOME, extra: { NANOCLAW_GROUP_DIR: groupDir } },
      );
      expect(stdout).not.toContain('"permissionDecision": "deny"');
    }
  });
});
```

Also update `runHook` helper to accept `extra` env vars:

```typescript
function runHook(
  input: object,
  opts: { home?: string; extra?: Record<string, string> } = {},
): { stdout: string; status: number } {
  const childEnv = {
    ...process.env,
    HOME: opts.home ?? process.env.HOME,
    ...(opts.extra || {}),
  };
  // ... rest unchanged
}
```

Run: `npx vitest run src/nanoclaw-host-guard.test.ts -t "approval gate"`
Expected: FAIL on deny cases (no logic yet)

- [ ] **Step 2: 实施 hook D-class**

Append to `container/hooks/nanoclaw-host-guard.sh` after the `ACTION_BANS_BYPASS_VERIFY` block:

```bash
# D) gh pr create — must be preceded by user approval (file marker in
#    $NANOCLAW_GROUP_DIR/.approvals/). Approval files are written ONLY by
#    nanoclaw orchestrator when user sends approval-keyword messages
#    (按 plan 改 / go ahead / 实施吧 / etc). See src/approval-bridge.ts.
#
# Threat model: this blocks LLM from skipping plan→critic→approval. It does
# NOT defend against the LLM actively forging files (host-mode = same uid).
# The companion CLAUDE.md prompt warns against forging.

if printf '%s' "$CMD" | grep -qE "${ANCHOR}\bgh\b[^|;&]*\bpr\b[^|;&]*\bcreate\b"; then
  GROUP_DIR="${NANOCLAW_GROUP_DIR:-}"
  if [[ -z "$GROUP_DIR" ]]; then
    deny "❌ Nanoclaw 安全护栏：NANOCLAW_GROUP_DIR 未设置，无法校验 approval marker。
（这通常表示你在 nanoclaw 容器外手工跑 gh pr create —— 不该发生）

命中命令:
  $CMD"
  fi

  APPROVALS_DIR="$GROUP_DIR/.approvals"
  has_fresh="no"
  if [[ -d "$APPROVALS_DIR" ]]; then
    NOW_S=$(date +%s)
    for f in "$APPROVALS_DIR"/*.json; do
      [[ -f "$f" ]] || continue
      TTL=$(jq -r '.ttl_until // ""' "$f" 2>/dev/null)
      [[ -z "$TTL" ]] && continue
      # Convert ISO 8601 to epoch — macOS date / GNU date both support -d/-j
      # but flag syntax differs. Try GNU first, fall back to BSD.
      TTL_S=$(date -d "$TTL" +%s 2>/dev/null || date -j -f '%Y-%m-%dT%H:%M:%S.%3N%z' "${TTL%Z}+0000" +%s 2>/dev/null || echo 0)
      if (( TTL_S > NOW_S )); then
        has_fresh="yes"
        break
      fi
    done
  fi

  if [[ "$has_fresh" != "yes" ]]; then
    deny "❌ Nanoclaw 安全护栏：未找到有效的用户批准 (approval marker)。

任何 \`gh pr create\` 必须先走完两条路径之一：
  (A) 方案挡四步：writing-plans → critic → 用户说「按 plan 改」/「go ahead」
  (B) DOTA 全流程：Phase 1-7 完成后用户在 Phase 8 入口说「按 plan 改」

approval marker 由 nanoclaw 主进程检测用户消息自动写入 \$NANOCLAW_GROUP_DIR/.approvals/。
LLM 自己 touch / echo > 伪造 = 违反硬红线，会被 commit log 审计。

命中命令:
  $CMD"
  fi
fi
```

Run: `npx vitest run src/nanoclaw-host-guard.test.ts`
Expected: All pass (existing + new approval gate cases).

- [ ] **Step 3: commit**

```bash
git add container/hooks/nanoclaw-host-guard.sh src/nanoclaw-host-guard.test.ts
git commit -m "feat(host-guard): gate gh pr create on user approval marker"
```

---

## Task 4: 更新 groups/global/CLAUDE.md 提示新规则

**Files:**
- Modify: `groups/global/CLAUDE.md` (in 方案挡四步 + DOTA 三国管线 sections)

- [ ] **Step 1: 「方案挡四步」段加一句**

在「4. 实施完调 code review」之前插入新一步：

> **3.5. 等批准 hook 校验** — 用户说「按 plan 改 / go ahead / 实施吧」后，nanoclaw 主进程会在群目录写 `.approvals/<id>.json`。这是**硬红线**：没有这个文件 host-guard 会 deny `gh pr create`。不能自己 touch 伪造（commit log 审计）。

- [ ] **Step 2: 「DOTA 三国管线」段同理**

「触发约定」末尾加：

> **Phase 8 入口** = 必须有用户口头批准（关键词同上），同样 hook 校验 approval marker。

- [ ] **Step 3: 加禁止动作**

「禁止动作」清单加一条：

> - ❌ `touch <group>/.approvals/fake.json` 或任何手工写 approval marker —— LLM 必须等用户的真实批准消息触发 nanoclaw 写文件

- [ ] **Step 4: commit**

```bash
git add groups/global/CLAUDE.md
git commit -m "docs(global): add approval marker gate to plan/DOTA paths"
```

---

## Task 5: memory + 全套回归 + PR

- [ ] **Step 1: 修 memory**

Edit `/Users/admin/.claude/projects/.../memory/feedback_andy_confirm_before_code.md` 加一段：

> **2026-06-10 硬约束补丁**: PR #3175 暴露 LLM 即使有完整 global.md 规则仍跳过方案挡 plan/critic 步直接 PR。brookgao/nanoclaw#N 新加 approval marker + host-guard `gh pr create` 校验：用户说「按 plan 改 / go ahead / 实施吧」→ nanoclaw 主进程写 `<group>/.approvals/`，hook 校验 fresh approval 才放行 PR。LLM 伪造（手工 touch）在 host-mode 同 uid 下技术上做得到，但违反硬红线 + commit log 可审。

- [ ] **Step 2: build + 全测试**

```bash
npm run build && npx vitest run 2>&1 | tail -5
```
Expected: 0 errors, 500+ pass.

- [ ] **Step 3: 4 个 smoke**

```bash
# 没 approval 应 deny
NANOCLAW_GROUP_DIR=/tmp/empty-group bash container/hooks/nanoclaw-host-guard.sh <<<'{"tool_name":"Bash","tool_input":{"command":"gh pr create"}}' | jq -r '.hookSpecificOutput.permissionDecision'
# Expected: deny

# 有 approval 应放行（创建一个新 fresh approval 文件）
mkdir -p /tmp/has-approval/.approvals
TTL=$(date -u -v +30M +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date -u -d '+30 min' +%Y-%m-%dT%H:%M:%S.000Z)
echo "{\"kind\":\"plan\",\"ttl_until\":\"$TTL\"}" > /tmp/has-approval/.approvals/test.json
NANOCLAW_GROUP_DIR=/tmp/has-approval bash container/hooks/nanoclaw-host-guard.sh <<<'{"tool_name":"Bash","tool_input":{"command":"gh pr create"}}' | jq -r '.hookSpecificOutput.permissionDecision // "ALLOWED"'
# Expected: ALLOWED

# gh pr view / list / merge 不受影响
NANOCLAW_GROUP_DIR=/tmp/empty-group bash container/hooks/nanoclaw-host-guard.sh <<<'{"tool_name":"Bash","tool_input":{"command":"gh pr view 5"}}' | jq -r '.hookSpecificOutput.permissionDecision // "ALLOWED"'
# Expected: ALLOWED
```

- [ ] **Step 4: push + 开 PR (--repo brookgao/nanoclaw 显式)**

```bash
git push -u origin feat/approval-hard-gate
gh pr create --repo brookgao/nanoclaw --base main --head brookgao:feat/approval-hard-gate \
  --title "feat(approval): hard-gate gh pr create on user-approval marker" \
  --body "...full body..."
```

- [ ] **Step 5: 调 requesting-code-review**

按 `Skill(superpowers:requesting-code-review)`，dispatch reviewer subagent，等回复 → 修 Critical/Important → 报告给用户。

---

## Self-Review

### Spec coverage
| 需求 | 实现 |
|---|---|
| approval keyword 检测 | Task 1 ✓ |
| 写 file marker | Task 1 ✓ |
| host-guard 拦 gh pr create | Task 3 ✓ |
| 两条 track 共用 approval | 关键词共用 + kind 字段区分 message ✓ |
| TTL 防过期复用 | Task 1 schema + Task 3 hook 校验 ✓ |
| 跨 group 隔离 | approval 文件存在 group folder ✓ |
| 更新 global.md prompt | Task 4 ✓ |
| memory 记录 | Task 5 ✓ |

### Placeholder scan
- ✅ 没有 TBD / implement later
- ✅ 所有 regex / code / schema 给了具体形式
- ✅ Task 5 Step 4 PR body 用 "..." 占位是显式标记"实施时填"，不是 placeholder bug

### Type consistency
- `ApprovalCheckResult`/`WriteApprovalOpts` 在 Task 1 定义，Task 2 使用，签名一致
- `kind: 'plan' | 'dota'` 类型在所有地方一致

### 风险点 / 已知 gap
1. **LLM 手工伪造 approval 文件** — host-mode 同 uid，技术上做得到。靠 prompt 规则 + commit log 审计 + 用户事后 review 兜底（threat model 明确）。
2. **TTL = 30min**：如果用户批准后阿飞跑超过 30min（DOTA 大流程可能），approval 过期了 hook 会 deny。可以让用户重发批准，或者后续考虑「批准后第一次 PR 消费即标记 consumed」机制。
3. **关键词白名单要求严格祈使**：「OK」/「嗯」不算 approval，避免确认型问题误激活。但用户可能用奇怪表达「行吧」「可以」，目前不在白名单 —— 添加需谨慎，因为这些跟"确认收到"难区分。

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-10-approval-hard-gate.md`.**

下一步走方案挡四步：

1. ✅ Plan 写完
2. ⏭ **下一步：派 critic 子代理对抗审 plan**
3. ⏳ plan + critic 摘要发给用户等批准
4. ⏳ 用户批准后实施 + code-review
