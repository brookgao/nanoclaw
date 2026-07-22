# 会话问题雷达 · 交接文档（NanoClaw 技能）

> 自包含交接：读完这一份就能在 NanoClaw 上把工具立起来。代码全在文中，与 nineship 无关。
> 生成日期 2026-07-17 · 作者 Claude(dota 全流程) · 状态：代码已完成并对 159 真数据验证，**未上线**（webhook 未配 / 定时未部署）。

---

## 1. 这是什么 / 为什么

每天扫 159 上**所有 feishu bot 会话**，由 NanoClaw 的 Claude 亲自读逐字稿，发现用户遇到但**没上报**的问题，按"该谁处理"归类（平台/管理员/模型/结果质量/其他），跨天去重盯趋势，播报到飞书群。

痛点：95 分 PM 天天用 Nine 查数据/查代码，撞到"数仓表未授权""猜错技能名""技能执行器挂了"这类问题大多不上报；靠那句"重新授权"式抱怨也说不清根因。价值：每早一张卡，主动告诉你当天真实在发生什么（一天真扫出 5 段候选、跨 4 人的真问题）。

**关键设计**：检测那步（读会话判问题）不是固定分类器，是 NanoClaw 的 Claude 本人读——所以"从没预设过的新问题"也能捞出来。规则只做粗筛（宁可宽），真伪与归类交 LLM。

## 2. 运行形态与家

- **完全跑在 NanoClaw 本机**：一个本机常驻定时任务，唤起 NanoClaw 跑 `issue-radar` 技能，走完"拉→压→筛→读判→出卡→发"。
- **家**：`~/.claude/skills/issue-radar/`（本文件所在目录）。放这里 NanoClaw 原生加载，本地改即生效。**不放任何共享仓**。
- **数据来源**：SSH 到 159（`root@ssh-metal.heasenbug.com` 免密钥）→ `docker exec -w /app -e PYTHONPATH=/app nine-backend python /tmp/pull_in_container.py` 用 nine 后端自己的 DB 连接**只读**查询（免猜库密码）。对 159 库零写。

## 3. 架构 / 数据流

```
定时(每天09:00,扫昨天)
  → ① 拉数据: scp pull_in_container.py 到159 → docker exec 跑 → stdout JSON(pulled.json)
  → ② 粗筛:  python3 radar.py prefilter pulled.json candidates.json  (compact压缩+硬特征标候选)
  → ③ 读判:  你(Claude)读 candidates.json 每个候选的 compact,按 SKILL.md 判据产出 issues.json
  → ④ 出报:  python3 radar.py report issues.json history.jsonl --window-day X --scanned N --candidates M [--send]
              (apply_history 去重+复发标记 → build_card 按owner分块 → post_webhook)
  → 历史 history.jsonl(本地JSONL,去重+趋势;发送成功才写)
```

确定性 Python（②④）+ 中间 LLM 读判（③）。③ 是 NanoClaw Claude 亲自做，非代码。

## 4. Nine 数据模型（拉数据依赖，已 spike+源码核过）

- **逐字消息权威源 = `agent_messages` 表**（X-Ray 即读它重建）：`conversation_id`(String50) + `seq` + `role`(user/assistant/tool) + `content`(JSON) + `channel`(feishu/web/api) + `created_at`(**存 CST 墙钟**，容器/DB=CST) + `event_type`/`event_payload`(event-sourcing 行正文在 payload)。
- `content` 形态：user=`{text,images}`；assistant=`{text,tool_calls[].name,stop_reason}`；tool=`{result,is_error}`。**tool 真名在 assistant 的 `tool_calls[].name`，`tool_name` 列常空**。
- 会话主键 = `v2_conversations.id`(CHAR36)。**该表无 channel 列** → 渠道过滤只能在消息级 `agent_messages.channel='feishu'`。
- 会话跨多天 → **单会话切片必带日期过滤**，否则昨天的报错被算成今天。
- 姓名：`agent_messages.user_id` = `users.id`(内部 UUID) → 直查 `users.username`（飞书**花名**，非真名；保留花名不走 EHR）。

