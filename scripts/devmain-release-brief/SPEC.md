# dev→main 发布决策简报 · 归纳规范

定时任务(每晚 19:55,feishu_dm)跑 `collect.py` 出 `devmain-digest/v1` JSON,再按本文件归纳成简报**发用户 DM**(阿飞不跨群,用户自行转发进群)。

## 一、数据契约 `devmain-digest/v1`

顶层 `{schema, generated_at, repos:[...]}`。每个 repo 对象:

| 字段 | 含义 |
|---|---|
| `repo` | 仓名 |
| `dev_head` | `origin/dev` short-sha(新鲜度指纹,fetch 后即取) |
| `dev_ahead_main` / `main_ahead_dev` | dev 比 main 多/少几个提交 |
| `pending_merged_prs[]` | 已合进 dev、main 还没有的 PR;含 `pr/branch/authors/subjects/merged_by/date/files_changed/insertions/deletions/net_churn/merge_hash`。**`authors`**=PR 分支真实作者列表(**归人用这个**);**`subjects`**=该 PR commit 标题列表(**多为中文,说人话的素材**);**`net_churn`**=排除 test/生成物后的净增删(**判"改动面"用**,比 insertions+deletions 更实);⚠️`merged_by` 是**合并人**不是作者,别用它归责任 |
| `reverse_commits.real_hotfixes[]` | ⚠️ 只在 main 未回流 dev 的真 hotfix(含 `files`)——发前必须对齐 |
| `reverse_commits.harmless_release_merges[]` | 过去发布产生的合并提交(无害) |
| `open_prs_targeting_dev[]` | 还没合的 PR;含 `number/title/author/is_draft/days_stale` |
| `risk.schema_changes[]` | 动了 DB 迁移的文件 |
| `risk.big_prs[]` | 增删 >2000 行的超大 PR(含 `files`、`merge_hash`) |
| `risk.multi_author_files[]` | 被 ≥3 人同时改的文件(作者已大小写去重) |
| `risk.reverted_prs[]` | 本轮的 revert。`kind=merge-pr`:merge 提交 subject 命中 revert(实际匹配的是**分支名**如 `revert/xxx`,非 PR 标题);`kind=commit`:直接 `Revert "..."` 提交。**局限**:PR 标题写 revert 但分支非 revert-* 且无 Revert 提交的极端情形会漏(真标题需逐个 gh,太贵不做,归纳层可 gh 深挖)。同一 revert 可能两路各记一条(过报,归纳时按 subject 视为一个) |

> **前提与已知口径**:
> - `pending_merged_prs` 靠 `git log --merges` + `Merge pull request #N` 识别,假设两仓走标准 GitHub merge commit;squash/rebase 合并会漏报。
> - `multi_author_files` 作者仅按**小写 name** 去重(不含 email);一人多 name/email 可能误判(此处用于风险扫描,保守多报可接受)。
> - `big_prs` 的 churn 是**原始增删行**(含 test/生成物),可能虚高——大 diff 本就该细看,不做净源码过滤。

## 二、归纳指令

**目的**:让人一眼决定「今晚该不该发 main」。

**说人话第一(最重要)**:全程用日常中文,**禁止自造词 / 行话**——像「反向雷」「缓发」这种生造术语一律不许用;每个技术点用一句大白话讲清楚,像当面跟同事说。**中文为主**,英文 slug/PR# 只当括号里的索引。像给人看的周报,不是 git log dump。

**开头先给标题**:第一行写标题 `📋 今日生产发布建议 · <M-D>`,第二行写「基于 dev @ <各仓 dev_head>(<采集时间>)」。然后每仓输出:

**① 结论先行**:直接说「**建议今晚发**」或「**今晚先别发**」,再补一句为什么 + 发之前要做的 1-2 件事。

**② 距离总览**:dev 领先 main 多少提交 / 多少待发布 PR;反向多少(见③)。

