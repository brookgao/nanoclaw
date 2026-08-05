"""Read-only release preflight helpers for the nine dev→main report."""
import json
import os
import re
import subprocess


_ENV_DIFF = re.compile(r"^[+-]([A-Za-z_][A-Za-z0-9_]*)=", re.M)
_CREATE = re.compile(r"\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`\w.]+", re.I)
_ALTER = re.compile(r"\bALTER\s+TABLE\s+([`\w.]+)\s+(.+?)(?:;|$)", re.I | re.S)
_DATA = re.compile(r"\b(?:UPDATE|DELETE\s+FROM|TRUNCATE\s+TABLE|INSERT\s+INTO)\s+([`\w.]+)", re.I)


def _table(token):
    return token.rsplit(".", 1)[-1].strip("`")


def parse_ddl(diff_text):
    """Return conservative, literal-free descriptions of DDL/data changes."""
    rows = []
    for match in _CREATE.finditer(diff_text):
        rows.append({"kind": "create_table", "table": _table(match.group(0).split()[-1]),
                     "risk": "low", "reason": "新建表，仍需确认生产不存在同名表"})
    for match in _ALTER.finditer(diff_text):
        table, action = _table(match.group(1)), match.group(2).upper()
        if "DROP" in action:
            kind, risk, reason = "drop_column", "high", "删除结构，MySQL DDL 不能事务回滚"
        elif "INDEX" in action or "KEY" in action:
            kind, risk, reason = "alter_index", "medium", "索引调整可能占用表资源"
        else:
            kind, risk, reason = "alter_table", "medium", "列结构调整可能锁表或耗时"
        rows.append({"kind": kind, "table": table, "risk": risk, "reason": reason})
    for match in _DATA.finditer(diff_text):
        rows.append({"kind": "data_migration", "table": _table(match.group(1)),
                     "risk": "high", "reason": "数据迁移需确认数据量、执行窗口和回滚方案"})
    return rows


def changed_env_keys(diff_text):
    return {match.group(1) for match in _ENV_DIFF.finditer(diff_text)
            if not diff_text[match.start():].startswith(("+++", "---"))}


def compare_runtime_env(test_env, prod_env, keys):
    return {
        "added": sorted(key for key in keys if key not in test_env and key in prod_env),
        "removed": sorted(key for key in keys if key in test_env and key not in prod_env),
        "modified": sorted(key for key in keys if key in test_env and key in prod_env and test_env[key] != prod_env[key]),
    }


def failed_preflight(reason, has_relevant_change):
    return {
        "status": "unverified",
        "risk": "unverified",
        "reason": str(reason)[:200],
        "requires_manual_confirmation": bool(has_relevant_change),
    }


ENVIRONMENTS = {
    "test": ("10.117.5.134", "nine-blue-backend"),
    "prod": ("10.117.0.159", "nine-backend"),
}


def _ssh(host, command):
    return subprocess.run(
        ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "IdentitiesOnly=yes",
         "-i", os.path.expanduser("~/.ssh/id_ed25519"), "root@" + host, command],
        capture_output=True, text=True, timeout=20, check=True,
    ).stdout


def _container_env(host, container):
    text = _ssh(host, "docker inspect %s --format '{{range .Config.Env}}{{println .}}{{end}}'" % container)
    return dict(line.split("=", 1) for line in text.splitlines() if "=" in line)


def _table_metadata(host, container, tables):
    if not tables:
        return []
    quoted = ",".join(json.dumps(t) for t in sorted(tables))
    program = (
        "import json,os,pymysql; c=pymysql.connect(host=os.environ['DB_HOST'],port=int(os.environ.get('DB_PORT','3306')),"
        "user=os.environ['DB_USER'],password=os.environ['DB_PASSWORD'],database=os.environ['DB_NAME']); "
        "q=\"SELECT table_name,table_rows,data_length,index_length FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN (%s)\"; "
        "cur=c.cursor();cur.execute(q);print(json.dumps([dict(zip(('table','rows','data_bytes','index_bytes'),r)) for r in cur.fetchall()]))"
    ) % quoted
    out = _ssh(host, "docker exec %s python3 -c %s" % (container, json.dumps(program)))
    return json.loads(out)


def collect_nine_preflight(cwd, base, head, risk):
    schema = [row["file"] for row in risk.get("schema_changes", [])]
    config = [row["file"] for row in risk.get("config_changes", [])]
    if not schema and not config:
        return {"status": "not_applicable", "risk": "low", "reason": "本次无 DDL 或环境配置改动"}
    try:
        diffs = []
        for path in schema + config:
            diffs.append(subprocess.run(["git", "diff", "%s..%s" % (base, head), "--", path], cwd=cwd,
                                        capture_output=True, text=True, check=True).stdout)
        ddl = parse_ddl("\n".join(diffs))
        keys = changed_env_keys("\n".join(diffs))
        test_host, test_container = ENVIRONMENTS["test"]
        prod_host, prod_container = ENVIRONMENTS["prod"]
        env_diff = compare_runtime_env(_container_env(test_host, test_container),
                                       _container_env(prod_host, prod_container), keys)
        prod_tables = _table_metadata(prod_host, prod_container, {row["table"] for row in ddl})
        sizes = {row["table"]: row for row in prod_tables}
        for row in ddl:
            size = sizes.get(row["table"])
            if row["risk"] == "medium" and size and (int(size.get("rows") or 0) >= 1000000 or
                                                       int(size.get("data_bytes") or 0) + int(size.get("index_bytes") or 0) >= 1073741824):
                row["risk"] = "high"
                row["reason"] = "生产大表上的结构或索引调整，需确认锁表和执行窗口"
        risk_level = "high" if any(row["risk"] == "high" for row in ddl) else ("medium" if ddl or any(env_diff.values()) else "low")
        return {"status": "ok", "risk": risk_level, "ddl": ddl, "production_tables": prod_tables,
                "environment": env_diff, "requires_manual_confirmation": risk_level in {"medium", "high"}}
    except (subprocess.SubprocessError, OSError, ValueError, json.JSONDecodeError, KeyError) as error:
        return failed_preflight("只读预检不可用：%s" % str(error), True)