## 5. 完整代码

### 5.1 `radar.py`（纯函数 + CLI，本机可单测）

```python
"""会话问题雷达：每天扫 159 feishu 会话发现未上报问题，按处理人分类，播报飞书群。

纯函数 + CLI(prefilter/report)；不 import nine app 模块，本机可单测。
中间"读判"步由 NanoClaw Claude 执行(见 SKILL.md)，非本文件职责。
"""
from __future__ import annotations
import os
import sys
import json
import hashlib
import argparse
import datetime
import urllib.request
from zoneinfo import ZoneInfo

CST = ZoneInfo("Asia/Shanghai")
EVIDENCE_MAX = 200          # 证据引用字符上限(隐私)
_RETENTION_DAYS = 60        # 历史保留期(last 早于此丢弃,防无限增长)

# 硬报错特征(粗筛用,宁可宽;真伪交 Claude 精判) —— spike 实证词表
SIGNAL_HARD = (
    "错误：", "ERROR:", "error:", "执行失败", "cannot be resolved", "Table not found",
    "未授权", "无权限", "权限不足", "SKILL_EXECUTOR", "死循环", "未知技能",
    "工具不存在", "不支持的 action", "文件不存在", "不存在。可用目录",
    "执行超时", "timeout", "timed out", "TimeoutError", "报错", "异常",
    "Traceback", "无法直接", "没有代码库", "没有数据查询",
)
SIGNAL_USER = (
    "为什么", "不对", "不行", "还是不", "没有用", "没反应", "卡住", "错了",
    "无法", "重新授权", "？？", "服了", "算了", "快一点", "你的日期不对",
)


def _webhook_url() -> str | None:
    return (os.getenv("ISSUE_RADAR_WEBHOOK_URL") or "").strip() or None


def _blocks_text(v):
    # Claude SDK content 可能是 [{"type":"text","text":...}] 块列表
    if isinstance(v, str):
        return v
    if isinstance(v, list):
        return " ".join(b.get("text", "") for b in v if isinstance(b, dict) and b.get("text"))
    return ""


def _msg_text(content):
    d = content
    if isinstance(content, str):
        try:
            d = json.loads(content)
        except Exception:
            return content, False, []
    if isinstance(d, list):                       # 顶层就是块列表
        return _blocks_text(d), False, []
    if not isinstance(d, dict):
        return "", False, []
    # text/result 优先;都空则从 content/delta 块兜底还原(对齐 X-Ray 富形态)
    text = d.get("text") or d.get("result") or _blocks_text(d.get("content")) or _blocks_text(d.get("delta")) or ""
    is_err = bool(d.get("is_error"))
    tcs = [c.get("name") for c in (d.get("tool_calls") or []) if isinstance(c, dict) and c.get("name")]
    return text, is_err, tcs


def compact(messages) -> str:
    lines = []
    for msg in messages:
        text, is_err, tcs = _msg_text(msg.get("content"))
        role = msg.get("role")
        flat = " ".join(text.split())
        pre = "[前情] " if msg.get("phase") == "context" else ""   # 跨天前情标注
        if role == "user":
            lines.append(pre + "U: " + flat[:300])
        elif role == "assistant":
            tag = f" [调用:{','.join(tcs)}]" if tcs else ""
            if flat.strip():
                lines.append(pre + "A: " + flat[:160] + tag)
            elif tcs:
                lines.append(pre + "A:" + tag)
        elif role == "tool":
            if is_err or any(k in text for k in SIGNAL_HARD):
                lines.append(pre + "T⚠: " + flat[:200])
            # 成功 tool / 数据表格 → 丢弃(压缩关键)
    return "\n".join(lines)


def prefilter(sessions):
    out = []
    for s in sessions:
        reasons = []
        n_err = 0
        for msg in s.get("messages", []):
            if msg.get("phase") == "context":   # 前情不计入归属信号(消息级边界)
                continue
            text, is_err, _ = _msg_text(msg.get("content"))
            role = msg.get("role")
            if role == "tool" and (is_err or any(k in text for k in SIGNAL_HARD)):
                n_err += 1
            elif role == "assistant" and any(k in text for k in SIGNAL_HARD):
                n_err += 1
            elif role == "user" and any(k in text for k in SIGNAL_USER):
                reasons.append("用户不满")
        if n_err:
            reasons.append(f"报错行×{n_err}")
        if reasons:
            out.append({**s, "compact": compact(s["messages"]), "reasons": sorted(set(reasons))})
    return out


def fingerprint(issue) -> str:
    # 只锚 owner + symptom_class(受控命名),不含每日现写的自由文本 summary(否则跨天漂移→复发失效)
    key = issue.get("owner", "") + "|" + (issue.get("symptom_class") or issue.get("category", ""))
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:12]


def apply_history(issues, history, today):
    # 用 daily={date:count} 存每日计数:同日重跑覆盖当日(不累加)→ --send 幂等。
    # 深拷贝 daily/users 隔离入参;缺 fp 的坏 schema 项跳过。
    by_fp = {}
    for h in history:
        if not isinstance(h, dict) or "fp" not in h:
            continue
        daily = dict(h.get("daily", {}))
        if not daily and isinstance(h.get("days_set"), list):   # 旧 schema 迁移:days_set→daily
            daily = {d: 1 for d in h["days_set"]}
        by_fp[h["fp"]] = {**h, "daily": daily, "users": list(h.get("users", []))}
    groups, order = {}, []
    for it in issues:
        fp = fingerprint(it)
        if fp not in groups:
            groups[fp] = []
            order.append(fp)
        groups[fp].append(it)
    _rank = {"high": 0, "mid": 1, "low": 2}
    enriched = []
    for fp in order:
        grp = groups[fp]
        rep = min(grp, key=lambda x: _rank.get(x.get("severity"), 3))   # 取最严重条作代表
        h = by_fp.get(fp)
        seen_before = h is not None and any(d != today for d in h.get("daily", {}))
        if h is None:
            h = {"fp": fp, "first": today, "last": today, "daily": {}, "users": []}
        h["daily"][today] = len(grp)   # 幂等:覆盖当日计数,同日重跑不翻倍
        h["last"] = today
        for it in grp:
            if it.get("user") and it["user"] not in h["users"]:
                h["users"].append(it["user"])
        by_fp[fp] = h
        enriched.append({**rep, "status": "复发" if seen_before else "新发现",
                         "days": len(h["daily"]), "total": sum(h["daily"].values()),
                         "users": len(h["users"])})
    return enriched, list(by_fp.values())


_OWNER_ORDER = [("平台", "🔴"), ("管理员", "🟡"), ("模型", "🟠"), ("结果质量", "🔵"), ("其他", "⚪")]
_SEV = {"high": "高", "mid": "中", "low": "低"}
_XRAY_BASE = "https://nine.95fenapp.com/dev/context/"


def _safe_md(s) -> str:
    # 中和用户来源文本里的 lark_md 结构:标签(<at>@所有人)、markdown 链接、表格竖线/代码反引号。
    return ((s or "").replace("<", "＜").replace(">", "＞")
            .replace("[", "［").replace("]", "］")
            .replace("|", "｜").replace("`", "｀"))


