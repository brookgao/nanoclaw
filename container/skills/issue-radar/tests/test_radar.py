"""radar.py 单测：纯函数 + CLI 辅助。覆盖 §5.5 描述的行为面。"""
import json

import radar


def _card_text(card):
    """把卡片里所有 div 的 lark_md content 拼起来，便于断言。"""
    out = []
    for el in card["card"]["elements"]:
        t = el.get("text")
        if t and "content" in t:
            out.append(t["content"])
    return "\n".join(out)


# ---------- 常量 / webhook 开关 ----------

def test_constants():
    assert radar.EVIDENCE_MAX == 200
    assert radar._RETENTION_DAYS == 60
    assert isinstance(radar.SIGNAL_HARD, tuple) and radar.SIGNAL_HARD
    assert isinstance(radar.SIGNAL_USER, tuple) and radar.SIGNAL_USER


def test_webhook_url_set(monkeypatch):
    monkeypatch.setenv("ISSUE_RADAR_WEBHOOK_URL", "https://open.feishu.cn/x")
    assert radar._webhook_url() == "https://open.feishu.cn/x"


def test_webhook_url_unset(monkeypatch):
    monkeypatch.delenv("ISSUE_RADAR_WEBHOOK_URL", raising=False)
    assert radar._webhook_url() is None


def test_webhook_url_whitespace(monkeypatch):
    monkeypatch.setenv("ISSUE_RADAR_WEBHOOK_URL", "   ")
    assert radar._webhook_url() is None


# ---------- _msg_text ----------

def test_msg_text_json_string():
    text, is_err, tcs = radar._msg_text('{"text":"hi"}')
    assert text == "hi" and is_err is False and tcs == []


def test_msg_text_tool_calls():
    text, is_err, tcs = radar._msg_text({"tool_calls": [{"name": "grep"}, {"name": "sql"}]})
    assert tcs == ["grep", "sql"]


def test_msg_text_block_list():
    text, _, _ = radar._msg_text([{"type": "text", "text": "a"}, {"type": "text", "text": "b"}])
    assert text == "a b"


def test_msg_text_is_error():
    _, is_err, _ = radar._msg_text({"result": "boom", "is_error": True})
    assert is_err is True


# ---------- compact ----------

def test_compact_drops_success_tool():
    msgs = [{"role": "tool", "content": {"result": "查询成功一堆数据"}}]
    assert radar.compact(msgs) == ""   # 成功 tool 被丢


def test_compact_keeps_error_tool():
    msgs = [{"role": "tool", "content": {"result": "boom", "is_error": True}}]
    out = radar.compact(msgs)
    assert out.startswith("T⚠:") and "boom" in out


def test_compact_keeps_signal_tool():
    msgs = [{"role": "tool", "content": {"result": "Table not found: x"}}]
    out = radar.compact(msgs)
    assert "T⚠:" in out and "Table not found" in out


def test_compact_context_prefix():
    msgs = [{"role": "user", "content": {"text": "hi"}, "phase": "context"}]
    assert radar.compact(msgs).startswith("[前情] U:")


def test_compact_assistant_tool_call_tag():
    msgs = [{"role": "assistant", "content": {"text": "查一下", "tool_calls": [{"name": "grep"}]}}]
    out = radar.compact(msgs)
    assert "A: 查一下 [调用:grep]" == out


# ---------- prefilter ----------

def test_prefilter_hard_signal():
    sessions = [{"conversation_id": "c1", "messages": [
        {"role": "tool", "content": {"result": "执行失败", "is_error": True}}]}]
    cands = radar.prefilter(sessions)
    assert len(cands) == 1
    assert any("报错行" in r for r in cands[0]["reasons"])
    assert "compact" in cands[0]


def test_prefilter_user_dissatisfaction():
    sessions = [{"conversation_id": "c1", "messages": [
        {"role": "user", "content": {"text": "为什么不行"}}]}]
    cands = radar.prefilter(sessions)
    assert len(cands) == 1 and "用户不满" in cands[0]["reasons"]


def test_prefilter_context_not_counted():
    sessions = [{"conversation_id": "c1", "messages": [
        {"role": "tool", "content": {"result": "执行失败", "is_error": True}, "phase": "context"}]}]
    assert radar.prefilter(sessions) == []   # 前情不产信号


def test_prefilter_clean_session_excluded():
    sessions = [{"conversation_id": "c1", "messages": [
        {"role": "user", "content": {"text": "谢谢"}},
        {"role": "assistant", "content": {"text": "不客气"}}]}]
    assert radar.prefilter(sessions) == []


