# 三类系统性缺陷模式

> 项目中反复出现的三类系统性缺陷：静默失败、状态不一致、资源未清理

## 缺陷一：静默失败

**现象**：操作返回 success，但实际未执行；或错误被吞掉，上层认为成功。

**例子**：push 失败但前端显示成功（PR #734）；编译失败但验收显示 0/0 通过（PR #763）。

**防御**：关键操作必须有显式返回值检查；错误必须向上传播；操作结果必须有可见通知。

## 缺陷二：状态不一致

**现象**：多个数据源（DB、Redis、内存）中同一数据不一致，读到的值取决于读哪个源。

**例子**：milestone 状态在 DB 和 SSE 事件中不一致；向量 DB 和关系 DB 的软删除不同步。

**防御**：状态变更必须原子性（DB 事务 或 Redis MULTI/EXEC）；有多个数据源时，必须有一个 source of truth。

## 缺陷三：资源未清理

**现象**：临时资源（worktree、进程、DB 连接、Redis key）在操作结束后未清理，积累导致资源耗尽。

**例子**：webpack watch 孤儿进程；worktree 堆积在 159 编译机；Redis interrupt key 未设 TTL。

**防御**：使用 try-finally 或 context manager；所有临时 Redis key 必须设 TTL；定期清理任务作为兜底。

## Related
- [debugging-methodology](debugging-methodology.md)
- [error-handling-shared-layer](error-handling-shared-layer.md)