def _clip(s, n=EVIDENCE_MAX) -> str:
    return _safe_md(" ".join((s or "").split())[:n])


def _line(it) -> str:
    sev = _SEV.get(it.get("severity"), "?")
    sym = _safe_md(it.get("symptom_class") or it.get("category") or "问题")
    who = _safe_md(it.get("user") or "?")
    if it.get("status") == "复发":
        trend = f"·复发·{it.get('days')}天/{it.get('total')}次/{it.get('users')}人"
    else:
        trend = "·新发现"
    summ = _safe_md(it.get("summary") or "")
    ev = _clip(it.get("evidence"))
    cid = "".join(ch for ch in str(it.get("conversation_id", "")) if ch.isalnum() or ch in "-_")
    link = _XRAY_BASE + cid
    return f"[{sev}] {sym} — {who}{trend}\n　{summ}｜{ev} [🔗]({link})"


def build_card(window_day, scanned, candidates, issues) -> dict:
    elements = []
    if not issues:
        elements.append({"tag": "div", "text": {"tag": "lark_md", "content": "✅ 昨日无异常"}})
    else:
        _known = {o for o, _ in _OWNER_ORDER if o != "其他"}
        for owner, emoji in _OWNER_ORDER:
            if owner == "其他":   # 兜底桶:未知 owner 归此,绝不静默丢弃
                group = [it for it in issues if it.get("owner") not in _known]
            else:
                group = [it for it in issues if it.get("owner") == owner]
            if not group:
                continue
            group.sort(key=lambda x: {"high": 0, "mid": 1, "low": 2}.get(x.get("severity"), 3))
            content = f"{emoji} **{owner}**\n" + "\n".join(_line(it) for it in group)
            elements.append({"tag": "div", "text": {"tag": "lark_md", "content": content}})
    elements.append({"tag": "note", "elements": [{"tag": "plain_text",
        "content": f"口径:{window_day} 全部 feishu 会话·按消息日期切片·扫{scanned}段/候选{candidates}段·无新增静默"}]})
    return {"msg_type": "interactive", "card": {
        "config": {"wide_screen_mode": True},
        "header": {"title": {"tag": "plain_text", "content": f"🔎 会话问题雷达 · {window_day}"},
                   "template": "blue"},
        "elements": elements}}