**③ ⚠️ main 上有 dev 还没有的紧急修复(发前必须先合回来)**(`real_hotfixes` 非空时):用大白话说这几个修复是干嘛的(谁、修了什么线上问题),再硬写一句「发 main 之前,先把 main 合回 dev,重点看部署配置(deploy/compose)有没有冲突,别把线上已经修好的东西又覆盖回去」。

**④ 大改动·按主线**(核心。**要压缩——每条主线写成一小段综述,绝不逐个 PR 罗列,那样太长**):
- **先归主线**:把 `pending_merged_prs` 按功能域归几条主线(如「Moss 管控台」「Boss 简历回捞」「基础设施」),依据 `branch` + `subjects`。
- **每条主线 = 一小段综述,不是 PR 清单**:
  - 一句话说这条线**在干嘛 / 有哪些关键功能**(用 `subjects` 中文综合,别甩英文分支名、别逐条抄 TDD 的 RED/GREEN 提交)。
  - 给**聚合数字**:这条线**共 N 个 PR、约 M 行**(M 用 `net_churn` 合计)。
  - 只**点名 1-3 个关键 PR**(最大或最要紧的),每个一句功能 +(`#号`,作者);**其余 PR 不逐条列**。
  - **归到人**:标这条线主要负责人(`authors`,「主要 by 大杰」),别用 `merged_by`。
- **松口径只用于"算进哪条线的 N/M 聚合"**(改动面还可以就计入:`net_churn`≳100 或 ≥3 文件 或命中风险);**不是要把它们都印出来**。单文件纯 bugfix/文案/typo/依赖 bump → 归到末尾「其余 N 个小改动」一句带过。

正例(一条主线该长这样,注意是综述不是清单):
> **Boss 简历回捞 / 推荐(主要 by milo+Jacob · 12 个 PR / ~2.6 万行)**:回捞 worker 前台抢占与死信重做、推荐页刷新恢复状态机、判重改用姓名+geekID。关键:#682 死信流重做(milo)、#671 竞态加固(jacob)。

**⑤ 发布风险·归到人**(每条都要「什么风险 + 来自谁的什么 PR/文件」):
- `schema_changes` → 「触发线上 DB 迁移,需 DBA 确认」+ 指出是**谁的哪个 PR** 带来的迁移。
- `big_prs`(体量用 net churn 复核)→ 逐条点名 + `authors` + 看 `files` 说动了哪些模块。
- `multi_author_files` → 「<文件> 被 X/Y/Z 同改,合并副作用需回归」(直接点名单里的人)。
- `reverted_prs` → 「本轮 revert 了 <什么>(by 谁),确认已排除」。

**⑥ 等谁**(`open_prs_targeting_dev` = 还没 merge 的 open PR):列出**谁的什么 PR 还开着**(`author` + `title` + `days_stale`);`days_stale` 小的说「快完成,建议等」,老的说「拖很久,下轮」。**确实没有值得等的 → 明说「无需等,可发」,别写「未标注 days_stale 近零项」这种废话。**

> 无反向雷、无 schema/大改/多人同改 → ④⑤可简,直接结论「可安全发布」。信息不够别硬猜,现场跑下面深挖命令看内容(尤其想确认某 PR 到底干嘛、某人是不是真作者时)。

## 三、深挖命令清单(在对应仓目录跑)

| 想搞清楚 | 命令 |
|---|---|
| 某 PR 具体改了啥 | `gh pr view <PR号> --json files,additions,deletions,body` 或 `git show <merge_hash>` |
| 某迁移危不危险 | `git show origin/dev:<迁移文件路径>`(看 drop/delete/alter) |
| 多人同改会不会真冲突 | `git log -p origin/main..origin/dev -- <文件>` |
| 某 open PR 的 CI 过没过 | `gh pr checks <PR号>` |
| 反向 hotfix 会不会被覆盖 | `git log origin/dev -- <hotfix碰的文件>` |
