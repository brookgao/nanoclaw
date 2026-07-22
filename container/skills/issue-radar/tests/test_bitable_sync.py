"""bitable_sync 纯函数单测:链接归一化 + 合并去重。子进程/CLI 部分不在此测。"""
import bitable_sync as bs


def test_norm_link_plain():
    assert bs._norm_link("https://x/ctx/abc") == "https://x/ctx/abc"


def test_norm_link_markdown():
    # 飞书把纯 URL 存成 [url](url),归一抽裸 URL
    assert bs._norm_link("[https://x/ctx/abc](https://x/ctx/abc)") == "https://x/ctx/abc"


def test_norm_link_whitespace():
    assert bs._norm_link("  https://x/ctx/abc  ") == "https://x/ctx/abc"


def test_norm_link_strips_date_prefix():
    assert bs._norm_link("2026-07-16 https://x/ctx/abc") == "https://x/ctx/abc"


def test_norm_link_strips_date_and_markdown():
    assert bs._norm_link("2026-07-15 [https://x/ctx/abc](https://x/ctx/abc)") == "https://x/ctx/abc"


def test_merge_links_dedup_across_dates_keeps_original():
    # 同一 URL 不同日期/格式 → 去重(按裸 URL),保留最先出现的原行(带日期)
    today = ["2026-07-16 https://x/ctx/a"]
    existing = "2026-07-15 [https://x/ctx/a](https://x/ctx/a)"
    out = bs.merge_links(today, existing).split("\n")
    assert out == ["2026-07-16 https://x/ctx/a"]   # 同一条只留一份,今天的在前(带日期)


def test_merge_links_dedup_plain_vs_markdown():
    # 今天纯 URL 与旧的 markdown 形式是同一条 → 只留一条
    today = ["https://x/ctx/a"]
    existing = "[https://x/ctx/a](https://x/ctx/a)\nhttps://x/ctx/b"
    out = bs.merge_links(today, existing).split("\n")
    assert out == ["https://x/ctx/a", "https://x/ctx/b"]   # 今天在前,去重后 2 条


def test_merge_links_order_today_first():
    out = bs.merge_links(["https://x/ctx/new"], "https://x/ctx/old").split("\n")
    assert out == ["https://x/ctx/new", "https://x/ctx/old"]


def test_merge_links_cap():
    today = [f"https://x/ctx/{i}" for i in range(30)]
    out = bs.merge_links(today, "", cap=20).split("\n")
    assert len(out) == 20


def test_merge_links_empty_existing():
    out = bs.merge_links(["https://x/ctx/a"], "").split("\n")
    assert out == ["https://x/ctx/a"]


def test_merge_links_skips_blank_lines():
    out = bs.merge_links(["https://x/ctx/a"], "\n\n  \n").split("\n")
    assert out == ["https://x/ctx/a"]