# ---------- fingerprint ----------

def test_fingerprint_stable_across_summary():
    a = {"owner": "平台", "symptom_class": "技能执行器不可用", "summary": "今天 A"}
    b = {"owner": "平台", "symptom_class": "技能执行器不可用", "summary": "改天 B 措辞全变"}
    assert radar.fingerprint(a) == radar.fingerprint(b)


def test_fingerprint_ignores_owner():
    # owner 漂移不影响指纹:同一 symptom_class、不同 owner 仍算同一问题(否则会裂行)
    a = {"owner": "平台", "symptom_class": "数仓表未授权"}
    b = {"owner": "管理员", "symptom_class": "数仓表未授权"}
    assert radar.fingerprint(a) == radar.fingerprint(b)


def test_fingerprint_symptom_distinguishes():
    a = {"owner": "平台", "symptom_class": "x"}
    b = {"owner": "平台", "symptom_class": "y"}
    assert radar.fingerprint(a) != radar.fingerprint(b)


def test_fingerprint_category_fallback():
    a = {"owner": "平台", "category": "cat"}
    b = {"owner": "平台", "symptom_class": "cat"}
    assert radar.fingerprint(a) == radar.fingerprint(b)


# ---------- apply_history ----------

def _issue(owner="平台", sym="技能执行器不可用", sev="high", user="u1"):
    return {"owner": owner, "symptom_class": sym, "severity": sev, "user": user,
            "summary": "s", "conversation_id": "c1"}


def test_apply_history_new():
    enriched, hist = radar.apply_history([_issue()], [], "2026-07-17")
    assert enriched[0]["status"] == "新发现"
    assert enriched[0]["days"] == 1 and enriched[0]["total"] == 1
    assert hist[0]["daily"] == {"2026-07-17": 1}


def test_apply_history_recurrence():
    it = _issue()
    fp = radar.fingerprint(it)
    hist_in = [{"fp": fp, "first": "2026-07-16", "last": "2026-07-16",
                "daily": {"2026-07-16": 1}, "users": ["u0"]}]
    enriched, hist = radar.apply_history([it], hist_in, "2026-07-17")
    assert enriched[0]["status"] == "复发"
    assert enriched[0]["days"] == 2 and enriched[0]["total"] == 2
    assert enriched[0]["users"] == 2   # u0 + u1


def test_apply_history_same_day_idempotent():
    it = _issue()
    e1, h1 = radar.apply_history([it], [], "2026-07-17")
    e2, h2 = radar.apply_history([it], h1, "2026-07-17")   # 同日重跑
    assert e2[0]["total"] == 1 and e2[0]["days"] == 1      # 不翻倍
    assert h2[0]["daily"] == {"2026-07-17": 1}


def test_apply_history_intraday_merge():
    issues = [_issue(user="u1"), _issue(user="u2")]   # 同 fp、同日两条
    enriched, hist = radar.apply_history(issues, [], "2026-07-17")
    assert len(enriched) == 1                     # 合并成一条代表
    assert enriched[0]["total"] == 2 and enriched[0]["users"] == 2


def test_apply_history_old_schema_migration():
    it = _issue()
    fp = radar.fingerprint(it)
    hist_in = [{"fp": fp, "first": "2026-07-16", "last": "2026-07-16",
                "days_set": ["2026-07-16"], "users": ["u0"]}]   # 旧 schema
    enriched, hist = radar.apply_history([it], hist_in, "2026-07-17")
    assert enriched[0]["status"] == "复发" and enriched[0]["days"] == 2
    assert hist[0]["daily"]["2026-07-16"] == 1


def test_apply_history_skips_bad_schema():
    hist_in = [{"no_fp": 1}, "garbage"]   # 无 fp / 非 dict
    enriched, hist = radar.apply_history([_issue()], hist_in, "2026-07-17")
    assert len(enriched) == 1 and enriched[0]["status"] == "新发现"


def test_apply_history_representative_is_most_severe():
    issues = [_issue(sev="low"), _issue(sev="high")]
    enriched, _ = radar.apply_history(issues, [], "2026-07-17")
    assert enriched[0]["severity"] == "high"


# ---------- build_card ----------

def test_build_card_empty():
    card = radar.build_card("2026-07-17", 10, 0, [])
    assert "✅ 昨日无异常" in _card_text(card)


