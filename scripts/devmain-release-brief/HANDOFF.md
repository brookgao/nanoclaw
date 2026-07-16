# 六维改造 · 交接文档

> 写于 2026-07-16。本文档随 `feat/devmain-brief-6dim` 分支存放，与代码同处一地。
> 每条状态都可自验（文末有命令）——不要信复述，跑一下就知道。
> 建议**新开干净会话**从这里继续（长上下文容易出错，这不是玄学，是省 token + 降错率）。

## 一句话现状
1. **可读性版简报已上线**：每晚 19:55 定时任务发 Nine沟通群（线上跑的是 `main` 上的 collect.py，本 worktree 的改动尚未合 main）。
2. **六维改造：纯函数层已完成并提交**——commit `9b1703c`，22 测试通过（本会话真实核实）。
3. **六维改造：编排层未做**——纯函数已写好但还没接进 `main()`；`--pair`、`branch_audit`、三条发布线输出、SPEC 升级都待做。

## 下次开场白
> 继续六维改造。worktree `~/nanoclaw-worktrees/devmain-6dim`（分支 `feat/devmain-brief-6dim`，HEAD `9b1703c`），读 `scripts/devmain-release-brief/HANDOFF.md`，从编排层往下走 DOTA。

---

## ✅ 已完成（真实，已提交在 9b1703c）

collect.py 已加 6 个纯函数（行 92–141），test_collect.py 22 passed：
- `is_irreversible_migration(text)` — DROP/TRUNCATE/DELETE + ORM drop_column/drop_table，剥行注释防误报
- `is_config_file(path)` — .env / docker-compose / .github/workflows / Dockerfile / *.conf
- `has_wip_marker(subjects)` — WIP / fixup! / squash! / DO NOT MERGE / TEMP / 临时·调试提交
- `parse_pair_arg(spec)` — `label=path:base..head` → 四元组
- `classify_reverse(subject, head_branch)` — release（发布合并到 head）/ other_pr（其它 PR 合并）/ hotfix（仅非 merge 的直接提交）

自验：
```bash
grep -nE "def (is_irreversible_migration|is_config_file|has_wip_marker|parse_pair_arg|classify_reverse)" \
  ~/nanoclaw-worktrees/devmain-6dim/scripts/devmain-release-brief/collect.py
cd ~/nanoclaw-worktrees/devmain-6dim/scripts/devmain-release-brief && python3 -m pytest test_collect.py -q
```

## ❌ 未做（下次起点）——编排层 + SPEC + 验证

collect.py 现在仍是 `collect_repo(name,path,now)` + `main()` 用 `--repo name=path`（固定比 origin/main..origin/dev）。要改成：

1. **多分支对（三条发布线）**：`main()` 从 `--repo` 改成 `--pair label=path:base..head`（`parse_pair_arg` 已就绪），把 `collect_repo` 泛化成 `collect_line(label, path, base, head, now)`，输出顶层从单仓改成 `lines[]`。三条线：
   - nine 主平台：`origin/main..origin/dev`
   - **nine · 小招招聘 Agent**：`origin/recruit-agent/prod..origin/recruit-agent/dev`（同 nine 仓的另一对分支，部署 .137，已接 GitHub CI/CD）
   - nine-recruit-api：`origin/main..origin/dev`
2. **`branch_audit(path, base)` — force-push / 回滚审计**（六维里 ⑥审计 + ②分支的确凿信号）：走 GitHub activity API 查 `refs/heads/<base>` 的 force_push 事件，**翻多页防滑窗**（只查最近 100 条会漏，这是 review 已指出的点）。另加：疑似回滚（base 久未更新 + head 领先超阈值）、未回流 hotfix。
3. **接入 `classify_reverse`（关键·防误报）**：`reverse_commits` 的结果按三分类计数。**只有 hotfix（非 merge 直接提交）才报"发前必须对齐"**；release/other_pr 只计数不告警。
   - 背景：小招线 `prod` 领先 `dev` 54，其中 46 个是功能 PR 的 merge。旧逻辑（反向=hotfix）会把这 46 个全误报成 CRITICAL，日报没法看。这是上一轮 review 抓到的真 bug，`classify_reverse` 就是为修它写的。
4. **SPEC.md 升级**：从 v1（单仓 main..dev）升到「三条发布线 + 六维告警」，输出结构描述改成 `lines[]`。

---

## 🧭 呈现设计（已定稿，照做）

日报三块，每块一条发布线：
```
📋 今日生产发布建议 · M-D
├─ 🔷 nine（主平台）          dev → main
├─ 🔷 nine · 小招 Agent        recruit-agent/dev → recruit-agent/prod
└─ 🔷 nine-recruit-api         dev → main
```

每块内部固定五段顺序：
1. **结论**（建议发/别发 + 为什么 + 发前必做）+ 距离（head 领先 base N 提交 / M 待发 PR）
2. **⚠️ 异常告警**（合并块，每条挂 [维度]；全空→一行绿字"分支健康"）：force-push / 疑似回滚 / 发布积压 / 未回流 hotfix
3. **⚠️ 发布风险**（每条必归人：什么风险 + 谁的什么 PR/文件）：不可逆迁移 / schema 迁移 / 配置变动 / 超大 PR / 多人同改 / revert / WIP
4. **📦 大改动·按主线**（压缩：综述 + 聚合数 N PR/M 行 + 点名 1–3 关键 PR + 主要负责人；小改动一句"其余 N 个（涉及 X、Y）"带过）
5. **⏳ 待合入 PR（发布前可等）**：谁的什么 open PR + days_stale；无则"无需等，可发"

标题第二行 head_sha，第三行六维图例；末尾六维体检小结。

**风格铁律**：中文为主、英文 slug 当索引、**禁造词**（不许"反向雷""缓发"这种自造术语）、说人话。

**明确不做**（YAGNI）：dev/prod 配置漂移体检、密钥扫描（交 GitHub Secret Scanning）、生产实际值校验（交部署流水线）。

---

## ⚠️ 待清理 / 关联

- **nine-recruit-api main 被回滚**：issue TierIITech/nine-recruit-api#707——`zyue0956-bit` 于 7-10 21:56 force-push 把 main 回退到 6-25，约两周 52 个 PR 从 main 丢失。待其确认主动/误操作；误操作需恢复到 `535985ca6`。这也正是 `branch_audit` 要自动抓的场景。
- **上一轮教训**：超长会话里我曾生成过假的"测试通过/commit"叙述。下次每步用真实 grep/pytest 核实，别"自动一口气推进"多步不看输出。

## 自验命令（以这些实际输出为准）
```bash
git -C ~/nanoclaw-worktrees/devmain-6dim log --oneline -3
git -C ~/nanoclaw-worktrees/devmain-6dim branch --show-current   # feat/devmain-brief-6dim
grep -nE "def (collect_line|branch_audit)|--pair" \
  ~/nanoclaw-worktrees/devmain-6dim/scripts/devmain-release-brief/collect.py   # 空=编排层没做
sqlite3 ~/Desktop/vibe-coding/nanoclaw/store/messages.db \
  "SELECT id,schedule_value,next_run,status FROM scheduled_tasks WHERE id='devmain-release-brief';"
```
