# AI 排查 5 步法

> 以 trace_id 为主线，串联 Jaeger + Loki + GlitchTip 定位线上问题
> 写入: 2026-04-23 · 来源: nine 项目 docs/kb/observability-debug.md + 用户提供的排查流程

## 完整参考文档

**必读**：`/workspace/extra/vibe-coding/nine/docs/kb/observability-debug.md`
包含所有可直接执行的 curl 命令、FAQ、代码位置表。本页是操作速查，遇到细节去读原文。

## 流程总览

```
用户问题描述
    ↓
Step 1: 拿 trace_id（用户给 / 时间窗口推断 / GlitchTip 异常 event）
    ↓
Step 2: Jaeger 取完整 span 树 → 哪个 span 报错 → 哪个服务（go-api/backend）
    ↓
Step 3: Loki 按 trace_id 拉两端日志 → 看上下文
    ↓
Step 4: 如果是异常 → GlitchTip 取 stack trace + breadcrumbs
    ↓
Step 5: 给用户报告（trace_id / 根因 / 建议修复 / 相关 PR）
```

## 执行方式

所有命令通过 SSH 在目标机器上执行。token/凭据已持久化在 `/etc/profile.d/glitchtip.sh`，用 `bash -lc` 自动加载：

```bash
ssh root@10.117.5.134 'bash -lc "命令"'
```

## 关键陷阱（必记）

1. **proxy 劫持** — 两台机器 ssh 后 env 都有 `http_proxy`，curl 不支持 CIDR 的 `no_proxy`，直接 curl 内网地址会走代理返回 503。**测试机加 `--noproxy "*"`，生产机用 `gtcurl`**
2. **`bash -lc` 必须** — 不加 `-l` 走 non-login shell，`$GLITCHTIP_TOKEN` 等 env 不会被加载
3. **slug ≠ name** — GlitchTip API 用 slug，不是服务名

## 环境差异速查

| 项 | 测试机 | 生产机 |
|---|---|---|
| SSH host | `10.117.5.134` | `10.117.0.159` |
| `GLITCHTIP_ORG` | `dewu` | `-wn` |
| Python 后端 project slug | `agent` | `enterprise-ai-agent-backend` |
| HTTP 命令 | `curl --noproxy "*"` | `gtcurl` |

## 常用命令速查

### Step 1: 拿最近 issue + trace_id

```bash
# 列 Python 后端最近 5 条 issue
ssh root@10.117.5.134 'bash -lc "
  curl -sS --noproxy \"*\" -H \"Authorization: Bearer \$GLITCHTIP_TOKEN\" \
    \"\$GLITCHTIP_URL/api/0/projects/\$GLITCHTIP_ORG/agent/issues/?limit=5\" \
    | python3 -c \"import sys,json; d=json.load(sys.stdin); [print(i[\\\"shortId\\\"], i[\\\"level\\\"], \\\"|\\\", i[\\\"title\\\"][:80], \\\"@\\\", i.get(\\\"lastSeen\\\")) for i in d]\"
"'

# 拿单个 issue 的 trace_id
ISSUE_ID=3
ssh root@10.117.5.134 "bash -lc 'curl -sS --noproxy \"*\" -H \"Authorization: Bearer \$GLITCHTIP_TOKEN\" \"\$GLITCHTIP_URL/api/0/issues/$ISSUE_ID/events/latest/\"' " \
  | python3 -c '
import sys, json
d = json.load(sys.stdin)
ctx = d.get("contexts", {}).get("trace", {})
print("trace_id:", ctx.get("trace_id"))
print("title:", d.get("title"))
'
```

### Step 2: Jaeger 查链路

