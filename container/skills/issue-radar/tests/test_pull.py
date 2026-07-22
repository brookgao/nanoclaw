"""pull_in_container.py 纯函数单测（惰性 import 让 sqlalchemy/app 依赖不加载）。"""
import datetime

import pull_in_container as pull


def test_window_explicit_day():
    day, start, end = pull._window("2026-07-17")
    assert day == "2026-07-17"
    assert start == datetime.datetime(2026, 7, 17, 0, 0)
    assert end == datetime.datetime(2026, 7, 18, 0, 0)   # 半开区间 [start, end)


def test_content_of_block_list():
    blocks = [{"type": "text", "text": "hi"}]
    assert pull._content_of(blocks, "evt", None) == blocks   # 块列表原样保留


def test_content_of_plain_dict():
    c = {"text": "已有正文"}
    assert pull._content_of(c, "evt", None) == c


def test_content_of_event_payload_fallback():
    # content 无正文 → 从 event_payload 兜底抽 text
    out = pull._content_of({}, "message.delta", {"text": "来自payload"})
    assert out["text"] == "来自payload" and out["_evt"] == "message.delta"


def test_content_of_json_string():
    out = pull._content_of('{"result":"r"}', "evt", None)
    assert out["result"] == "r"


def test_prune_tool_success_truncated():
    big = "x" * 500
    out = pull._prune("tool", {"result": big})   # 成功 tool 结果截头
    assert out["result"].endswith("…[成功结果已截]")
    assert len(out["result"]) < 500


def test_prune_error_tool_not_success_truncated():
    big = "x" * 500
    out = pull._prune("tool", {"result": big, "is_error": True})
    # 报错 tool 不走成功截断，但仍受 _TEXT_CAP(2000) 限制，此处 500 < 2000 不截
    assert out["result"] == big


def test_prune_text_cap():
    big = "y" * 3000
    out = pull._prune("assistant", {"text": big})
    assert out["text"].endswith("…[截]") and len(out["text"]) < 3000


def test_rows_to_msgs_phase_tag():
    rows = [("user", {"text": "hi"}, None, None)]
    out = pull._rows_to_msgs(rows, phase="context")
    assert out[0]["phase"] == "context" and out[0]["role"] == "user"


def test_rows_to_msgs_no_phase():
    rows = [("assistant", {"text": "ok"}, None, None)]
    out = pull._rows_to_msgs(rows)
    assert "phase" not in out[0]
