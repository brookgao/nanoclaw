# 并发竞态条件

> Nine 系统中的并发竞态：并发 resume、rootfs 并发覆写、文件系统非原子操作

## 问题

**并发 resume 竞态**：两个并发 resume 请求同时到达同一 session，LangGraph 线程安全问题导致 state 不可预期。

**rootfs symlink 并发覆写**：多个 VM 同时启动时，共享的 rootfs symlink 被并发覆写，导致某些 VM 使用了错误的 rootfs。

## 根因

- LangGraph graph 实例不是线程安全的，同一 session 的并发请求会导致 state 竞争
- os.symlink 不是原子操作，并发时可能失败或覆盖

## 修复

- resume 竞态：session 级别加分布式锁（Redis SETNX），同一 session 同时只处理一个 resume
- rootfs symlink：使用 os.rename（原子操作）替代 os.symlink；或为每个 VM 分配独立的 rootfs 路径
- LangGraph graph 实例改为 per-session 创建，不共享

## 教训

- 并发路径必须有锁或幂等保护，不能假设"并发不会发生"
- 文件系统操作（symlink、mv）在并发时不是原子的，必须用 OS 原子操作（os.rename）
- 测试中必须包含并发场景，单线程测试通过不代表并发安全
- 分布式锁必须有超时（TTL），防止锁泄漏

## Related
- [langgraph-interrupt](langgraph-interrupt.md)
- [vm-verify](vm-verify.md)