def test_build_card_uses_custom_title_and_xray_base():
    issues = [{"owner": "平台", "symptom_class": "招需卡提交失败", "severity": "high",
               "summary": "提交失败", "user": "u", "conversation_id": "c-137"}]
    card = radar.build_card(
        "2026-07-21", 1, 1, issues,
        title="小招会话问题雷达",
        xray_base="http://10.117.5.137/dev/context/",
    )
    assert card["card"]["header"]["title"]["content"] == "🔎 小招会话问题雷达 · 2026-07-21"
    assert "http://10.117.5.137/dev/context/c-137" in _card_text(card)


def test_build_card_owner_grouping():
    issues = [
        {"owner": "平台", "symptom_class": "x", "severity": "high", "summary": "s", "user": "u", "conversation_id": "c"},
        {"owner": "管理员", "symptom_class": "y", "severity": "mid", "summary": "s", "user": "u", "conversation_id": "c"},
    ]
    txt = _card_text(radar.build_card("2026-07-17", 10, 2, issues))
    assert "🔴 **平台**" in txt and "🟡 **管理员**" in txt


def test_build_card_unknown_owner_bucket():
    issues = [{"owner": "火星人", "symptom_class": "x", "severity": "low",
               "summary": "s", "user": "u", "conversation_id": "c"}]
    txt = _card_text(radar.build_card("2026-07-17", 1, 1, issues))
    assert "⚪ **其他**" in txt   # 未知 owner 落兜底桶,不静默丢


def test_build_card_summary_rendered():
    issues = [{"owner": "平台", "symptom_class": "x", "severity": "high",
               "summary": "数仓表授权失败", "user": "u", "conversation_id": "c"}]
    assert "数仓表授权失败" in _card_text(radar.build_card("2026-07-17", 1, 1, issues))


def test_build_card_injection_neutralized():
    # 用户来源文本(summary/evidence)里的 lark_md 结构必须中和;
    # 我自己加的 <font color='grey'> 标签合法,不在断言范围。
    issues = [{"owner": "平台", "symptom_class": "x", "severity": "high",
               "summary": "<at>坏|`人", "evidence": "<b>注入", "user": "u", "conversation_id": "c"}]
    txt = _card_text(radar.build_card("2026-07-17", 1, 1, issues))
    assert "<at>" not in txt and "＜at＞" in txt    # 用户尖括号全角化
    assert "<b>" not in txt and "＜b＞" in txt      # evidence 里的尖括号也中和
    assert "|" not in txt and "`" not in txt       # 竖线/反引号全角化


def test_build_card_note_footer():
    card = radar.build_card("2026-07-17", 42, 7, [])
    note = card["card"]["elements"][-1]
    assert note["tag"] == "note"
    assert "扫42段/候选7段" in note["elements"][0]["content"]


# ---------- post_webhook ----------

class _FakeResp:
    def __init__(self, status, body):
        self.status = status
        self._body = body.encode("utf-8")

    def read(self, n=-1):
        return self._body[:n] if n and n > 0 else self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


_FEISHU = "https://open.feishu.cn/open-apis/bot/v2/hook/xxx"


def test_post_webhook_rejects_non_feishu_host():
    assert radar.post_webhook("https://evil.com/hook", {}) is False


def test_post_webhook_rejects_http_scheme():
    assert radar.post_webhook("http://open.feishu.cn/hook", {}) is False


def test_post_webhook_code_0(monkeypatch):
    monkeypatch.setattr(radar.urllib.request, "urlopen",
                        lambda req, timeout=5: _FakeResp(200, '{"code":0}'))
    assert radar.post_webhook(_FEISHU, {"a": 1}) is True


def test_post_webhook_statuscode_0(monkeypatch):
    monkeypatch.setattr(radar.urllib.request, "urlopen",
                        lambda req, timeout=5: _FakeResp(200, '{"StatusCode":0}'))
    assert radar.post_webhook(_FEISHU, {}) is True


def test_post_webhook_code_nonzero(monkeypatch):
    monkeypatch.setattr(radar.urllib.request, "urlopen",
                        lambda req, timeout=5: _FakeResp(200, '{"code":19001}'))
    assert radar.post_webhook(_FEISHU, {}) is False


def test_post_webhook_non_200(monkeypatch):
    monkeypatch.setattr(radar.urllib.request, "urlopen",
                        lambda req, timeout=5: _FakeResp(500, ""))
    assert radar.post_webhook(_FEISHU, {}) is False


def test_post_webhook_exception(monkeypatch):
    def _boom(req, timeout=5):
        raise OSError("network down")
    monkeypatch.setattr(radar.urllib.request, "urlopen", _boom)
    assert radar.post_webhook(_FEISHU, {}) is False


# ---------- _load_history ----------

