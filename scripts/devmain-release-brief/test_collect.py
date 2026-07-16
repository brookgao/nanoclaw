# -*- coding: utf-8 -*-
"""dev->main 采集器 · 纯解析层 + fail-fast 的 fixture 测试。"""
from datetime import datetime, timezone
import pytest
import collect


# --- 纯解析层(可脱离 git 单测)---

def test_is_schema_file_hits_migrations_and_sql():
    assert collect.is_schema_file("app/migrations/0001_init.py")
    assert collect.is_schema_file("db/schema.sql")
    assert collect.is_schema_file("service/migration.py")


def test_is_schema_file_ignores_plain_and_docs():
    assert not collect.is_schema_file("app/models.py")
    assert not collect.is_schema_file("docs/migrations-guide.md")


def test_parse_pr_subject_standard_merge():
    assert collect.parse_pr_subject(
        "Merge pull request #4107 from TierIITech/feat/battle-map"
    ) == ("4107", "feat/battle-map")


def test_parse_pr_subject_non_merge_graceful():
    assert collect.parse_pr_subject("feat: add thing (#123)") == (None, None)


def test_dedup_authors_case_insensitive():
    assert collect.dedup_authors(["Jacob", "jacob", "Alice", " alice "]) == {"jacob", "alice"}


def test_compute_days_stale():
    now = datetime(2026, 7, 15, tzinfo=timezone.utc)
    assert collect.compute_days_stale("2026-07-10T00:00:00Z", now) == 5
    assert collect.compute_days_stale("2026-07-10T00:00:00+00:00", now) == 5


def test_parse_numstat_sums_and_skips_binary():
    # 普通行累加,二进制 "-\t-" 跳过增删但计入文件数
    text = "12\t3\tsrc/a.py\n0\t5\tsrc/b.py\n-\t-\tassets/logo.png"
    assert collect.parse_numstat(text) == (12, 8, 3)


def test_parse_numstat_empty():
    assert collect.parse_numstat("") == (0, 0, 0)


def test_numstat_net_excludes_test_and_generated():
    # 净 churn 排除 test/生成物:只算 src/a.py(10,2)+ src/core.go(20,3)
    text = ("10\t2\tsrc/a.py\n"
            "50\t0\tsrc/a_test.py\n"          # 排除:test
            "30\t5\tpackages/dist/bundle.js\n"  # 排除:dist 生成物
            "8\t1\tapp/tests/test_b.py\n"       # 排除:tests 目录
            "9\t9\tpnpm-lock.yaml\n"            # 排除:lock
            "20\t3\tsrc/core.go")
    assert collect.numstat_net(text) == (30, 5)


def test_numstat_net_keeps_migrations():
    # 迁移是有意义的改动,不排除
    text = "5\t0\tserver/backend/migrations/2026_x.sql"
    assert collect.numstat_net(text) == (5, 0)


def test_parse_authors_subjects():
    text = "大杰\x01feat: Moss 卡片改版\njacob\x01fix: 修复登录\n大杰\x01feat: 加 DDL"
    authors, subjects = collect.parse_authors_subjects(text)
    assert authors == ["大杰", "jacob"]                       # 去重、原序
    assert subjects == ["feat: Moss 卡片改版", "fix: 修复登录", "feat: 加 DDL"]


def test_parse_authors_subjects_empty():
    assert collect.parse_authors_subjects("") == ([], [])


# --- fail-fast(git / fetch / gh)---

def test_fetch_raises_on_nonzero(monkeypatch):
    class R:
        returncode = 1
        stderr = "fatal: could not read from remote"
    monkeypatch.setattr(collect.subprocess, "run", lambda *a, **k: R())
    with pytest.raises(collect.FetchError):
        collect.fetch("/tmp/whatever")


def test_fetch_ok_on_zero(monkeypatch):
    class R:
        returncode = 0
        stderr = ""
    monkeypatch.setattr(collect.subprocess, "run", lambda *a, **k: R())
    collect.fetch("/tmp/whatever")  # 不抛即通过


def test_gh_json_raises_on_nonzero(monkeypatch):
    class R:
        returncode = 1
        stdout = ""
        stderr = "gh: authentication required"
    monkeypatch.setattr(collect.subprocess, "run", lambda *a, **k: R())
    with pytest.raises(collect.GhError):
        collect.gh_json(["gh", "pr", "list"], "/tmp/whatever")


def test_sh_raises_on_nonzero(monkeypatch):
    class R:
        returncode = 128
        stdout = ""
        stderr = "fatal: bad revision 'origin/dev'"
    monkeypatch.setattr(collect.subprocess, "run", lambda *a, **k: R())
    with pytest.raises(collect.GitError):
        collect.sh(["git", "rev-parse", "origin/dev"], "/tmp/whatever")


def test_sh_ok_returns_stdout(monkeypatch):
    class R:
        returncode = 0
        stdout = "  a1b2c3d\n"
        stderr = ""
    monkeypatch.setattr(collect.subprocess, "run", lambda *a, **k: R())
    assert collect.sh(["git", "rev-parse", "--short", "origin/dev"], "/tmp/x") == "a1b2c3d"


# --- 六维检测(纯函数)---

def test_is_irreversible_migration():
    assert collect.is_irreversible_migration("ALTER TABLE users DROP COLUMN nick;")
    assert collect.is_irreversible_migration("drop table old_logs;")
    assert collect.is_irreversible_migration("TRUNCATE sessions;")
    assert collect.is_irreversible_migration("DELETE FROM audit WHERE ts<0;")
    assert collect.is_irreversible_migration("op.drop_column('users','nick')")
    assert not collect.is_irreversible_migration("CREATE TABLE t (id int);")
    assert not collect.is_irreversible_migration("op.add_column('t','x')")
    # 注释里的关键词不该误报
    assert not collect.is_irreversible_migration("# 别 DELETE FROM 了\nADD COLUMN y int;")


def test_is_config_file():
    assert collect.is_config_file(".env.example")
    assert collect.is_config_file("deploy/docker-compose.prod.yml")
    assert collect.is_config_file(".github/workflows/deploy.yml")
    assert collect.is_config_file("Dockerfile")
    assert not collect.is_config_file("src/app.py")
    assert not collect.is_config_file("README.md")


def test_has_wip_marker():
    assert collect.has_wip_marker(["feat: x", "WIP: 调试"])
    assert collect.has_wip_marker(["fixup! earlier"])
    assert collect.has_wip_marker(["DO NOT MERGE - temp"])
    assert not collect.has_wip_marker(["feat: 正常", "fix: 修 bug"])


def test_parse_pair_arg():
    assert collect.parse_pair_arg("nine=/p/nine:origin/main..origin/dev") == \
        ("nine", "/p/nine", "origin/main", "origin/dev")
    assert collect.parse_pair_arg("小招=/p/nine:origin/recruit-agent/prod..origin/recruit-agent/dev") == \
        ("小招", "/p/nine", "origin/recruit-agent/prod", "origin/recruit-agent/dev")
    with pytest.raises(ValueError):
        collect.parse_pair_arg("bad-no-range")


def test_classify_reverse():
    assert collect.classify_reverse("Merge pull request #1 from TierIITech/dev", "dev") == "release"
    assert collect.classify_reverse(
        "Merge pull request #2 from TierIITech/recruit-agent/dev", "recruit-agent/dev") == "release"
    assert collect.classify_reverse("Merge pull request #3 from TierIITech/feat/x", "dev") == "other_pr"
    assert collect.classify_reverse("fix: 直接改 base 的 hotfix", "dev") == "hotfix"
