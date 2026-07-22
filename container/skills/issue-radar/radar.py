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
    # 只锚 symptom_class(问题类型,受控命名)。
    # 不含 owner:同一问题的"责任方"判断会跨天/跨人漂移(如"数仓表未授权"平台↔管理员两态,
    #   "工具参数校验失败"平台↔模型),owner 进指纹会把同一问题裂成多行 → 复发计数失真。owner 降为展示列。
    # 不含每日现写的自由文本 summary(否则跨天措辞漂移→复发失效)。
    key = issue.get("symptom_class") or issue.get("category", "")
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
        seen_c, cids = set(), []          # 当天这组全部会话 id(去重保序),供台账累积多条链接
        for it in grp:
            c = it.get("conversation_id")
            if c and c not in seen_c:
                seen_c.add(c)
                cids.append(c)
        enriched.append({**rep, "status": "复发" if seen_before else "新发现",
                         "fp": fp, "first": h.get("first"), "last": h.get("last"),
                         "days": len(h["daily"]), "total": sum(h["daily"].values()),
                         "users": len(h["users"]), "cids": cids})
    return enriched, list(by_fp.values())


_OWNER_ORDER = [("平台", "🔴"), ("管理员", "🟡"), ("模型", "🟠"), ("结果质量", "🔵"), ("其他", "⚪")]
_SEV = {"high": "高", "mid": "中", "low": "低"}
_XRAY_BASE = "https://nine.95fenapp.com/dev/context/"
_DEFAULT_TITLE = "产研会话问题雷达"


def _safe_md(s) -> str:
    # 中和用户来源文本里的 lark_md 结构:标签(<at>@所有人)、markdown 链接、表格竖线/代码反引号。
    return ((s or "").replace("<", "＜").replace(">", "＞")
            .replace("[", "［").replace("]", "］")
            .replace("|", "｜").replace("`", "｀"))


def _line(it, xray_base=_XRAY_BASE) -> str:
    sev = _SEV.get(it.get("severity"), "?")
    sym = _safe_md(it.get("symptom_class") or it.get("category") or "问题")
    who = _safe_md(it.get("user") or "?")
    if it.get("status") == "复发":
        status = f"复发 {it.get('days')}天/{it.get('total')}次/{it.get('users')}人"
    else:
        status = "新发现"
    summ = _safe_md(it.get("summary") or "")
    cid = "".join(ch for ch in str(it.get("conversation_id", "")) if ch.isalnum() or ch in "-_")
    link = xray_base + cid
    # 分层块(重点突出,不平铺):
    #   ①「▎**问题名** · 严重度」——问题名单独一行加粗顶出来当小标题,最醒目
    #   ②「👤 用户 · 新发现/复发」——谁遇到 + 状态
    #   ③ 一句自然语言:大概什么问题
    #   ④「原文：…」——一段自然语言原文/关键报错,让人直接看穿(截 EVIDENCE_MAX)
    #   ⑤「🔗 查看会话」——跳转
    lines = [f"▎**{sym}** · {sev}",
             f"👤 {who} · {status}",
             f"**初步诊断**：{summ}"]        # 加标签,和原文区分开(这是我的判断)
    ev = _safe_md(" ".join((it.get("evidence") or "").split())[:EVIDENCE_MAX])
    if ev:
        # 原文包淡灰,弱化为佐证;外层 <font> 是我加的(合法),ev 已过 _safe_md 中和其内部尖括号
        lines.append(f"<font color='grey'>原文：{ev}</font>")
    lines.append(f"🔗 [查看会话]({link})")
    return "\n".join(lines)


