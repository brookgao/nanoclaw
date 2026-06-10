# Group CLAUDE.md Specificity Uplift Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 通过对比 Fix 群（遵守度好）和 PRD-review 群（遵守度差），证实**"群本地具体规则 + 重复 global 内容"是关键**。把 Fix 群独有的 Nine 会话诊断 + worktree 强制规则段搬到 global（让新开发群默认有），同时给 PRD-review 群本地补一份 global 副本 + 调整为 PRD-review 专属路径。

**Architecture:** 不动 Fix 群本地（用着 OK）。改 global.md append 三段（Nine 会话 / 宿主代码访问 / 写代码 改 Nine）。覆盖 PRD-review 群本地：完整 copy 新 global + 在末尾保留原 29 行群专属，并用 sed 调整路径前缀（`recruit-lite-` → `prd-review-`，`recruitment_requirement_define_lite` → `prd-review`）。

**Tech Stack:** 纯 markdown + bash sed/cat。零依赖。

---

## File Structure

- `groups/global/CLAUDE.md` — append Fix 群三段（line 31-106 原文）
- `groups/feishu_prd-review-dev/CLAUDE.md` — 完全重写：新 global + 原 29 行专属（路径已调整）

---

## Task 1: 提取 Fix 群三段并 append 到 global.md

**Files:**
- Read: `groups/feishu_recruit-lite-fix/CLAUDE.md:31-106`
- Modify: `groups/global/CLAUDE.md`

- [ ] **Step 1: 把 Fix 群 line 31-106 提取到临时文件**

```bash
sed -n '31,106p' groups/feishu_recruit-lite-fix/CLAUDE.md > /tmp/nine-sections.md
wc -l /tmp/nine-sections.md  # Expected: 76 行
```

- [ ] **Step 2: append 到 global.md 末尾**

```bash
echo "" >> groups/global/CLAUDE.md
cat /tmp/nine-sections.md >> groups/global/CLAUDE.md
wc -l groups/global/CLAUDE.md  # Expected: 283 + 76 + 1 = 360 行
```

- [ ] **Step 3: 验证 global 含三段**

```bash
grep -c "Nine 会话链接\|宿主代码访问的边界\|写代码 / 改 Nine 项目" groups/global/CLAUDE.md
# Expected: 3
```

---

## Task 2: PRD-review 群本地：copy global + 保留专属

**Files:**
- Read: `groups/feishu_prd-review-dev/CLAUDE.md`（原 29 行）
- Modify: `groups/feishu_prd-review-dev/CLAUDE.md`

- [ ] **Step 1: 保存 PRD-review 原专属内容（line 7 开始的 `## Topic` 段）**

```bash
# 找到 `## Topic` 起点，提取到 EOF
TOPIC_START=$(grep -n "^## Topic" groups/feishu_prd-review-dev/CLAUDE.md | head -1 | cut -d: -f1)
sed -n "${TOPIC_START},\$p" groups/feishu_prd-review-dev/CLAUDE.md > /tmp/prd-original-specific.md
wc -l /tmp/prd-original-specific.md  # Expected: ~23 行
```

- [ ] **Step 2: 用 global.md 覆盖 PRD-review 本地，再追加专属**

```bash
cp groups/global/CLAUDE.md groups/feishu_prd-review-dev/CLAUDE.md
echo "" >> groups/feishu_prd-review-dev/CLAUDE.md
cat /tmp/prd-original-specific.md >> groups/feishu_prd-review-dev/CLAUDE.md
wc -l groups/feishu_prd-review-dev/CLAUDE.md  # Expected: ~384 行
```

- [ ] **Step 3: sed 调整路径前缀 — PRD-review 专属**

```bash
# 分支前缀：fix/recruit-lite- → fix/prd-review-
sed -i.bak 's/fix\/recruit-lite-/fix\/prd-review-/g' groups/feishu_prd-review-dev/CLAUDE.md

# Skill 源码路径：recruitment_requirement_define_lite → prd-review
sed -i.bak 's/recruitment_requirement_define_lite/prd-review/g' groups/feishu_prd-review-dev/CLAUDE.md

# Commit prefix: fix(recruit-lite) → fix(prd-review)
sed -i.bak 's/fix(recruit-lite)/fix(prd-review)/g' groups/feishu_prd-review-dev/CLAUDE.md

# 删 .bak
rm -f groups/feishu_prd-review-dev/CLAUDE.md.bak
```

- [ ] **Step 4: 验证调整**

```bash
grep -c "fix/prd-review-\|prd-review skill" groups/feishu_prd-review-dev/CLAUDE.md
# Expected: ≥ 2
grep "recruit-lite" groups/feishu_prd-review-dev/CLAUDE.md
# Expected: 空（已全替换）
```

---

## Task 3: 验证 Fix 群本地一字未动

**Files:** 无改动，纯验证。

- [ ] **Step 1: git diff 检查**

```bash
git diff groups/feishu_recruit-lite-fix/CLAUDE.md
# Expected: 空（一字未动）
```

---

## Task 4: 拼接验收

- [ ] **Step 1: PRD-review 拼接后总行数**

```bash
echo "PRD-review 本地: $(wc -l < groups/feishu_prd-review-dev/CLAUDE.md)"
echo "global: $(wc -l < groups/global/CLAUDE.md)"
echo "拼接总: $(($(wc -l < groups/feishu_prd-review-dev/CLAUDE.md) + $(wc -l < groups/global/CLAUDE.md)))"
# Expected: 拼接 ~744 行（PRD 384 + global 360）
# Fix 群拼接 574 行参考 — PRD 多 ~170 行因为 global 加了 76 行被 read 两次
```

- [ ] **Step 2: 关键段重复曝光验证**

```bash
cat groups/feishu_prd-review-dev/CLAUDE.md groups/global/CLAUDE.md | grep -c "Nine 会话链接（强制规则）"
# Expected: 2（本地 1 次 + global 1 次 = 重复曝光）

cat groups/feishu_prd-review-dev/CLAUDE.md groups/global/CLAUDE.md | grep -c "写代码 / 改 Nine 项目（强制规则）"
# Expected: 2
```

---

## Task 5: 收尾（Phase 8）

- [ ] **Step 1: build + restart nanoclaw**

```bash
cd <worktree>
npm run build  # 应 0 errors（这次没改 .ts）
# 主目录 pull 并重启
```

- [ ] **Step 2: commit + push + PR**

```bash
git add groups/global/CLAUDE.md groups/feishu_prd-review-dev/CLAUDE.md docs/superpowers/plans/2026-06-10-group-claudemd-specificity.md
git commit -m "feat(claude-md): uplift PRD-review group specificity to match Fix group"
git push -u origin feat/group-claudemd-specificity
gh pr create --repo brookgao/nanoclaw --base main ...
```

- [ ] **Step 3: 等用户 merge 指令**

---

## Self-Review

### Spec coverage
✅ Fix 群三段进 global / PRD-review 本地完整 copy + 专属保留 / 路径调整 / Fix 群不动 / 拼接重复曝光验证

### 风险点
1. **global 涨到 ~360 行**：但 Fix 群证据显示重复 OK。可接受。
2. **sed 路径替换**：可能匹配到不想替换的位置（如解释文本里）。在 Step 4 用 grep 验证。
3. **「Topic」段起点定位**：用 `^## Topic` 第一次出现作为分界。PRD-review 文件结构稳定，可靠。
