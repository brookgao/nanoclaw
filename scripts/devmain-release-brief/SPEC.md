# dev→main 发布决策简报 · 归纳规范（v2 · 三条发布线 + SRE 六维）

定时任务（每晚 19:55，feishu_dm）跑 `collect.py` 出 `devmain-digest/v2` JSON，再按本文件归纳成简报**发用户 DM**（阿飞不跨群，用户自行转发进群）。

**三条发布线**（每条独立一块，结构相同）：

| 块标题 | base → head |
|---|---|
| 🔷 nine（主平台） | main ← dev |
| 🔷 nine · 小招招聘 Agent | recruit-agent/prod ← recruit-agent/dev（部署 .137，已接 CI/CD） |
| 🔷 nine-recruit-api | main ← dev |

## 一、数据契约 `devmain-digest/v2`

顶层 `{schema, generated_at, lines:[...]}`。每个 line 对象：

| 字段 | 含义 |
|---|---|
| `line` | 发布线标题（如 `nine` / `小招Agent` / `nine-recruit-api`） |
| `base` / `head` | 对比的两分支 refspec（如 `origin/main` / `origin/dev`） |
| `head_sha` | head short-sha（新鲜度指纹） |
| `dev_ahead_base` | head 比 base 多几个提交（**=待发布量；0 则本线无需发布**） |
| `base_ahead_dev` | base 比 head 多几个提交（反向，见 reverse_commits） |
| `base_stale_days` | base 分支最后一次提交距今天数 |
| `base_last_merge` | base 上次 merge 提交 `{date, subject}`（≈上次发布/合主分支；填进简报基本信息「上次发布」）|
| `pending_merged_prs[]` | 已合进 head、base 还没有的 PR；含 `pr/branch/authors/subjects/merged_by/date/files_changed/insertions/deletions/net_churn/merge_hash`。**`authors`**=PR 真实作者（**归人用这个**）；**`subjects`**=commit 中文标题；**`net_churn`**=排 test/生成物净增删；⚠️`merged_by` 是合并人不是作者 |
| `reverse_commits.real_hotfixes[]` | **仅非 merge 直接提交**（含 `files`）——真·带外改动 |
| `reverse_commits.release_merges[]` | 发布合并到 head 的 merge（无害，仅计数） |
| `reverse_commits.other_pr_merges[]` | 其它 PR 的 merge（仅计数，**不是 hotfix，别报"必须对齐"**） |
| `open_prs_targeting_dev[]` | 还没合的 open PR；含 `number/title/author/is_draft/days_stale` |
| `risk.schema_changes[]` | 动了 DB 迁移的文件，每项 `{file, authors}`（authors 已归人，直接用） |
| `risk.irreversible_migrations[]` | 含破坏性 DDL（DROP/TRUNCATE/DELETE）的 schema 文件，每项 `{file, authors}`——③数据安全/⑤可回滚 |
| `risk.config_changes[]` | 部署/环境配置文件（.env/compose/CI/Dockerfile），每项 `{file, authors}`——④配置环境 |
| `risk.wip_prs[]` | subject 含 WIP/临时标记的 PR——①变更风险 |
| `risk.big_prs[]` / `risk.multi_author_files[]` / `risk.reverted_prs[]` | 超大 PR / 多人同改文件 / 本轮 revert（同 v1） |
| `branch_audit.force_pushes[]` | base 分支的 force-push 事件；每条含 `actor/before/after/timestamp/days_ago`——⑥审计 |

## 二、归纳指令

**输出形态（2026-07-16 定稿）**：归纳层**不直接吐 markdown**，而是产出**结构化 data**（字段见 `build_card.py` 顶部「数据契约」：每条发布线 `{repo, branch, last_release_label, last_release, conclusion, sections[4]}`，每节 `{n, title, safe, body}`），交 `build_card.py` 渲染成飞书卡片并发送。**卡片字号 / 结构 / 留白 / ✅ 规则全部固化在 `build_card.py` 的注释里，改样式改那里，本文件只管「每个字段填什么」。** 本节以下的阈值 / 归人 / 收口规则 = 决定各字段该填什么内容。

