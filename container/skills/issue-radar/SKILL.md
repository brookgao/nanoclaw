---
name: issue-radar
description: 每天扫 159 产研或 137 小招的 feishu bot 会话，主动发现用户未上报的问题，按处理人分类，播报飞书群。用户说"扫问题/问题雷达/看看今天用户遇到什么问题"时触发。
---

# 会话问题雷达

每天扫目标机器上所有 feishu bot 会话，用你（NanoClaw 的 Claude）亲自读逐字稿，发现用户遇到但没上报的问题，按"该谁处理"归类，跨天去重盯趋势，播报同一个飞书群。对源库**只读**。

| 来源 | SSH target | 卡片标题 | X-Ray 基址 | history | Bitable table |
|---|---|---|---|---|---|
| 159 产研 | `root@ssh-metal.heasenbug.com` | `产研会话问题雷达` | `https://nine.95fenapp.com/dev/context/` | `/Users/admin/.issue-radar/history.jsonl` | `tblMpHuhUhpIM5ql` |
| 137 小招招聘 | `root@10.117.5.137` | `小招会话问题雷达` | `http://10.117.5.137/dev/context/` | `/Users/admin/.issue-radar/recruit-137-history.jsonl` | `tblpMebdGAZllsLn` |

两份日报必须使用各自的任务、history、X-Ray 和子表；仅共享群目的地和通用 radar 代码。137 子表可增加招聘专属的`问题类型`选项；两个子表都不得覆盖人工维护字段。

> **脚本位置**：本 skill 随 NanoClaw 仓走，运行时被 host-runner 同步进 `groups/<group>/.claude/skills/issue-radar/`。下面 `radar.py` / `pull_in_container.py` 都指本 skill 目录内的同名文件——执行前先 `cd` 到本 skill 目录（即本 `SKILL.md` 所在目录），或用绝对路径。

## 运行步骤（每步等上一步产物）

1. **拉数据**：`scp ./pull_in_container.py root@ssh-metal.heasenbug.com:/tmp/`（`./` = 本 skill 目录）→ `docker cp /tmp/pull_in_container.py nine-backend:/tmp/` → `docker exec -w /app -e PYTHONPATH=/app nine-backend python /tmp/pull_in_container.py` → 存 stdout 为 `pulled.json`。默认扫昨天；`python /tmp/pull_in_container.py 2026-07-17` 扫指定日。
2. **粗筛**：`python3 radar.py prefilter pulled.json candidates.json`（宿主用 `python3`；仅容器内 `docker exec … nine-backend python` 用 `python`）。
3. **读判（你亲自做）**：读 `candidates.json` 每个候选的 `compact`，按下方判据产出 `issues.json`（扁平 list）。**一个候选可产出 0..N 条 Issue**（一段会话常同时有多个不同问题、不同 owner，逐个拆独立 Issue，不合并）；判无真问题产 0 条。前情（`[前情]` 行）只帮你判根因，**不因前情旧报错单独产 Issue**（归属是当天）。
4. **出报/去重**：先干跑 `python3 radar.py report issues.json history.jsonl --window-day <日> --scanned <N> --candidates <M> --title <来源标题> --xray-base <来源X-Ray基址> --bitable-out bitable_rows.json` 看卡片；确认无误加 `--send` 真发。（同日重复 `--send` 已幂等：当日计数覆盖不翻倍。）`--bitable-out` 会把去重后的行写到 `bitable_rows.json`（供第 5 步用；干跑也会写）。159 不传两个来源参数时保留产研默认值。
5. **写台账（多维表格）**：`ISSUE_RADAR_BASE_TOKEN=<bt> ISSUE_RADAR_TABLE_ID=<tb> python3 bitable_sync.py bitable_rows.json`（或用 `--base-token/--table-id`）。按 `SourceID`(=指纹) upsert：同类问题永远一行，复发次数/影响人数/最近发现随天累加更新，**只写 radar 字段，绝不碰人工列（解决状态/负责人/DDL/PR/备注）**。任一行失败即 fail-fast（非零退出+明细），人工重试。base/table 见 `config.example.json`。
6. 清理当前来源机器的 `/tmp` 临时文件。

> **群卡片 vs 台账**：群卡片是"每日提醒"（当天扫到什么），多维表格是"跟进台账"（沉淀+人工标解决/复发趋势分析）。两者都发；台账按问题去重，一个问题一行跟到底。

## Issue 结构（第 3 步产出）

每条：`{owner, category, symptom_class, severity(high/mid/low), summary, evidence, user, conversation_id, root_cause_hint}`

- `summary`：一句人话，说清"大概什么问题"。
- `evidence`（原文）：**必须是自然语言**——用户的原话、或报错里那句人能看懂的话（如"权限不足，feishu_sheet 未授权，请联系管理员"）。**不要贴生 JSON**（如 `{"status":"auth_required","auth_url":""}`）；若原始报错是 JSON，抽出里面那句可读的 message/summary 文本填进来。≤200 字。目的是让读者**直接看原文就看穿问题**。

## owner 分类判据（该谁处理）

- **平台**：产品/工具本身故障——`SKILL_EXECUTOR_UNAVAILABLE`、工具超时、工具不存在、`不支持的 action`。→ 平台团队修。
- **管理员**：授权/配置缺失——skill 未授权、`未授权`确系用户真缺权限。→ 给用户开权限。
- **模型**：模型自己犯错——猜错技能名/表名/字段/路径、无脑重试触发死循环。→ 优化 prompt/skill。
- **结果质量**：结果算错/答非所问，用户当场纠正。→ 看数据口径/skill 逻辑。
- **其他**：能力边界摩擦等。

## ⚠️ 分类关键坑

`数仓表未授权(jiuwu_sc)` 有两态，别无脑归"管理员"：
- 平台 bug 误拒（`_check_live_grant` 曾 KeyError 吞成"无权限"，PR#4180/#4202 才修）→ owner=**平台**
- 用户真缺该 ODPS 表权限 → owner=**管理员**

判据：同一用户同表**反复被拒且报错形态是内部异常**偏平台 bug；权限卡片正常展示申请链接偏真缺权限。拿不准标 severity 低 + root_cause_hint 写"需人工确认平台bug/真缺权限"。

## symptom_class 命名（受控词表——保证跨天去重不失效）

⚠️ 指纹**只**靠 symptom_class 跨天去重（owner 不进指纹——责任方判断会漂，如"数仓表未授权"平台↔管理员两态，进指纹会裂行）。所以 symptom_class 这个名字是**唯一**的去重锚点：若你每天给同一问题起不同名，复发就算不出。**规则：优先从下表（及台账已有"问题类型"列）选已知名；只有确属全新类型才自造名，自造后务必沿用同一名字**。owner 照常判、只作展示，判错不影响去重。

- 已知名（尽量复用）：重新授权、数仓表未授权、技能执行器不可用、工具执行超时、工具不存在/action不支持、猜错技能名、猜错表名/字段、代码检索路径错、SQL执行失败、无某能力权限、结果算错
- 新类型：起一个简短稳定的名（名词短语，别带当天具体值），root_cause_hint 写"新类型待归因"

## 已知症状→根因映射

- 重新授权/授权过期 → OAuth scope 缺失 / token 被烧 / CCVM 无持久登录 / token scope 冻结
- 数仓表未授权 → 两态（见上"分类关键坑"）：平台 bug 误拒 vs 用户真缺权限