def build_card(window_day, scanned, candidates, issues, *, title=_DEFAULT_TITLE, xray_base=_XRAY_BASE) -> dict:
    elements = []
    if not issues:
        elements.append({"tag": "div", "text": {"tag": "lark_md", "content": "✅ 昨日无异常"}})
    else:
        _known = {o for o, _ in _OWNER_ORDER if o != "其他"}
        first = True
        for owner, emoji in _OWNER_ORDER:
            if owner == "其他":   # 兜底桶:未知 owner 归此,绝不静默丢弃
                group = [it for it in issues if it.get("owner") not in _known]
            else:
                group = [it for it in issues if it.get("owner") == owner]
            if not group:
                continue
            group.sort(key=lambda x: {"high": 0, "mid": 1, "low": 2}.get(x.get("severity"), 3))
            if not first:                       # owner 块之间加分隔线,视觉分组更清晰
                elements.append({"tag": "hr"})
            first = False
            body = "\n\n".join(_line(it, xray_base) for it in group)   # issue 之间空行分隔,不糊成一坨
            content = f"{emoji} **{owner}** · {len(group)} 条\n\n{body}"
            elements.append({"tag": "div", "text": {"tag": "lark_md", "content": content}})
    elements.append({"tag": "hr"})   # 正文与口径脚注之间分隔
    elements.append({"tag": "note", "elements": [{"tag": "plain_text",
        "content": f"口径:{window_day} 全部 feishu 会话·按消息日期切片·扫{scanned}段/候选{candidates}段·无新增静默"}]})
    return {"msg_type": "interactive", "card": {
        "config": {"wide_screen_mode": True},
        "header": {"title": {"tag": "plain_text", "content": f"🔎 {title} · {window_day}"},
                   "template": "blue"},
        "elements": elements}}


_KNOWN_OWNERS = {o for o, _ in _OWNER_ORDER if o != "其他"}
_LINK_CAP = 20   # 单行"话题链接"最多累积条数(超出丢最老,防一格无限长)


def _date_to_dt(d):
    # "2026-07-16" → "2026-07-16 00:00:00"(飞书 datetime CellValue 稳妥写法);空→None
    return f"{d} 00:00:00" if d else None


def _cid_url(cid, xray_base=_XRAY_BASE):
    c = "".join(ch for ch in str(cid) if ch.isalnum() or ch in "-_")
    return xray_base + c


def build_bitable_rows(issues, *, xray_base=_XRAY_BASE):
    """把 enriched issues 映射成多维表格 upsert 行:{source_id(=fp), fields{}, links[]}。
    纯函数,不写表——实际 upsert 由 bitable_sync 按 source_id 搜 record_id 再 create/patch。
    只填我这几个字段,绝不碰人工列(解决状态/负责人/DDL/PR/备注)。
    links = 当天这组全部会话链接(去重保序);同一问题一行,链接一格累积多条,
    实际"并进已有那格"由 bitable_sync 完成(它读旧格→union→截 _LINK_CAP)。"""
    rows = []
    for it in issues:
        fp = it.get("fp") or fingerprint(it)
        cids = it.get("cids") or ([it["conversation_id"]] if it.get("conversation_id") else [])
        day = it.get("last") or ""        # 当天扫描日,给每条链接前缀日期(看得出哪天遇到的)
        links, _seen = [], set()          # 防御性去重(apply_history 已去重,直连调用也稳)
        for c in cids:
            u = _cid_url(c, xray_base)
            if u not in _seen:
                _seen.add(u)
                links.append(f"{day} {u}" if day else u)
        owner = it.get("owner")
        fields = {
            "SourceID": fp,
            "责任方": owner if owner in _KNOWN_OWNERS else "其他",   # 与卡片兜底桶一致
            "问题类型": it.get("symptom_class") or it.get("category") or "未分类",
            "优先级": _SEV.get(it.get("severity"), "低"),
            "智能诊断(Agent)": it.get("summary") or "",
            "原声": it.get("evidence") or "",
            "话题链接": "\n".join(links[:_LINK_CAP]),   # create 用当天链接;update 时 sync 会并旧格
            "复发次数": it.get("total", 1),
            "影响人数": it.get("users", 1),
        }
        first = _date_to_dt(it.get("first"))
        last = _date_to_dt(it.get("last"))
        if first:
            fields["提出时间"] = first
        if last:
            fields["最近发现"] = last
        rows.append({"source_id": fp, "fields": fields, "links": links})
    return rows


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
    p2.add_argument("--title", default=_DEFAULT_TITLE)
    p2.add_argument("--xray-base", default=_XRAY_BASE)
    p2.add_argument("--send", action="store_true")
    p2.add_argument("--bitable-out", help="把 upsert 行写到该 JSON 文件(供 bitable_sync 消费);dry-run 也会写")
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
        if a.bitable_out:   # 吐多维表格 upsert 行(与是否 --send 无关,方便先干看)
            json.dump(build_bitable_rows(enriched, xray_base=a.xray_base), open(a.bitable_out, "w", encoding="utf-8"),
                      ensure_ascii=False, indent=2)
            print(f"多维表格行已写 {a.bitable_out}({len(enriched)} 行)", file=sys.stderr)
        card = build_card(a.window_day, a.scanned, a.candidates, enriched,
                          title=a.title, xray_base=a.xray_base)
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