```bash
TRACE_ID=122e66bbe5f941ef98bbf5242c25fc70
ssh root@10.117.5.134 "bash -lc 'curl -sS --noproxy \"*\" \"\$JAEGER_URL/api/traces/$TRACE_ID\"'" \
  | python3 -c '
import sys, json
d = json.load(sys.stdin)
t = d["data"][0]
for s in sorted(t["spans"], key=lambda s: s["startTime"]):
    pid = t["processes"][s["processID"]]["serviceName"]
    err = next((tg["value"] for tg in s.get("tags", []) if tg["key"] == "error"), "")
    print(f"  {pid:30s} {s["operationName"][:50]:50s} {s["duration"]/1000:7.1f}ms {err}")
'
```

### Step 3: Loki 拉日志

```bash
TRACE_ID=122e66bbe5f941ef98bbf5242c25fc70
ssh root@10.117.5.134 "bash -lc '
  START=\$((\$(date +%s) - 3600))
  END=\$(date +%s)
  curl -sS --noproxy \"*\" -G -u \"\$GRAFANA_USER:\$GRAFANA_PASSWORD\" \
    \"\$GRAFANA_URL/api/datasources/proxy/uid/loki/loki/api/v1/query_range\" \
    --data-urlencode \"query={service=~\\\".+\\\"} | json | trace_id=\\\"$TRACE_ID\\\"\" \
    --data-urlencode \"start=\${START}000000000\" \
    --data-urlencode \"end=\${END}000000000\" \
    --data-urlencode \"limit=200\"
'"
```

### Step 5 没有 trace_id 时：按时间窗口找 ERROR

```bash
ssh root@10.117.5.134 "bash -lc '
  START=\$((\$(date +%s) - 1800))
  END=\$(date +%s)
  curl -sS --noproxy \"*\" -G -u \"\$GRAFANA_USER:\$GRAFANA_PASSWORD\" \
    \"\$GRAFANA_URL/api/datasources/proxy/uid/loki/loki/api/v1/query_range\" \
    --data-urlencode \"query={service=~\\\".+\\\"} | json | level=\\\"error\\\"\" \
    --data-urlencode \"start=\${START}000000000\" \
    --data-urlencode \"end=\${END}000000000\" \
    --data-urlencode \"limit=50\"
'"
```

## 工具地址

**测试环境（10.117.5.134）**
- GlitchTip: http://10.117.5.134:8000 — admin@dewu.com / fronterben!@#
- Jaeger: http://10.117.5.134:16686 — 无需登录
- Grafana: http://10.117.5.134:3001 — admin / nineadmin1234

**生产环境（10.117.0.159）**
- GlitchTip: http://10.117.0.159:8000 — admin@dewu.com / erben~front
- Jaeger: http://10.117.0.159:16686 — 无需登录
- Grafana: http://10.117.0.159:3011 — admin / 5cd7476f7e3b1a33c71d16f5

需要阿里 VPC 网络可达。

## 排查报告模板

```
**排查报告 — <一句话症状>**

**trace_id**: <32 hex>
**首次发生**: <ts>
**影响服务**: <go-api / backend / both>

**现象**
• <Span 1 出错: ...>
• <Span 2 后续 retry 失败: ...>

**根因**
<一两句>

**关键日志（3-5 行）**
[backend/error] 2026-04-21T... knowledge.search 调 Qdrant 超时
[go-api/info]   2026-04-21T... GET /api/v2/chats 502

**建议修复**
1. <短期 mitigation>
2. <长期 fix，挂哪个 PR / issue>
```

## 执行策略

- 优先用 SSH + curl API 查询，快速拿结构化数据，不污染 context
- 需要看 span 可视化时用 `agent-browser open <jaeger-url>/trace/<trace_id>`
- 需同时查 Jaeger + GlitchTip + Loki 时，派 3 个 Task 子 agent 并行查，只带结论回来

## Related

- 完整 KB: `/workspace/extra/vibe-coding/nine/docs/kb/observability-debug.md`
- [ops-checklist](../nine/ops-checklist.md) — 运维前置检查
- [known-issues](../nine/known-issues.md) — 已知 bug 模式
- [debugging-methodology](../learnings/general/debugging-methodology.md) — 调试六原则