_ALLOWED_WEBHOOK_HOSTS = ("open.feishu.cn", "open.larksuite.com")
_RESP_CAP = 10240   # 响应体读取上限


def post_webhook(url, card) -> bool:
    # URL 须 https + 飞书域名(防 SSRF);飞书失败也返 HTTP200,须校验 body code==0(新版 code/老版 StatusCode)
    from urllib.parse import urlparse
    p = urlparse(url or "")
    if p.scheme != "https" or p.hostname not in _ALLOWED_WEBHOOK_HOSTS:
        print(f"拒发:webhook 非法(须 https + 飞书域名):{p.scheme}://{p.hostname}", file=sys.stderr)
        return False
    try:
        req = urllib.request.Request(url, data=json.dumps(card).encode("utf-8"),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            if resp.status != 200:
                return False
            body = json.loads(resp.read(_RESP_CAP).decode("utf-8") or "{}")
            return body.get("code", body.get("StatusCode", -1)) == 0
    except Exception:
        return False


def _load_history(path):
    out = []
    try:
        for line in open(path, encoding="utf-8"):
            line = line.strip()
            if not line:
                continue
            try:
                h = json.loads(line)
            except Exception:
                continue   # 坏行单独跳过
            if isinstance(h, dict) and "fp" in h:
                out.append(h)
    except Exception:
        return []   # 文件级异常→降级全新发现
    return out


def cli(argv):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p1 = sub.add_parser("prefilter")
    p1.add_argument("pulled")
    p1.add_argument("out")
    p2 = sub.add_parser("report")
    p2.add_argument("issues")
    p2.add_argument("history")
    p2.add_argument("--window-day", required=True)
    p2.add_argument("--scanned", type=int, required=True)
    p2.add_argument("--candidates", type=int, required=True)
    p2.add_argument("--send", action="store_true")
    a = ap.parse_args(argv)
    if a.cmd == "prefilter":
        data = json.load(open(a.pulled, encoding="utf-8"))
        cands = prefilter(data["sessions"])
        json.dump({"window_day": data["window_day"], "scanned": data["scanned"],
                   "candidates": cands}, open(a.out, "w", encoding="utf-8"), ensure_ascii=False)
        print(f"候选 {len(cands)}/{data['scanned']} 段")
        return
    if a.cmd == "report":
        issues = json.load(open(a.issues, encoding="utf-8"))
        enriched, new_hist = apply_history(issues, _load_history(a.history), a.window_day)
        card = build_card(a.window_day, a.scanned, a.candidates, enriched)
        if not a.send:
            print("[DRY-RUN] 不发送。卡片预览：")
            print(json.dumps(card, ensure_ascii=False, indent=2))
            return
        url = _webhook_url()
        if not url:
            print("ISSUE_RADAR_WEBHOOK_URL 未配置，跳过发送", file=sys.stderr)
            return
        try:   # 发送前预建历史目录,确保能落盘;否则"群已发、史没写"→下次重复播报
            os.makedirs(os.path.dirname(os.path.abspath(a.history)), exist_ok=True)
        except Exception as exc:
            print(f"历史目录不可写，取消发送(防重复播报): {exc}", file=sys.stderr)
            return
        if post_webhook(url, card):
            cutoff = (datetime.date.fromisoformat(a.window_day) - datetime.timedelta(days=_RETENTION_DAYS)).isoformat()
            kept = [h for h in new_hist if h.get("last", "") >= cutoff]   # 保留期,防无限增长
            try:
                tmp = a.history + ".tmp"
                with open(tmp, "w", encoding="utf-8") as f:   # 发送成功才写,临时文件+原子替换
                    for h in kept:
                        f.write(json.dumps(h, ensure_ascii=False) + "\n")
                os.replace(tmp, a.history)
                print("已发送并更新历史")
            except Exception as exc:
                print(f"⚠️ 已发群但历史写入失败({exc!r})——下次可能重复播报,请人工核对/补写 {a.history}", file=sys.stderr)
        else:
            print("发送失败,历史未更新(可重试)", file=sys.stderr)


if __name__ == "__main__":
    cli(sys.argv[1:])
```

### 5.2 `pull_in_container.py`（容器内只读拉取，惰性 import 使纯函数本机可测）

```python
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
```

### 5.3 `SKILL.md`（技能定义 + 编排 + 分类判据）

> 部署到 `~/.claude/skills/issue-radar/` 后，步骤 1 里 `scp` 的源路径改成本技能目录下的 `pull_in_container.py`（即 `~/.claude/skills/issue-radar/pull_in_container.py`）。

```markdown
---
name: issue-radar
description: 每天扫 159 全部 feishu bot 会话，主动发现用户未上报的问题，按处理人分类，播报飞书群。用户说"扫问题/问题雷达/看看今天用户遇到什么问题"时触发。
---

# 会话问题雷达

每天扫 159 上所有 feishu bot 会话，用你（NanoClaw 的 Claude）亲自读逐字稿，发现用户遇到但没上报的问题，按"该谁处理"归类，跨天去重盯趋势，播报飞书群。对 159 库**只读**。

## 运行步骤（每步等上一步产物）

1. **拉数据**：`scp ~/.claude/skills/issue-radar/pull_in_container.py root@ssh-metal.heasenbug.com:/tmp/` → `docker cp /tmp/pull_in_container.py nine-backend:/tmp/` → `docker exec -w /app -e PYTHONPATH=/app nine-backend python /tmp/pull_in_container.py` → 存 stdout 为 `pulled.json`。默认扫昨天；`python /tmp/pull_in_container.py 2026-07-17` 扫指定日。
2. **粗筛**：`python3 radar.py prefilter pulled.json candidates.json`（宿主用 `python3`；仅容器内 `docker exec … nine-backend python` 用 `python`）。
3. **读判（你亲自做）**：读 `candidates.json` 每个候选的 `compact`，按下方判据产出 `issues.json`（扁平 list）。**一个候选可产出 0..N 条 Issue**（一段会话常同时有多个不同问题、不同 owner，逐个拆独立 Issue，不合并）；判无真问题产 0 条。前情（`[前情]` 行）只帮你判根因，**不因前情旧报错单独产 Issue**（归属是当天）。
4. **出报/去重**：先干跑 `python3 radar.py report issues.json history.jsonl --window-day <日> --scanned <N> --candidates <M>` 看卡片；确认无误加 `--send` 真发。（同日重复 `--send` 已幂等：当日计数覆盖不翻倍。）
5. 清理 159 `/tmp` 临时文件。

## Issue 结构（第 3 步产出）

每条：`{owner, category, symptom_class, severity(high/mid/low), summary, evidence(短引用), user, conversation_id, root_cause_hint}`

## owner 分类判据（该谁处理）

- **平台**：产品/工具本身故障——`SKILL_EXECUTOR_UNAVAILABLE`、工具超时、工具不存在、`不支持的 action`。→ 平台团队修。
- **管理员**：授权/配置缺失——skill 未授权、`未授权`确系用户真缺权限。→ 给用户开权限。
- **模型**：模型自己犯错——猜错技能名/表名/字段/路径、无脑重试触发死循环。→ 优化 prompt/skill。
- **结果质量**：结果算错/答非所问，用户当场纠正。→ 看数据口径/skill 逻辑。
- **其他**：能力边界摩擦等。

## ⚠️ 分类关键坑

`数仓表未授权(jiuwu_sc)` 有两态，别无脑归"管理员"：
- 平台 bug 误拒（`_check_live_grant` 曾 KeyError 吞成"无权限"，PR#4180/#4202 才修）→ owner=**平台**
- 用户真缺该 ODPS 表权限 → owner=**管理员**

判据：同一用户同表**反复被拒且报错形态是内部异常**偏平台 bug；权限卡片正常展示申请链接偏真缺权限。拿不准标 severity 低 + root_cause_hint 写"需人工确认平台bug/真缺权限"。

## symptom_class 命名（受控词表——保证跨天去重不失效）

⚠️ 指纹靠 owner+symptom_class 跨天去重。若你每天给同一问题起不同名，复发就算不出。**规则：优先从下表选已知名；只有确属全新类型才自造名，自造后务必沿用同一名字**。

- 已知名（尽量复用）：重新授权、数仓表未授权、技能执行器不可用、工具执行超时、工具不存在/action不支持、猜错技能名、猜错表名/字段、代码检索路径错、SQL执行失败、无某能力权限、结果算错
- 新类型：起一个简短稳定的名（名词短语，别带当天具体值），root_cause_hint 写"新类型待归因"

## 已知症状→根因映射

- 重新授权/授权过期 → OAuth scope 缺失 / token 被烧 / CCVM 无持久登录 / token scope 冻结
- 数仓表未授权 → 两态（见上"分类关键坑"）：平台 bug 误拒 vs 用户真缺权限
```

### 5.4 `config.example.json`

```json
{
  "_comment": "真 webhook 走环境变量 ISSUE_RADAR_WEBHOOK_URL，勿在此填真值",
  "webhook_url_env": "ISSUE_RADAR_WEBHOOK_URL",
  "ssh_host": "root@ssh-metal.heasenbug.com",
  "container": "nine-backend"
}
```

### 5.5 测试

`tests/test_radar.py`（27）+ `tests/test_pull.py`（4）共 **31 测全绿**，覆盖：常量/webhook 开关、compact 压缩(成功丢/报错留/前情标注)、prefilter(硬特征+前情不计信号)、fingerprint(去 summary 稳定)、apply_history(新发现/复发/日内合并/幂等/旧schema迁移)、build_card(按owner分块/未知owner兜底/空静默/summary渲染/注入中和)、post_webhook(code==0/StatusCode/非200/异常/非飞书域拒发)、_load_history(损坏跳行)、pull(_window CST边界/_content_of兜底与块列表/_prune裁剪/phase标注)。测试文件与本文件同目录，可 `cd ~/.claude/skills/issue-radar && python3 -m pytest tests/ -q`。

## 6. 部署 / 配置 / 运行

**1. 落文件**：在 `~/.claude/skills/issue-radar/` 下建这几个文件（内容见 §5）：`radar.py`、`pull_in_container.py`、`SKILL.md`、`config.example.json`、`tests/test_radar.py`、`tests/test_pull.py`。落完 `cd ~/.claude/skills/issue-radar && python3 -m pytest tests/ -q` 应 31 绿。

**2. 配 webhook（敏感，不进任何 git）**：目标飞书群自定义机器人 webhook 写进环境变量——**URL 必须是 `open.feishu.cn`/`open.larksuite.com` 域**（`post_webhook` 的 SSRF 白名单，别的域会被拒发）：
```bash
export ISSUE_RADAR_WEBHOOK_URL='https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx'
```

**3. 首次跑（务必先 dry-run）**：按 SKILL.md 五步走一遍，第 4 步**先不加 `--send`** 看卡片预览，确认口径 OK 再加 `--send` 真发。

**4. 定时（关键未定项）**：注意——第 3 步"读判"是 **NanoClaw 的 Claude 亲自做的**，不是纯 shell。所以定时任务不能只 cron 一个脚本，而要**定时唤起 NanoClaw 跑 `issue-radar` 技能**（技能内部：脚本拉/筛 → Claude 读判 → 脚本出卡/发）。可选：NanoClaw 自己的定时能力（`schedule`/CronCreate 类）或一个本机 cron 唤起 NanoClaw 会话执行该技能。**这一步上线时实测哪种最稳**（要保住 SSH 免密钥 + webhook env + 本地 skill 加载）。纯脚本部分（拉/筛/出卡）可单独 cron，但读判那步离不开 NanoClaw。

## 7. 待办 / 盲区（上线前必读）

**待办（上线动作，球在你）**：
1. 提供目标群 webhook（`open.feishu.cn` 域）+ 配 env。
2. 首次真发前先看 dry-run 卡片确认口径。
3. 定第一次 `--send` + 敲定定时形态（见 §6.4）。

**盲区（诚实暴露，别被"31 测绿"骗）**：
1. **没真发过群**：只验了卡片 JSON 结构 + dry-run，**飞书里真实渲染没肉眼确认**；`--send`+`code==0`+写历史+复发趋势只有单测覆盖，没真链路。
2. **分类准确率是一天的主观判断**，非统计验证；粗筛"宁可宽"会有误报（靠 LLM 读判剔，但依赖读判质量）。
3. **event-sourcing 抽取兜底**（`_content_of` 从 event_payload）今天真数据没出现该类行，**这条路径没被真数据触达**。
4. **定时/cron 无人值守形态没验**：dry-run 是交互式走的；无人值守下 NanoClaw 能否自动做"读判"+保住凭据，未测。
5. **SSRF 白名单**只放行 `open.feishu.cn/open.larksuite.com`；若真实群 webhook 是别的域会被拒，需按实调 `_ALLOWED_WEBHOOK_HOSTS`。

## 8. 审查记录（已 vetted）

走完 dota 全流程（Claude critic 2 轮 + Codex 3 轮，累计修 **10 个 MAJOR**）。这些是代码里为什么长这样的原因，改代码前先看，别把加固改回去：

- **指纹只锚 owner+symptom_class、不含 summary**：否则每天措辞漂移→复发算不出（头号卖点失效）。
- **`daily={date:count}` 幂等**：同日重跑 `--send` 覆盖当日计数不翻倍。
- **一会话 0..N 条 Issue**：一段会话常有多个不同 owner 的问题，别合并成一条（会丢）。
- **`_safe_md` 全角化 `<>[]|`` ` ``**：用户来源文本（evidence/summary/user）进 lark_md 前必须中和，防 `<at id=all>` @爆群 + markdown 链接注入。
- **`post_webhook` 校验 body `code==0`**：飞书失败也返 HTTP 200，只看状态码会把失败当成功→写历史→永久静默。
- **发送成功才写历史 + 原子写 + 失败大声报警**："先发后记"无法 exactly-once，写史失败必须 stderr 报警（否则下次静默重复播报）。
- **只读铁律**：对 159 仅 SELECT + `SET SESSION max_execution_time=5000`，零写。
- **单会话切片必带 `channel='feishu'` + 日期过滤**：防混渠道污染 + 跨天旧报错被算成今天。
- **pull 单会话 try/except 隔离**：一条坏行不中断整天。
- **puller 惰性 import**：sqlalchemy/app 只在 main() 内 import，让纯函数本机可单测（避开 pydantic 依赖无底洞）。

---

*来源：dota 全流程（会话问题雷达）2026-07-17 · 设计 spec/plan 与审查记录曾在 nineship `feat/issue-radar` 分支（已按用户要求清理，不留在共享仓）。本文件是唯一自包含交接。*
