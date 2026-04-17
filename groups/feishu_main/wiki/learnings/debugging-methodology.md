# 系统性调试方法论

> Nine 项目核心调试原则：先追踪证据、验证假设、定位根因再动手修复

## 六条核心原则

### 1. 停止猜测，追踪证据
调试时禁止修改代码"试试看"或"可能是 X"不验证就改。正确做法：找到最近的真实事件（日志、DB 记录、Redis 数据），从事件向上追溯调用链，确认根因后只改根因。

### 2. 验证 bug 是真实的
收到 bug 报告后先复现：找到对应的 session_id，在 Redis/DB 中确认异常数据实际存在，不要基于症状描述直接修复。

### 3. 质疑问题前提
修复前先问："这真的是 bug 吗？还是需求理解有误？"如果前提错误，修复方向也会错。

### 4. 定位根因而非症状
不要修 symptom，要修 root cause。如果修复后问题换个地方出现，说明只修了症状。根因通常在数据层或边界条件（空列表、None、falsy zero）。

### 5. 声称完成前先验证
声称"已修复"前必须在实际环境运行，看到对应的正常日志/事件，不能只说"代码逻辑上是对的"。

### 6. 先解释再写代码
修改代码前先用文字说清楚根因，让用户/review 确认方向对，再动手实现。

## 调试工具链

```bash
# 查最近事件
redis-cli ZRANGE events:{SESSION_ID} -20 -1

# 查 SSE 事件流
redis-cli XRANGE stream:{SESSION_ID} - + COUNT 20

# 查容器日志
docker logs nine-backend --tail 100

# 查 sandbox 日志
ssh heasenbug@10.117.0.159 "journalctl -u sandbox-api --tail 50"
```

## 教训

- 系统性调试是强制要求，不是可选项
- 调试复杂 bug 时，写下已排除的假设，避免绕回
- 不要在没有证据的情况下声称找到了根因

## Related
- [vm-verify](vm-verify.md)
- [log-grep-tools](log-grep-tools.md)
