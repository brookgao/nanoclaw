# 日志查找与 grep_code 工具规范

> grep_code 超时处理、session log 查找方法、ERE flag 使用规范

## grep_code 超时

在大型 monorepo 中 grep_code 默认超时 10s，复杂 pattern 触发超时，agent 误以为"无结果"而实际有结果。

处理：超时不等于"无结果"，需要缩小搜索范围或用更精确的 pattern 重试。

## grep ERE flag

```bash
# 错误：BRE 模式，+ 和 {} 是字面量
grep "pattern+" file

# 正确：ERE 模式
grep -E "pattern+" file
grep -E "error\{[0-9]+\}" file
```

## Session Log 查找路径

```bash
# 1. Redis 事件流（最新事件）
redis-cli ZRANGE events:{SESSION_ID} -20 -1

# 2. Redis SSE stream
redis-cli XRANGE stream:{SESSION_ID} - + COUNT 30

# 3. Docker 容器日志
docker logs nine-backend --tail 100 --since 30m

# 4. Sandbox API 日志（159 编译机）
ssh heasenbug@10.117.0.159 "journalctl -u sandbox-api --tail 50"
```

## 教训

- grep_code 超时时，先缩小范围重试，不要直接结论"不存在"
- 正则中的 +/{}/()/] 必须用 -E（ERE），否则是字面量
- session 问题的排查优先级：Redis 事件流 → docker logs → DB → journalctl

## Related
- [debugging-methodology](debugging-methodology.md)
