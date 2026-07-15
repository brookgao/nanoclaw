# dev→main 发布决策简报 · 归纳规范

定时任务(每晚 19:55,feishu_dm)跑 `collect.py` 出 `devmain-digest/v1` JSON,再按本文件归纳成简报**发用户 DM**(阿飞不跨群,用户自行转发进群)。

## 一、数据契约 `devmain-digest/v1`

顶层 `{schema, generated_at, repos:[...]}`。每个 repo 对象:

| 字段 | 含义 |
|---|---|
| `repo` | 仓名 |
| `dev_head` | `origin/dev` short-sha(新鲜度指纹,fetch 后即取) |
| `dev_ahead_main` / `main_ahead_dev` | dev 比 main 多/少几个提交 |
| `pending_merged_prs[]` | 已合进 dev、main 还没有的 PR;含 `pr/branch/author/date/files_changed/insertions/deletions/merge_hash` |
| `reverse_commits.real_hotfixes[]` | ⚠️ 只在 main 未回流 dev 的真 hotfix(含 `files`)——发前必须对齐 |
| `reverse_commits.harmless_release_merges[]` | 过去发布产生的合并提交(无害) |
| `open_prs_targeting_dev[]` | 还没合的 PR;含 `number/title/author/is_draft/days_stale` |
| `risk.schema_changes[]` | 动了 DB 迁移的文件 |
| `risk.big_prs[]` | 增删 >2000 行的超大 PR(含 `files`、`merge_hash`) |
| `risk.multi_author_files[]` | 被 ≥3 人同时改的文件(作者已大小写去重) |
| `risk.reverted_prs[]` | 含 revert 的 PR |

> **前提**:`pending_merged_prs` 靠 `git log --merges` + `Merge pull request #N` 识别,假设两仓走标准 GitHub merge commit;squash/rebase 合并会漏报。

## 二、归纳指令

人话、举实例。开头一句「基于 dev @ <各仓 dev_head>」。每仓输出:

1. **距离 main 总览**:`dev_ahead_main` 提交 / `pending_merged_prs` 个待发布 PR。
2. **⚠️ 反向雷**(`real_hotfixes` 非空时):列出 + 硬写「发 main 前先把 main merge 回 dev 对齐,重点看部署配置(deploy/compose)冲突,别覆盖线上修复」。
3. **待发布内容·按功能主线归类**:从 subject/branch 归纳几条主线,每条一句摘要 + 标重点负责人。
4. **发布风险·决策发不发**:
   - `schema_changes` → 「会触发线上 DB 迁移,需 DBA 确认」
   - `big_prs` → 逐条点名,看 `files` 判断动了哪些模块
   - `multi_author_files` → 「被多人同时改,合并冲突/副作用需回归」
   - `reverted_prs` → 「本轮有被 revert 的功能,确认是否已排除」
5. **等谁·决策发还是缓**:`open_prs_targeting_dev` 里 `days_stale` 小且非 draft → 「接近完成建议等」,提醒作者;停很久/draft → 下轮。
6. **结论**:每仓一句「今晚建议发/缓 + 发前必做 + 等谁」。

> `real_hotfixes` 空且无 schema/大 PR/多人同改 → 直接「可安全发布」。信息不够别硬猜,现场跑下面深挖命令看内容再下结论。

## 三、深挖命令清单(在对应仓目录跑)

| 想搞清楚 | 命令 |
|---|---|
| 某 PR 具体改了啥 | `gh pr view <PR号> --json files,additions,deletions,body` 或 `git show <merge_hash>` |
| 某迁移危不危险 | `git show origin/dev:<迁移文件路径>`(看 drop/delete/alter) |
| 多人同改会不会真冲突 | `git log -p origin/main..origin/dev -- <文件>` |
| 某 open PR 的 CI 过没过 | `gh pr checks <PR号>` |
| 反向 hotfix 会不会被覆盖 | `git log origin/dev -- <hotfix碰的文件>` |