def test_load_history_skips_bad_lines(tmp_path):
    f = tmp_path / "h.jsonl"
    f.write_text('\n'.join([
        '{"fp":"a","daily":{"2026-07-16":1}}',
        'not json at all',
        '',
        '{"no_fp":true}',
    ]), encoding="utf-8")
    out = radar._load_history(str(f))
    assert len(out) == 1 and out[0]["fp"] == "a"


def test_load_history_missing_file(tmp_path):
    assert radar._load_history(str(tmp_path / "nope.jsonl")) == []


# ---------- enriched 暴露 fp/first/last ----------

def test_apply_history_exposes_fp_first_last():
    it = _issue()
    fp = radar.fingerprint(it)
    hist_in = [{"fp": fp, "first": "2026-07-14", "last": "2026-07-14",
                "daily": {"2026-07-14": 1}, "users": ["u0"]}]
    enriched, _ = radar.apply_history([it], hist_in, "2026-07-17")
    assert enriched[0]["fp"] == fp
    assert enriched[0]["first"] == "2026-07-14"   # 首次不被覆盖
    assert enriched[0]["last"] == "2026-07-17"    # 最近=今天


# ---------- build_bitable_rows ----------

def _enriched_one(**kw):
    base = {"owner": "平台", "symptom_class": "技能执行器不可用", "severity": "high",
            "summary": "s", "evidence": "e", "user": "u", "conversation_id": "c1",
            "fp": "abc123", "first": "2026-07-16", "last": "2026-07-16",
            "total": 3, "users": 2}
    base.update(kw)
    return base


def test_build_bitable_rows_field_mapping():
    rows = radar.build_bitable_rows([_enriched_one()])
    assert len(rows) == 1
    r = rows[0]
    assert r["source_id"] == "abc123"
    f = r["fields"]
    assert f["SourceID"] == "abc123"
    assert f["责任方"] == "平台"
    assert f["问题类型"] == "技能执行器不可用"
    assert f["优先级"] == "高"          # high→高
    assert f["复发次数"] == 3 and f["影响人数"] == 2
    assert f["话题链接"].endswith("/c1")
    assert f["提出时间"] == "2026-07-16 00:00:00"
    assert f["最近发现"] == "2026-07-16 00:00:00"


def test_build_bitable_rows_uses_custom_xray_base():
    rows = radar.build_bitable_rows(
        [_enriched_one(conversation_id="c-137", cids=["c-137"])],
        xray_base="http://10.117.5.137/dev/context/",
    )
    assert rows[0]["fields"]["话题链接"].endswith("/c-137")
    assert "10.117.5.137" in rows[0]["fields"]["话题链接"]


def test_build_bitable_rows_unknown_owner_to_qita():
    rows = radar.build_bitable_rows([_enriched_one(owner="火星人")])
    assert rows[0]["fields"]["责任方"] == "其他"   # 未知 owner 落兜底,和卡片一致


def test_build_bitable_rows_severity_label():
    assert radar.build_bitable_rows([_enriched_one(severity="mid")])[0]["fields"]["优先级"] == "中"
    assert radar.build_bitable_rows([_enriched_one(severity="low")])[0]["fields"]["优先级"] == "低"


def test_build_bitable_rows_omits_empty_dates():
    rows = radar.build_bitable_rows([_enriched_one(first=None, last=None)])
    f = rows[0]["fields"]
    assert "提出时间" not in f and "最近发现" not in f   # 空日期不写


def test_build_bitable_rows_multiple_links():
    # 一个问题多会话 → 一行,话题链接一格多条(去重保序),每条带扫描日期前缀
    it = _enriched_one(cids=["c1", "c2", "c2", "c3"], last="2026-07-16")   # c2 重复
    rows = radar.build_bitable_rows([it])
    links = rows[0]["fields"]["话题链接"].split("\n")
    assert len(links) == 3                      # c2 去重
    assert links[0] == "2026-07-16 " + radar._cid_url("c1")   # 带日期前缀
    assert links[2].endswith("/c3")


def test_build_bitable_rows_single_link_fallback():
    # 无 cids 时回退用 conversation_id
    rows = radar.build_bitable_rows([_enriched_one(conversation_id="solo")])
    assert rows[0]["fields"]["话题链接"].endswith("/solo")


def test_build_bitable_rows_never_writes_human_fields():
    # 只写我的字段,绝不含人工列
    f = radar.build_bitable_rows([_enriched_one()])[0]["fields"]
    for human in ("解决状态", "负责人", "开发DDL", "Git PR", "git issue", "问题备注(人工)", "开发状态"):
        assert human not in f
