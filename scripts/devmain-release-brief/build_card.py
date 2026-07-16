#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dev→main 发布决策简报 · 飞书卡片构建器（样式已随用户定稿 2026-07-16，勿随意改字号/结构）
================================================================================
用途：把「归纳层产出的结构化简报数据」渲染成飞书 interactive 卡片并发送。
上游：collect.py 出客观 JSON → 归纳 agent 按 SPEC.md 填下面的结构化 data → 本文件渲染+发送。

字号 / 结构铁律（都是用户逐条盯出来的，改前先看这段）：
  - 卡片 1.0（config+header+elements，**不用 schema 2.0**：2.0 触发"请升级客户端"残卡）
  - text_size 连字符写法：仓名 heading-3 / 正文 normal。`#`/`##` markdown 标题不渲染，别用。
  - 每个仓库一块，块内顺序：
      仓名（heading-3, 前面不加 emoji）
      基本信息（一个元素内，加粗标签）：分支 / 上次发布 / 结论
      4 个同级小节（1 异常告警 / 2 发布风险 / 3 大改动 / 4 待合入 PR），序号紧贴标题用「N. 」
  - **标题与它的内容必须在同一个 markdown 元素里**（`**N. 标题**\n正文`）——否则元素间距会让标题"飘"离内容，看不清哪段跟哪节。
  - 小节安全态：标题后挂 ` ✅`（如 `2. 发布风险 ✅`），正文写该节自己的「无」（发布风险→无风险项 / 大改动→无大改动 / 待合入→无 open PR），**不要**逐条在子项前打勾，也**不要**把空节合并成一行。
  - 小节有告警：标题不挂 ✅，正文只列要告警的（⚠️/🔴），清白的检查项不用列。
  - 段落 emoji：4 个小节**标题前不放** emoji；正文里状态 emoji（✅/⚠️/🔴）正常用。
  - 空节写「无XXX」保留整块，别删剩标题。各节的「无」按各节该说的写，别复制粘贴同一句。

数据契约（agent 按 SPEC 填）：
  {
    "generated_at": "2026-07-16 03:49",
    "heads": "nine 25e14a24e / 小招 b8faa1fb8 / recruit-api 53032837",
    "lines": [
      {
        "repo": "nine（主平台）",
        "branch": "dev → main",
        "last_release_label": "上次合 main",          # 或「上次发布」
        "last_release": "07-15 07:56（#4170）",
        "conclusion": "dev 有 2 个提交待发……",
        "sections": [                                   # 固定 4 个：异常告警/发布风险/大改动/待合入 PR
          {"n": 1, "title": "异常告警", "safe": false, "body": "· ⚠️ **[②] 未回流 hotfix**：……"},
          {"n": 2, "title": "发布风险", "safe": true,  "body": "无 DB 迁移 / 配置变动 / ……"},
          {"n": 3, "title": "大改动",   "safe": false, "body": "· pm-lite……"},
          {"n": 4, "title": "待合入 PR","safe": true,  "body": "无 open PR，可发"}
        ]
      }
    ],
    "summary": "recruit-api 触 ⑥……；nine 触 ②……；小招 健康。",
  }
"""
import json, subprocess, os, sys

NAME_SIZE = "heading-3"
BODY_SIZE = "normal"
HEXAGRAM = "SRE 六维：①变更 ②分支 ③数据 ④配置 ⑤回滚 ⑥审计"


def _t(content, size=BODY_SIZE):
    return {"tag": "markdown", "content": content, "text_size": size}


def build_card(data, title):
    hr = {"tag": "hr"}
    els = [_t(f"基于 head @ {data['heads']}（采集 {data['generated_at']}）\n**{HEXAGRAM}**")]
    for ln in data["lines"]:
        els.append(hr)
        els.append(_t(f"【仓库】{ln['repo']}", NAME_SIZE))
        label = ln.get("last_release_label", "上次发布")
        els.append(_t(
            f"**分支：**{ln['branch']}\n"
            f"**{label}：**{ln['last_release']}\n"
            f"**结论：**{ln['conclusion']}"))
        for sec in ln["sections"]:
            check = " ✅" if sec.get("safe") else ""
            els.append(_t(f"**{sec['n']}. {sec['title']}**{check}\n{sec['body']}"))
    els.append(hr)
    els.append(_t(f"**🩺 三线总检**\n{data['summary']}"))
    return {
        "config": {"wide_screen_mode": True},
        "header": {"template": "blue", "title": {"tag": "plain_text", "content": title}},
        "elements": els,
    }


def get_ws_token(env_path=None):
    """从 nanoclaw/.env 的 FEISHU_APP_ID/SECRET 换 WS bot tenant_access_token。"""
    env_path = env_path or os.path.join(os.path.dirname(__file__), "..", "..", ".env")
    aid = asec = ""
    for line in open(env_path, encoding="utf-8"):
        if line.startswith("FEISHU_APP_ID="):
            aid = line.split("=", 1)[1].strip().strip('"\'')
        elif line.startswith("FEISHU_APP_SECRET="):
            asec = line.split("=", 1)[1].strip().strip('"\'')
    env = dict(os.environ, NO_PROXY="open.feishu.cn,.feishu.cn", no_proxy="open.feishu.cn,.feishu.cn")
    out = subprocess.run(
        ["curl", "-s", "--max-time", "15", "-X", "POST",
         "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
         "-H", "Content-Type: application/json",
         "-d", json.dumps({"app_id": aid, "app_secret": asec})],
        capture_output=True, text=True, env=env).stdout
    return json.loads(out).get("tenant_access_token", "")


def send_card(card, chat_jid, token):
    env = dict(os.environ, NO_PROXY="open.feishu.cn,.feishu.cn", no_proxy="open.feishu.cn,.feishu.cn")
    body = {"receive_id": chat_jid, "msg_type": "interactive",
            "content": json.dumps(card, ensure_ascii=False)}
    cmd = ["curl", "-s", "--max-time", "25", "-X", "POST",
           "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
           "-H", f"Authorization: Bearer {token}", "-H", "Content-Type: application/json",
           "-d", json.dumps(body, ensure_ascii=False)]
    out = subprocess.run(cmd, capture_output=True, text=True, env=env).stdout
    return json.loads(out)


if __name__ == "__main__":
    # 用法: build_card.py <data.json> <title> <chat_jid> [token]
    data = json.load(open(sys.argv[1], encoding="utf-8"))
    card = build_card(data, sys.argv[2])
    token = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] != "AUTO" else get_ws_token()
    print(json.dumps(send_card(card, sys.argv[3], token), ensure_ascii=False)[:300])
