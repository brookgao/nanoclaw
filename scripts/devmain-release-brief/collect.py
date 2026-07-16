#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dev->main 发布决策简报 · 客观数据采集器(不调用 LLM)
依赖: git, gh(已登录);仅用 python 标准库。

用法:
  python3 collect.py --pair nine=/path/nine:origin/main..origin/dev \
                     --pair 小招Agent=/path/nine:origin/recruit-agent/prod..origin/recruit-agent/dev \
                     --pair nine-recruit-api=/path/api:origin/main..origin/dev --out out.json

失败即非零退出(fail-fast):任一线 git fetch / gh / 其它 git 命令失败 → 抛错 → 退出码非零。
"""
import argparse, json, re, subprocess, sys
from datetime import datetime, timezone

BIG_PR_LINES = 2000
MULTI_AUTHOR_MIN = 3
SCHEMA_PAT = re.compile(r'(\bmigrations?/|migrations?\.py$|\.sql$)', re.I)
_PR_PAT = re.compile(r"Merge pull request #(\d+) from \S+?/(\S+)")


class GitError(RuntimeError):
    pass


class FetchError(RuntimeError):
    pass


class GhError(RuntimeError):
    pass


# --- 纯解析层(可脱离 git 单测)---

def is_schema_file(path):
    return bool(SCHEMA_PAT.search(path))


def parse_pr_subject(subject):
    m = _PR_PAT.search(subject)
    return (m.group(1), m.group(2)) if m else (None, None)


def dedup_authors(names):
    return {n.strip().lower() for n in names if n and n.strip()}


def compute_days_stale(updated_at_iso, now):
    upd = datetime.fromisoformat(updated_at_iso.replace("Z", "+00:00"))
    return (now - upd).days


def parse_numstat(text):
    # git diff --numstat:每行 "added\tdeleted\tpath";二进制文件为 "-\t-\tpath"。
    # locale 无关(不像 --shortstat 依赖英文 "insertion/deletion")。
    ins = dele = files = 0
    for ln in text.splitlines():
        parts = ln.split("\t")
        if len(parts) < 3:
            continue
        files += 1
        a, d = parts[0], parts[1]
        if a.isdigit():
            ins += int(a)
        if d.isdigit():
            dele += int(d)
    return ins, dele, files


# 净 churn 排除:test 文件 + 生成物/lock(迁移/普通源码保留),避免体量虚高。
_NET_EXCLUDE = re.compile(
    r'(node_modules|(^|/)(dist|build|vendor)/|-lock\.|(^|/)[^/]*lock\.(json|ya?ml)$'
    r'|go\.(sum|mod)$|\.min\.|\.pb\.go$|_pb2|\.(svg|snap|map)$|generated'
    r'|(^|/)tests?/|(^|/)test_[^/]*\.py$|_test\.(py|go|ts|tsx)$|\.(test|spec)\.[tj]sx?$)', re.I)


def numstat_net(text):
    ins = dele = 0
    for ln in text.splitlines():
        parts = ln.split("\t")
        if len(parts) < 3:
            continue
        a, d, path = parts[0], parts[1], parts[2]
        if _NET_EXCLUDE.search(path):
            continue
        if a.isdigit():
            ins += int(a)
        if d.isdigit():
            dele += int(d)
    return ins, dele


_IRREVERSIBLE_SQL = re.compile(
    r'\b(DROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT|DATABASE|SCHEMA)|TRUNCATE|DELETE\s+FROM)\b', re.I)
_IRREVERSIBLE_ORM = re.compile(r'\b(drop_column|drop_table|drop_constraint|drop_index)\s*\(', re.I)


def is_irreversible_migration(text):
    # ③数据安全/⑤可回滚:破坏性迁移(发坏了数据回不来)。先剥行注释(# 和 --)防误报。
    stripped = "\n".join(re.sub(r'(#|--).*$', '', ln) for ln in text.splitlines())
    return bool(_IRREVERSIBLE_SQL.search(stripped) or _IRREVERSIBLE_ORM.search(stripped))


_CONFIG_PAT = re.compile(
    r'(^|/)(\.env(\.|$)|docker-compose[^/]*\.ya?ml$|Dockerfile|[^/]*\.conf(\.template)?$'
    r'|nginx[^/]*\.(conf|template))|(^|/)\.github/workflows/', re.I)


def is_config_file(path):
    # ①变更风险/④配置环境:部署/环境配置文件
    return bool(_CONFIG_PAT.search(path))


_WIP_PAT = re.compile(r'(\bWIP\b|\bfixup!|\bsquash!|DO\s*NOT\s*MERGE|\bTEMP\b|临时提交|调试提交)', re.I)


def has_wip_marker(subjects):
    # ①变更风险:临时/未完成提交混入
    return any(_WIP_PAT.search(s or "") for s in subjects)


def parse_pair_arg(spec):
    # "label=path:base..head" → (label, path, base, head)。一条发布线 = 一仓一对分支对比。
    try:
        label, rest = spec.split("=", 1)
        path, rng = rest.rsplit(":", 1)
        base, head = rng.split("..", 1)
    except ValueError:
        raise ValueError("pair 格式应为 label=path:base..head,得到:%r" % spec)
    if not (label and path and base and head):
        raise ValueError("pair 各字段不能为空:%r" % spec)
    # base/head 必须是 remote-tracking ref(origin/*):fetch 刷新的是 refs/remotes/origin/*,
    # 若传裸分支名 rev-list/log 会读本地旧分支 → 成功但静默旧数据(fail-fast 之外的隐性坑)。
    if not (base.startswith("origin/") and head.startswith("origin/")):
        raise ValueError("base/head 必须以 origin/ 开头(remote-tracking ref):%r" % spec)
    return label, path, base, head


def classify_reverse(subject, head_branch):
    # base 有 head 没有的提交分类:release(发布合并)/ other_pr(其它 PR 合并)/ hotfix(非 merge 直接提交)
    if re.match(r"Merge pull request #\d+ from \S+?/%s$" % re.escape(head_branch), subject):
        return "release"
    if re.match(r"Merge pull request #\d+ from ", subject):
        return "other_pr"
    return "hotfix"


def remote_branch(ref):
    # "origin/recruit-agent/dev" → "recruit-agent/dev";无 origin/ 前缀原样返回
    return ref[len("origin/"):] if ref.startswith("origin/") else ref


def parse_force_pushes(json_text):
    # gh activity API 已服务端过滤 activity_type=force_push;此处防御性再过滤。days_ago 由 branch_audit 补。
    out = []
    for a in json.loads(json_text or "[]"):
        if a.get("activity_type") != "force_push":
            continue
        out.append({"actor": (a.get("actor") or {}).get("login", "?"),
                    "before": (a.get("before") or "")[:8],
                    "after": (a.get("after") or "")[:8],
                    "timestamp": a.get("timestamp", "")})
    return out


def parse_authors_subjects(text):
    # 解析 "git log --format=%an\x01%s" 输出 → (去重作者原序, subject 列表)
    authors, seen, subjects = [], set(), []
    for ln in text.splitlines():
        if "\x01" not in ln:
            continue
        an, s = ln.split("\x01", 1)
        an = an.strip()
        if an and an.lower() not in seen:
            seen.add(an.lower())
            authors.append(an)
        if s.strip():
            subjects.append(s.strip())
    return authors, subjects


# --- git 副作用层(全 fail-fast)---

def sh(args, cwd):
    # 所有 git 命令(rev-list/log/diff/rev-parse)非零退出即 fail-fast;
    # 不用 --quiet/--exit-code,正常成功都是 rc=0(空 stdout 合法,如 log 无提交)。
    r = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    if r.returncode != 0:
        raise GitError("git failed in %s: %s: %s" % (cwd, " ".join(args), (r.stderr or "").strip()))
    return r.stdout.strip()


def fetch(cwd, base, head):
    rb, rh = remote_branch(base), remote_branch(head)
    # 显式 refspec:保证 refs/remotes/origin/* 被刷新。裸 `git fetch origin <br>` 可能只更
    # FETCH_HEAD 不动 remote-tracking → 后续 origin/base..origin/head 用旧数据(成功但静默错)。
    r = subprocess.run(["git", "fetch", "origin",
                        "+%s:refs/remotes/origin/%s" % (rb, rb),
                        "+%s:refs/remotes/origin/%s" % (rh, rh), "--quiet"],
                       cwd=cwd, capture_output=True, text=True)
    if r.returncode != 0:
        raise FetchError("git fetch failed in %s: %s" % (cwd, (r.stderr or "").strip()))


def gh_json(args, cwd):
    r = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    if r.returncode != 0:
        raise GhError("gh failed in %s: %s" % (cwd, (r.stderr or "").strip()))
    return r.stdout.strip()


def head_sha(cwd, head):
    return sh(["git", "rev-parse", "--short", head], cwd)


def repo_slug(cwd):
    return gh_json(["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], cwd)


def branch_audit(cwd, base, now):
    slug = repo_slug(cwd)
    ref = "refs/heads/" + remote_branch(base)
    # 注:/activity 返回 JSON **数组**,gh api --paginate 对数组响应自动**合并多页为单一数组**
    # (实测 per_page=1 强制 4 页 → json.loads 得单 list len=4),故无需 --slurp;
    # --slurp 只对**对象**响应需要。json.loads 直接可解析。
    j = gh_json(["gh", "api", "--paginate",
                 "repos/%s/activity?ref=%s&activity_type=force_push&per_page=100" % (slug, ref)], cwd)
    fps = parse_force_pushes(j)
    for fp in fps:
        fp["days_ago"] = compute_days_stale(fp["timestamp"], now) if fp["timestamp"] else None
    return {"force_pushes": fps}


# --- 编排层 ---

def pending_prs(cwd, base, head):
    out = sh(["git", "log", "%s..%s" % (base, head), "--merges",
              "--format=%H%x01%an%x01%cI%x01%s"], cwd)
    prs = []
    for line in filter(None, out.splitlines()):
        h, an, ci, s = line.split("\x01")
        pr, branch = parse_pr_subject(s)
        numstat = sh(["git", "diff", "--numstat", h + "^1", h], cwd)
        ins, dele, fch = parse_numstat(numstat)
        net_ins, net_dele = numstat_net(numstat)
        # authors = PR 分支 commits 的真实作者(归责任人用);subjects = commit 标题(多为中文,给 agent 说人话素材)。
        authors, subjects = parse_authors_subjects(
            sh(["git", "log", h + "^1.." + h, "--no-merges", "--format=%an%x01%s"], cwd))
        # merged_by = merge commit 的 %an(点合并的人),不是 PR 作者。
        prs.append({"pr": pr, "branch": branch, "authors": authors, "subjects": subjects[:8],
                    "merged_by": an, "date": ci, "subject": s, "files_changed": fch,
                    "insertions": ins, "deletions": dele, "net_churn": net_ins + net_dele,
                    "merge_hash": h})
    return prs


def reverse_commits(cwd, base, head, head_branch):
    out = sh(["git", "log", "%s..%s" % (head, base),
              "--format=%H%x01%an%x01%cI%x01%s"], cwd)
    release, other_pr, hotfix = [], [], []
    for line in filter(None, out.splitlines()):
        h, an, ci, s = line.split("\x01")
        rec = {"hash": h[:9], "author": an, "date": ci, "subject": s}
        cls = classify_reverse(s, head_branch)
        if cls == "release":
            release.append(rec)
        elif cls == "other_pr":
            other_pr.append(rec)
        else:
            # 仅真 hotfix(非 merge 直接提交)取 files 并告警;release/other_pr 只计数,防误报。
            rec["files"] = [f for f in sh(["git", "-c", "core.quotepath=false", "diff", "--name-only", h + "^1", h], cwd).splitlines() if f]
            hotfix.append(rec)
    return {"release_merges": release, "other_pr_merges": other_pr, "real_hotfixes": hotfix}


def open_prs(cwd, head, now):
    j = gh_json(["gh", "pr", "list", "--base", remote_branch(head), "--state", "open",
                 "--json", "number,title,author,isDraft,updatedAt", "--limit", "100"], cwd)
    res = []
    for p in json.loads(j or "[]"):
        res.append({"number": p["number"], "title": p["title"],
                    "author": (p["author"] or {}).get("login", "?"), "is_draft": p["isDraft"],
                    "updated_at": p["updatedAt"], "days_stale": compute_days_stale(p["updatedAt"], now)})
    return sorted(res, key=lambda x: x["days_stale"])


def risk_scan(cwd, base, head, pending):
    rng = "%s..%s" % (base, head)
    # 文件集从**被发布的提交**(dev-not-base 的非 merge 提交)取,同时得到 file→authors。
    # 不用 `git diff base..head --name-only`:那是两端树差异,会把 base 侧单独改的文件也算进来
    # (base/dev 分叉)→ 假阳性风险 + 无 dev 侧作者可归。这里只看"dev 真正改了什么"。
    log = sh(["git", "-c", "core.quotepath=false", "log", rng, "--no-merges",
              "--format=%x02%an", "--name-only"], cwd)
    cur, fa = None, {}
    for ln in log.splitlines():
        if ln.startswith("\x02"):
            cur = ln[1:].strip()
        elif ln.strip() and cur:
            fa.setdefault(ln, []).append(cur)
    deduped = {f: sorted(dedup_authors(a)) for f, a in fa.items()}
    files = sorted(deduped)
    schema = sorted({f for f in files if is_schema_file(f)})
    multi = sorted(({"file": f, "authors": au} for f, au in deduped.items()
                    if len(au) >= MULTI_AUTHOR_MIN), key=lambda x: -len(x["authors"]))
    big = []
    for p in pending:
        if p["insertions"] + p["deletions"] > BIG_PR_LINES:
            fl = sh(["git", "-c", "core.quotepath=false", "diff", "--name-only", p["merge_hash"] + "^1", p["merge_hash"]], cwd).splitlines()
            big.append({"pr": p["pr"], "subject": p["subject"], "files_changed": p["files_changed"],
                        "churn": p["insertions"] + p["deletions"],
                        "files": [f for f in fl if f][:25], "merge_hash": p["merge_hash"]})
    # revert 两路识别:① merge 提交 subject 匹配 revert——注意 %s 是 "Merge pull request #N from owner/分支名",
    #   命中的实际是**分支名**(如 revert/xxx),不是 PR 标题;② 直接 Revert "..." 提交(git revert 产物,在 --no-merges 里)。
    # 局限:PR 标题写 revert 但分支非 revert-* 且无 Revert 提交的极端情形会漏(真 PR 标题需 gh pr view 逐个取,107 PR 太贵,不做;归纳层不确定可 gh 深挖)。
    reverted = [{"pr": p["pr"], "subject": p["subject"], "kind": "merge-pr"} for p in pending
                if re.search(r"revert", p["subject"], re.I)]
    for s in sh(["git", "log", rng, "--no-merges", "--format=%s"], cwd).splitlines():
        if re.match(r'^Revert ', s):
            reverted.append({"pr": None, "subject": s, "kind": "commit"})
    # 六维扩展:④配置变动 / ③⑤不可逆迁移 / ①WIP
    config = sorted({f for f in files if is_config_file(f)})
    irreversible = []
    for f in schema:
        # 用 git diff 扫**加行**(而非 git show 全文):diff 对 diff 内文件永不失败 → 无 try/except → fail-fast 完整。
        diff = sh(["git", "-c", "core.quotepath=false", "diff", rng, "--", f], cwd)
        added = "\n".join(ln[1:] for ln in diff.splitlines()
                          if ln.startswith("+") and not ln.startswith("+++"))
        if is_irreversible_migration(added):
            irreversible.append(f)
    wip = [{"pr": p["pr"], "subjects": [s for s in p["subjects"] if has_wip_marker([s])]}
           for p in pending if has_wip_marker(p["subjects"])]

    # 归人:用 deduped(file→authors,上面 multi_author 已建)给风险文件挂作者,
    # 否则归纳层拿到裸文件名无法"每条风险归到人"(pending_merged_prs 不带每 PR 文件列表)。
    def with_authors(paths):
        return [{"file": f, "authors": deduped.get(f, [])} for f in paths]
    return {"schema_changes": with_authors(schema), "big_prs": big,
            "multi_author_files": multi[:15], "reverted_prs": reverted,
            "config_changes": with_authors(config),
            "irreversible_migrations": with_authors(irreversible), "wip_prs": wip}


def collect_line(label, path, base, head, now):
    # 一条发布线 = 一仓一对分支对比(base..head)。三条线:nine main..dev / nine recruit-agent/prod..dev /
    # nine-recruit-api main..dev。
    fetch(path, base, head)
    pending = pending_prs(path, base, head)
    hb = remote_branch(head)
    return {"line": label, "base": base, "head": head, "head_sha": head_sha(path, head),
            "dev_ahead_base": int(sh(["git", "rev-list", "--count", "%s..%s" % (base, head)], path) or 0),
            "base_ahead_dev": int(sh(["git", "rev-list", "--count", "%s..%s" % (head, base)], path) or 0),
            "base_stale_days": compute_days_stale(sh(["git", "log", "-1", "--format=%cI", base], path), now),
            "pending_merged_prs": pending,
            "reverse_commits": reverse_commits(path, base, head, hb),
            "open_prs_targeting_dev": open_prs(path, head, now),
            "risk": risk_scan(path, base, head, pending),
            "branch_audit": branch_audit(path, base, now)}


def main():
    # 注:--pair 的 path 由调用方(定时任务 prompt)传入,约定用 ~/nanoclaw-worktrees/ 下路径。
    # 本脚本不做路径 allowlist:它是通用只读 git 工具、subprocess 全 list 形式(无 shell 注入);
    # "只能走 guard-safe 路径" 由 host-guard(Bash 层拦 ~/Desktop/vibe-coding/)+ 任务 prompt 双重 enforce,不在此重复。
    ap = argparse.ArgumentParser()
    ap.add_argument("--pair", action="append", required=True,
                    help="label=path:base..head,可多次(一条发布线一个)")
    ap.add_argument("--out", default="-")
    a = ap.parse_args()
    now = datetime.now(timezone.utc)
    lines = [collect_line(*parse_pair_arg(spec), now) for spec in a.pair]
    doc = {"schema": "devmain-digest/v2", "generated_at": now.isoformat(), "lines": lines}
    txt = json.dumps(doc, ensure_ascii=False, indent=2)
    if a.out == "-":
        print(txt)
    else:
        with open(a.out, "w", encoding="utf-8") as f:
            f.write(txt)
        print("written: " + a.out, file=sys.stderr)


if __name__ == "__main__":
    main()
