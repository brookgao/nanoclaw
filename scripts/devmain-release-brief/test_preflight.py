import preflight


def test_parse_ddl_classifies_create_alter_and_destructive_statements():
    rows = preflight.parse_ddl(
        "CREATE TABLE jobs (id bigint); ALTER TABLE users ADD INDEX ix_name (name); "
        "ALTER TABLE users DROP COLUMN old; UPDATE users SET state='x';"
    )
    assert [(row["kind"], row["risk"]) for row in rows] == [
        ("create_table", "low"),
        ("alter_index", "medium"),
        ("drop_column", "high"),
        ("data_migration", "high"),
    ]
    assert {row["table"] for row in rows} == {"jobs", "users"}


def test_changed_env_keys_uses_only_added_or_removed_assignments():
    assert preflight.changed_env_keys(
        "+++ b/.env\n+LLM_RPM=99\n-DB_PASSWORD=old\n # ignore\n"
    ) == {"LLM_RPM", "DB_PASSWORD"}


def test_env_comparison_never_returns_values():
    result = preflight.compare_runtime_env(
        {"LLM_RPM": "10", "DB_PASSWORD": "test"},
        {"LLM_RPM": "20", "DB_PASSWORD": "prod"},
        {"LLM_RPM", "DB_PASSWORD"},
    )
    assert result == {"added": [], "removed": [], "modified": ["DB_PASSWORD", "LLM_RPM"]}
    assert "test" not in repr(result)
    assert "prod" not in repr(result)


def test_failed_preflight_is_unverified_and_blocks_direct_release():
    result = preflight.failed_preflight("ssh failed", True)
    assert result["status"] == "unverified"
    assert result["risk"] == "unverified"
    assert result["requires_manual_confirmation"] is True
