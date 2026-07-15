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