**呈现结构**（build_card 已实现，此处帮理解字段落位）：卡片标题 `📋 今日生产发布建议 · M-D` → 全局行（各线 head_sha + 采集时间 + 六维图例）→ 每仓一块：`【仓库】名`（大）+ 基本信息（**分支** / **上次发布**=base_last_merge / **结论**）+ 4 个同级小节（`1 异常告警` `2 发布风险` `3 大改动` `4 待合入 PR`）→ 末尾 `🩺 三线总检`。小节安全无事 → `safe:true`（标题挂 ✅、body 写该节自己的「无XXX」）；有事 → `safe:false`、body 列告警项。

**目的**：让人一眼决定「今晚该不该发 main / prod」。

**说人话第一（最重要）**：全程日常中文，**禁止自造词/行话**（「反向雷」「缓发」这类一律不许）；每个技术点一句大白话讲清，像当面跟同事说。中文为主，英文 slug/PR# 只当括号里的索引。是给人看的周报，不是 git log dump。

**开头**：第一行标题 `📋 今日生产发布建议 · <M-D>`；第二行「基于各线 head @ `<head_sha>`（<采集时间>）」；第三行六维图例：`按 SRE 六维：①变更 ②分支 ③数据 ④配置 ⑤回滚 ⑥审计`。

下面是各字段该填什么（`结论` + 4 个 `sections` 的 `body`/`safe`）：

**结论**（基本信息块）：先看 `dev_ahead_base`——
- `dev_ahead_base == 0` → 本线**无待发布内容**，`conclusion` 写「✅ 无需发布（dev 无领先 base 的提交）」；4 小节多数 `safe:true`（标题挂 ✅），反向提交（含 real_hotfixes）是 base 现存历史、**不作发布阻塞、不逐条列**（唯 force-push 等真告警仍进小节 1）。
- `dev_ahead_base > 0` → 写「建议发」或「先别发」+ 为什么 + 发前要做的 1-2 件事；补一句距离「dev 领先 base N 提交 / M 待发 PR」。

**小节 1 · 异常告警**（`safe:false` 时 body 列告警，每条挂 [维度] 标签；**按下列确定性阈值判，不自由裁量**；全不触发→ `safe:true`、body 写「分支健康：无 force-push、无发布积压」）：
- 🔴 **疑似回滚 [⑥/②]**：`branch_audit.force_pushes` 有 `days_ago <= 14` 的 → 点名 actor + `before→after` + 日期（main/prod 正常不该被强推，这是最强告警；#707 即此类）。更早的 force-push 不报。
- 📉 **发布积压 [②]**：`dev_ahead_base > 100`。
- 📉 **base 久未更新 [②]**：`base_stale_days > 14`。
- ⚠️ **未回流 hotfix [②]**：`reverse_commits.real_hotfixes` 非空 → 大白话说这几个直接提交改了啥（谁），并写「发前先把 base 合回 head，重点看部署配置别覆盖线上已修的」。`release_merges`/`other_pr_merges` **只做背景计数、不告警**。

**小节 2 · 发布风险·逐条归人**（每条「什么风险 + 谁的什么 PR/文件」；无风险 → `safe:true`、body 写「无风险项」或列出清白维度）：
- 🔴 **不可逆迁移 [③/⑤]**：`risk.irreversible_migrations` → 「含 DROP/TRUNCATE，发坏退不回」+ 直接用该项 `authors` 归人。
- 🟡 **schema 迁移 [①]**：`risk.schema_changes` → 「触发 DB 迁移，需 DBA 确认」+ 用该项 `authors` 归人。
- 🟡 **配置变动 [④]**：`risk.config_changes` → 「动了部署/环境配置」+ 用该项 `authors` 归人 + 「注意同步 prod」。
- 🟡 **超大 PR [①]**：`risk.big_prs` 逐条点名 + `authors` + `files` 说动了哪些模块。
- 🟡 **多人同改 [①]**：`risk.multi_author_files` → 「<文件> 被 X/Y/Z 同改，回归」。
- 🟡 **revert [①]**：`risk.reverted_prs` → 「本轮 revert 了什么（谁），确认已排除」。
- 🟡 **WIP/临时提交 [①]**：`risk.wip_prs` → 「#N 含临时提交（谁），确认是否该发」。

