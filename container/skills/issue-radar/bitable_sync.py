"""按 SourceID upsert 多维表格行。

读 radar.py `report --bitable-out` 吐的 rows.json,每行:
  ① record-list --filter-json 精确匹配 SourceID → 拿到 record_id(如已存在)
  ② 有 record_id 走 PATCH(--record-id),没有走 create
只写 radar 负责的字段,绝不碰人工列(解决状态/负责人/DDL/PR/备注)。走 lark-cli base --as user。

用法:
  python3 bitable_sync.py <rows.json> --base-token <bt> --table-id <tb> [--dry-run]
base-token / table-id 也可用环境变量 ISSUE_RADAR_BASE_TOKEN / ISSUE_RADAR_TABLE_ID。

失败即 fail-fast:任一行写失败 → 打印明细 + 退出码非零,人工重试(不做部分成功静默)。
"""
from __future__ import annotations
import os
import re
import sys
import json
import argparse
import subprocess

_MD_LINK = re.compile(r"^\[.*?\]\((.*?)\)$")
_DATE_PREFIX = re.compile(r"^\d{4}-\d{2}-\d{2}\s+")


def _norm_link(u):
    """归一到裸 URL 作去重键:剥掉日期前缀(YYYY-MM-DD )和飞书 markdown [url](url)。"""
    u = (u or "").strip()
    u = _DATE_PREFIX.sub("", u)          # 剥日期前缀
    m = _MD_LINK.match(u)
    return m.group(1).strip() if m else u


def _run(args, timeout=30):
    r = subprocess.run(["lark-cli", "base", *args, "--as", "user"],
                       capture_output=True, text=True, timeout=timeout)
    out = (r.stdout or "").strip()
    try:
        return json.loads(out)
    except Exception:
        return {"ok": False, "_stdout": out[:800], "_stderr": (r.stderr or "")[:400]}


_LINK_CAP = 20   # 单行"话题链接"最多累积条数(与 radar._LINK_CAP 一致)


def find_record(bt, tb, source_id):
    """按 SourceID 精确匹配 → (record_id, 旧话题链接文本);无匹配则 (None, "")。失败抛异常(fail-fast)。

    record-list 返回列式结构:data.data(行=值数组)+ data.record_id_list(行 id,平行数组)
    + data.fields(列名)。filter 已收窄到匹配行,取第 0 行的 record_id 和"话题链接"格。"""
    flt = json.dumps({"logic": "and", "conditions": [["SourceID", "==", source_id]]}, ensure_ascii=False)
    d = _run(["+record-list", "--base-token", bt, "--table-id", tb,
              "--filter-json", flt, "--format", "json", "--limit", "2"])
    if not d.get("ok"):
        raise RuntimeError(f"SourceID={source_id} 查找失败: {json.dumps(d, ensure_ascii=False)[:300]}")
    data = d.get("data") or {}
    ids = data.get("record_id_list") or []
    if not ids:
        return None, ""
    fields = data.get("fields") or []
    rows = data.get("data") or []
    existing = ""
    if rows and "话题链接" in fields:
        val = rows[0][fields.index("话题链接")]
        if isinstance(val, str):
            existing = val
    return ids[0], existing


def merge_links(today, existing_text, cap=_LINK_CAP):
    """当天链接在前 + 旧链接在后,按裸 URL 去重(容忍日期前缀 + 飞书 markdown 化),保序,截 cap 条。
    保留原行(含日期前缀),而非归一值——这样每条能看出是哪天遇到的。"""
    out, seen = [], set()
    for u in list(today) + (existing_text or "").split("\n"):
        u = u.strip()
        nu = _norm_link(u)
        if nu and nu not in seen:
            seen.add(nu)
            out.append(u)
    return "\n".join(out[:cap])


def upsert_row(bt, tb, row, dry_run):
    source_id = row["source_id"]
    rid, existing_links = find_record(bt, tb, source_id)
    action = "update" if rid else "create"
    if dry_run:
        return action, True, None
    fields = dict(row["fields"])
    if rid:   # 更新:把当天链接并进旧格(去重、截上限),其余字段用今天的最新值
        fields["话题链接"] = merge_links(row.get("links", []), existing_links)
    args = ["+record-upsert", "--base-token", bt, "--table-id", tb,
            "--json", json.dumps(fields, ensure_ascii=False)]
    if rid:
        args += ["--record-id", rid]
    d = _run(args)
    if not d.get("ok"):
        return action, False, json.dumps(d, ensure_ascii=False)[:300]
    return action, True, None


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("rows")
    ap.add_argument("--base-token", default=os.getenv("ISSUE_RADAR_BASE_TOKEN"))
    ap.add_argument("--table-id", default=os.getenv("ISSUE_RADAR_TABLE_ID"))
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    if not a.base_token or not a.table_id:
        print("缺 --base-token / --table-id(或环境变量 ISSUE_RADAR_BASE_TOKEN/ISSUE_RADAR_TABLE_ID)", file=sys.stderr)
        return 2
    rows = json.load(open(a.rows, encoding="utf-8"))
    created = updated = failed = 0
    fails = []
    for row in rows:
        action, ok, err = upsert_row(a.base_token, a.table_id, row, a.dry_run)
        tag = "DRY" if a.dry_run else ("✓" if ok else "✗")
        print(f"  {tag} {action:6} {row['fields'].get('问题类型','?')} (SourceID={row['source_id']})")
        if not ok:
            failed += 1
            fails.append((row["source_id"], err))
        elif action == "create":
            created += 1
        else:
            updated += 1
    print(f"\n汇总:create={created} update={updated} fail={failed} / 共 {len(rows)} 行"
          + ("(dry-run 未写)" if a.dry_run else ""))
    if failed:
        print("失败明细(请人工重试):", file=sys.stderr)
        for sid, err in fails:
            print(f"  SourceID={sid}: {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
