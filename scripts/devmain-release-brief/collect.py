#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dev->main 发布决策简报 · 客观数据采集器(不调用 LLM)
依赖: git, gh(已登录);仅用 python 标准库。

用法:
  python3 collect.py --repo nine=/path/nine --repo nine-recruit-api=/path/api --out out.json

失败即非零退出(fail-fast):任一仓 git fetch / gh / 其它 git 命令失败 → 抛错 → 退出码非零。
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


# --- git 副作用层(全 fail-fast)---

def sh(args, cwd):
    # 所有 git 命令(rev-list/log/diff/rev-parse)非零退出即 fail-fast;
    # 不用 --quiet/--exit-code,正常成功都是 rc=0(空 stdout 合法,如 log 无提交)。
    r = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    if r.returncode != 0:
        raise GitError("git failed in %s: %s: %s" % (cwd, " ".join(args), (r.stderr or "").strip()))
    return r.stdout.strip()


def fetch(cwd):
    r = subprocess.run(["git", "fetch", "origin", "main", "dev", "--quiet"],
                       cwd=cwd, capture_output=True, text=True)
    if r.returncode != 0:
        raise FetchError("git fetch failed in %s: %s" % (cwd, (r.stderr or "").strip()))


def gh_json(args, cwd):
    r = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    if r.returncode != 0:
        raise GhError("gh failed in %s: %s" % (cwd, (r.stderr or "").strip()))
    return r.stdout.strip()


def dev_head(cwd):
    return sh(["git", "rev-parse", "--short", "origin/dev"], cwd)


# --- 编排层 ---

def pending_prs(cwd):
    out = sh(["git", "log", "origin/main..origin/dev", "--merges",
              "--format=%H%x01%an%x01%cI%x01%s"], cwd)
    prs = []
    for line in filter(None, out.splitlines()):
        h, an, ci, s = line.split("\x01")
        pr, branch = parse_pr_subject(s)
        ins, dele, fch = parse_numstat(sh(["git", "diff", "--numstat", h + "^1", h], cwd))
        # merged_by = merge commit 的 %an(点合并的人),不是 PR 作者;真作者看 branch / gh。
        prs.append({"pr": pr, "branch": branch, "merged_by": an, "date": ci, "subject": s,
                    "files_changed": fch, "insertions": ins, "deletions": dele, "merge_hash": h})
    return prs


def reverse_commits(cwd):
    out = sh(["git", "log", "origin/dev..origin/main",
              "--format=%H%x01%an%x01%cI%x01%s"], cwd)
    harmless, hotfix = [], []
    for line in filter(None, out.splitlines()):
        h, an, ci, s = line.split("\x01")
        rec = {"hash": h[:9], "author": an, "date": ci, "subject": s}
        if re.match(r"Merge pull request #\d+ from \S+?/dev$", s):
            harmless.append(rec)
        else:
            rec["files"] = [f for f in sh(["git", "-c", "core.quotepath=false", "diff", "--name-only", h + "^1", h], cwd).splitlines() if f]
            hotfix.append(rec)
    return {"harmless_release_merges": harmless, "real_hotfixes": hotfix}


def open_prs(cwd, now):
    j = gh_json(["gh", "pr", "list", "--base", "dev", "--state", "open",
                 "--json", "number,title,author,isDraft,updatedAt", "--limit", "100"], cwd)
    res = []
    for p in json.loads(j or "[]"):
        res.append({"number": p["number"], "title": p["title"],
                    "author": (p["author"] or {}).get("login", "?"), "is_draft": p["isDraft"],
                    "updated_at": p["updatedAt"], "days_stale": compute_days_stale(p["updatedAt"], now)})
    return sorted(res, key=lambda x: x["days_stale"])


def risk_scan(cwd, pending):
    files = sh(["git", "-c", "core.quotepath=false", "diff", "--name-only", "origin/main..origin/dev"], cwd).splitlines()
    schema = sorted({f for f in files if is_schema_file(f)})
    big = []
    for p in pending:
        if p["insertions"] + p["deletions"] > BIG_PR_LINES:
            fl = sh(["git", "-c", "core.quotepath=false", "diff", "--name-only", p["merge_hash"] + "^1", p["merge_hash"]], cwd).splitlines()
            big.append({"pr": p["pr"], "subject": p["subject"], "files_changed": p["files_changed"],
                        "churn": p["insertions"] + p["deletions"],
                        "files": [f for f in fl if f][:25], "merge_hash": p["merge_hash"]})
    log = sh(["git", "log", "origin/main..origin/dev", "--no-merges",
              "--format=%x02%an", "--name-only"], cwd)
    cur, fa = None, {}
    for ln in log.splitlines():
        if ln.startswith("\x02"):
            cur = ln[1:].strip()
        elif ln.strip() and cur:
            fa.setdefault(ln, []).append(cur)
    deduped = {f: sorted(dedup_authors(a)) for f, a in fa.items()}
    multi = sorted(({"file": f, "authors": au} for f, au in deduped.items()
                    if len(au) >= MULTI_AUTHOR_MIN), key=lambda x: -len(x["authors"]))
    reverted = [{"pr": p["pr"], "subject": p["subject"]} for p in pending
                if re.search(r"revert", p["subject"], re.I)]
    return {"schema_changes": schema, "big_prs": big,
            "multi_author_files": multi[:15], "reverted_prs": reverted}


def collect_repo(name, path, now):
    fetch(path)
    pending = pending_prs(path)
    return {"repo": name, "dev_head": dev_head(path),
            "dev_ahead_main": int(sh(["git", "rev-list", "--count", "origin/main..origin/dev"], path) or 0),
            "main_ahead_dev": int(sh(["git", "rev-list", "--count", "origin/dev..origin/main"], path) or 0),
            "pending_merged_prs": pending, "reverse_commits": reverse_commits(path),
            "open_prs_targeting_dev": open_prs(path, now), "risk": risk_scan(path, pending)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", action="append", required=True, help="name=path,可多次")
    ap.add_argument("--out", default="-")
    a = ap.parse_args()
    now = datetime.now(timezone.utc)
    repos = [collect_repo(*spec.split("=", 1), now) for spec in a.repo]
    doc = {"schema": "devmain-digest/v1", "generated_at": now.isoformat(), "repos": repos}
    txt = json.dumps(doc, ensure_ascii=False, indent=2)
    if a.out == "-":
        print(txt)
    else:
        with open(a.out, "w", encoding="utf-8") as f:
            f.write(txt)
        print("written: " + a.out, file=sys.stderr)


if __name__ == "__main__":
    main()