**小节 3 · 大改动·按主线**（压缩，绝不逐个 PR 罗列；无待发布 → `safe:true`、body 写「无大改动」）：把 `pending_merged_prs` 按功能域归几条主线，每条=一小段综述：在干嘛（`subjects` 中文综合）+ 聚合数「N 个 PR / 约 M 行」（M 用 `net_churn` 合计）+ 点名 1-3 关键 PR（`#号`,作者）+ 主要负责人（`authors`，「主要 by 大杰」，别用 `merged_by`）。单文件 bugfix/文案/typo/依赖 bump → 末尾「其余 N 个小改动（涉及 X、Y）」一句带过。
> 正例：**Boss 简历回捞/推荐（主要 by milo+Jacob · 12 PR / ~2.6 万行）**：回捞 worker 前台抢占与死信重做、推荐页状态机、判重改姓名+geekID。关键：#682 死信重做(milo)、#671 竞态加固(jacob)。

**小节 4 · 待合入 PR（发布前可等）**：`open_prs_targeting_dev`。无 → `safe:true`、body 写「无 open PR，可发」。有则：
- **≤ ~8 个**：直接列，谁的什么 PR + `days_stale`；小的「快完成，建议等」，老的「拖很久，下轮」。
- **多（如 >8）→ 按作者归组**（首行「共 N 个 open PR」，然后每个作者一条）：`· 作者（个数）：近期几个关键 #号+短标题（带天数，推进中）；⚠️ 点出最老/该清的（days_stale）`。**每个作者最多 3 行**，PR 多的作者只挑近期活跃 + 最老的点名，中间的省略或聚合，别逐个罗列。按作者 open PR 数从多到少排。

**总检（`summary`）**：一行说哪几线/哪几维触警、健康与否，最重的排前。build_card 渲染成末尾「🩺 三线总检」。



## 三、已知口径与局限

- `pending_merged_prs` 靠 `git log base..head --merges` + `Merge pull request #N` 识别，假设标准 GitHub merge commit；squash/rebase 合并会漏报。
- **reverse 三分类**：`real_hotfixes` = base 有 head 没有的**非 merge 直接提交**。⚠️ 在 base 与 head 关系非常规的线（如小招 recruit-agent，prod 领先 dev 很多），这里会包含大量 prod 独有的普通历史提交（feat/fix/test），**它们不是待回流的 hotfix**——所以 `dev_ahead_base==0` 时本字段不作发布阻塞（见 §二「结论」）。
- `force_pushes` 用 `gh api --paginate` 翻全部页拼接（无窗口/条数限制，force-push 事件本就极稀）；`days_ago<=14` 才进告警。
- `schema_changes`/`config_changes`/`irreversible_migrations` 的文件集取自**被发布的提交**（`git log base..head --no-merges` 所动文件），非两端树 diff——避免把 base 侧单独改的文件（base/dev 分叉）误报，且每项能归到 dev 侧作者。极端情形：仅在 merge commit 里做的冲突解决改动会漏（罕见）。
- `irreversible_migrations` 仅扫 schema 文件的 **diff 新增行**（非 schema 文件里的裸 SQL、已存在未改动的破坏性 DDL 不查）。
- `multi_author_files` 作者仅按小写 name 去重；`big_prs` churn 含 test/生成物；`reverted_prs` 双路检测（极端情形会漏）。

## 四、深挖命令清单（在对应仓目录跑）

| 想搞清楚 | 命令 |
|---|---|
| 某 PR 具体改了啥 | `gh pr view <PR号> --json files,additions,deletions,body` 或 `git show <merge_hash>` |
| 某迁移危不危险 | `git diff <base>..<head> -- <迁移文件>`（看新增行的 drop/delete/truncate） |
| 多人同改会不会真冲突 | `git log -p <base>..<head> -- <文件>` |
| 某 open PR 的 CI 过没过 | `gh pr checks <PR号>` |
| force-push 是不是回滚 | `gh api repos/<slug>/activity?ref=refs/heads/<base>&activity_type=force_push`（比 before/after 看是否往回退） |
