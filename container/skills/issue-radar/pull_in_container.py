"""在 nine-backend 容器内只读拉取当天 feishu 会话逐字稿 → stdout JSON。

用法: docker exec -w /app -e PYTHONPATH=/app nine-backend python /tmp/pull_in_container.py [YYYY-MM-DD]
sqlalchemy / app.core.database 只在 main() 内惰性 import——让本模块在本机(无 app 依赖)
可被 import,以单测下方纯函数(_window/_content_of/_prune/_rows_to_msgs)。
"""
import sys
import json
import datetime
from zoneinfo import ZoneInfo

CST = ZoneInfo("Asia/Shanghai")
_TEXT_CAP = 2000            # 单条正文上限(防超长)
_TOOL_OK_CAP = 200          # 成功 tool 结果只留头部(下游 compact 还会整条丢,这里先砍防膨胀)
_MAX_SESSIONS = 500         # stdout 会话数上限(防异常大窗口撑爆回传;超限记日志非静默)


def _window(arg):
    if arg:
        d = datetime.date.fromisoformat(arg)
    else:
        d = (datetime.datetime.now(CST) - datetime.timedelta(days=1)).date()
    start = datetime.datetime.combine(d, datetime.time.min)   # CST naive(agent_messages 存CST墙钟)
    end = start + datetime.timedelta(days=1)
    return d.isoformat(), start, end


def _content_of(raw_content, event_type, event_payload):
    """少数 event-sourcing 行正文在 event_payload 而非 content。content 有 text/result 直接用;
    否则从 event_payload 兜底抽 text(镜像 X-Ray _query_messages 口径)。"""
    c = json.loads(raw_content) if isinstance(raw_content, str) else raw_content
    if isinstance(c, list):          # Claude SDK 块列表→原样保留,交 radar._msg_text 抽取
        return c
    if isinstance(c, dict) and (c.get("text") or c.get("result") or c.get("content") or c.get("delta")):
        return c
    if event_payload:
        ep = json.loads(event_payload) if isinstance(event_payload, str) else event_payload
        if isinstance(ep, dict):
            t = ep.get("text") or ep.get("content") or ep.get("message")
            if isinstance(t, str) and t.strip():
                return {"text": t, "_evt": event_type}
            if isinstance(t, list) and t:
                return {"content": t, "_evt": event_type}
    return c if isinstance(c, dict) else {"text": ""}


def _prune(role, content):
    """在 pull 侧先砍大块,避免 pulled.json 被成功数据表撑爆。
    成功 tool 结果→只留头 _TOOL_OK_CAP 字;其它 text/result 一律截 _TEXT_CAP。"""
    if not isinstance(content, dict):
        return content
    c = dict(content)
    if role == "tool" and not c.get("is_error") and isinstance(c.get("result"), str) and len(c["result"]) > _TOOL_OK_CAP:
        c["result"] = c["result"][:_TOOL_OK_CAP] + "…[成功结果已截]"
    for k in ("text", "result"):
        if isinstance(c.get(k), str) and len(c[k]) > _TEXT_CAP:
            c[k] = c[k][:_TEXT_CAP] + "…[截]"
    return c


def _rows_to_msgs(rows, phase=None):
    out = []
    for r in rows:  # r = (role, content, event_type, event_payload)
        msg = {"role": r[0], "content": _prune(r[0], _content_of(r[1], r[2], r[3]))}
        if phase:
            msg["phase"] = phase
        out.append(msg)
    return out


def main():
    from sqlalchemy import text, bindparam          # 惰性 import(让纯函数本机可测)
    from app.core.database import SessionLocal
    day, start, end = _window(sys.argv[1] if len(sys.argv) > 1 else None)
    db = SessionLocal()
    try:
        db.execute(text("SET SESSION max_execution_time=5000"))
        # 候选会话=当天有 feishu 新消息的会话(会话级圈定)
        convs = db.execute(text("""
            SELECT conversation_id, MIN(created_at), MAX(user_id)
            FROM agent_messages
            WHERE channel='feishu' AND created_at >= :s AND created_at < :e
            GROUP BY conversation_id ORDER BY MIN(created_at)
        """), {"s": start, "e": end}).fetchall()
        if len(convs) > _MAX_SESSIONS:   # 非静默上限:超限记日志(不假装全扫了)
            print(f"[issue-radar] WARN: {len(convs)} 会话超上限 {_MAX_SESSIONS}，只取最早 {_MAX_SESSIONS} 段", file=sys.stderr)
            convs = convs[:_MAX_SESSIONS]
        # 姓名解析:agent_messages.user_id = users.id(内部 UUID)→ 直查 username(花名)。
        uids = list({c[2] for c in convs if c[2]})
        name = {}
        if uids:
            for uid, un in db.execute(text("SELECT id,username FROM users WHERE id IN :i")
                                      .bindparams(bindparam("i", expanding=True)), {"i": uids}):
                if un:
                    name[uid] = un
        MSG_COLS = "role, content, event_type, event_payload"
        sessions = []
        for cid, t0, uid in convs:
            try:  # 单会话解析失败→跳过记日志,不中断整轮
                # 单会话查询同样限 channel='feishu',防混渠道(web/api)消息污染分类/归属
                today_rows = db.execute(text(f"""SELECT {MSG_COLS} FROM agent_messages
                    WHERE conversation_id=:c AND channel='feishu' AND created_at >= :s AND created_at < :e
                    ORDER BY seq"""), {"c": cid, "s": start, "e": end}).fetchall()
                # 当天窗口之前最后 3 条作"前情"上下文(仅供 Claude 判根因,不计入归属信号)
                tail_rows = db.execute(text(f"""SELECT {MSG_COLS} FROM agent_messages
                    WHERE conversation_id=:c AND channel='feishu' AND created_at < :s
                    ORDER BY seq DESC LIMIT 3"""), {"c": cid, "s": start}).fetchall()
                tail = _rows_to_msgs(list(reversed(tail_rows)), phase="context")
                msgs = tail + _rows_to_msgs(today_rows)
                sessions.append({"conversation_id": cid,
                                 "user": name.get(uid, f"…{str(uid)[-6:]}" if uid else "?"),
                                 "occurred_at": t0.strftime("%H:%M") if t0 else "", "messages": msgs})
            except Exception as exc:
                print(f"[issue-radar] skip conversation {cid}: {exc!r}", file=sys.stderr)
                continue
        print(json.dumps({"window_day": day, "scanned": len(sessions), "sessions": sessions}, ensure_ascii=False))
    finally:
        db.close()


if __name__ == "__main__":
    main()
