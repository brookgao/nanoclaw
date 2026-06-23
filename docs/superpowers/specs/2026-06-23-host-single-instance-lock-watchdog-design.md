# Host 单实例锁 + 存活看门狗

- 日期:2026-06-23
- 状态:已批准设计,待实现
- 关联:2026-06-23 PRD评审群"消息收到却不处理"事故诊断

## 背景与问题

2026-06-23 现场:某飞书群消息被收到(日志有 `RAW im.message.receive_v1`)却 6+ 分钟无任何处理,全系统冻住。诊断发现日志里**同时存在 3 个 host 进程**(pid 2101 / 60669 / 49224)在写同一份日志、连同一个飞书 WS、读写同一个 `store/messages.db`。

**根因**:多个 host 实例并存,共享同一份消息游标(`startMessageLoop` 在 `src/index.ts:622-625` 收到消息后立即 `lastTimestamp = newTimestamp; saveState()`)。一个实例把共享游标推过了某条消息,真正该处理它的另一个实例随后死掉 → 这条消息"被标记已读却没人处理";幸存实例此后轮询 `getNewMessages` 始终返回空,再不打 `New messages`,表现为"卡死"。这是已知故障类("双实例抢消息")。

**次生问题**:当唯一实例进入"活着但不推进"的状态(本次因游标越界,也可能因真正的事件循环 hang),没有任何机制自动恢复——只能人工 `kill -9`。现有飞书 WS 看门狗只检查"WS 有没有事件",WS 一直在收,所以不报警。

## 目标

1. 保证同一时间只有一个 host 编排进程在跑(根除多实例抢消息/抢游标)。
2. 当唯一实例的主循环卡住时自动重启(无需人工 kill)。

## 非目标(YAGNI)

- 不做跨机器/分布式锁(单机单实例足够)。
- 不做"抢占杀旧"语义(采用"拒绝启动")。
- 不限制群数量或并发会话——**单实例锁与多群无关**:一个 host 进程本就并行服务所有群,锁只挡"第二份 host 副本"。

## 设计

### 组件 1:单实例 flock 锁

在 `main()` **最早处、`initDatabase()` 之前**对 `store/nanoclaw.lock` 抢一把**独占非阻塞** `flock`(`LOCK_EX | LOCK_NB`)——这样重复实例在碰数据库/WS 之前就退出。

- **拿到锁** → 本进程是唯一实例,继续启动,锁持有到进程结束。
- **拿不到锁**(`EWOULDBLOCK`/`EAGAIN`)→ 记一条清晰日志(`[lock] another host instance is already running; exiting`)→ `process.exit(1)`。
- flock 是**advisory + 进程死亡自动释放**:无残留锁、无需写/清理 PID 文件。`kickstart -k` 强杀旧实例 → 锁自动释放 → 新实例立刻拿到。
- 文件描述符须在进程生命周期内保持打开(持有 fd = 持有锁);不要关闭。

**接口边界**:
- `acquireSingleInstanceLock(lockPath: string): { ok: true; fd: number } | { ok: false }` —— 纯粹封装"尝试拿锁"的结果,便于单测判定逻辑;调用方据 `ok` 决定继续或退出。

### 组件 2:主循环存活看门狗

- `startMessageLoop` 的 `while (true)` 每轮迭代开头更新模块级 `lastLoopTickAt = Date.now()`。
- 启动一个独立 `setInterval`(周期 30s)执行检查:`if (Date.now() - lastLoopTickAt > STALL_THRESHOLD_MS)` → 记日志(`[watchdog] message loop stalled for Nms; restarting`)→ `process.exit(1)`(launchd `KeepAlive` 拉起新实例)。
- `STALL_THRESHOLD_MS` 默认 **180000(3 分钟)**,可经环境变量覆盖。

**接口边界**:
- `checkLoopStall(now: number, lastTickAt: number, thresholdMs: number, onStall: () => void): void` —— 纯函数 + 注入退出回调,单测时传假时钟与假回调,不真的 `exit`。

**判据说明**:看门狗判的是"循环有没有在转",不是"有没有消息"。正常空闲(循环在转、`getNewMessages` 返回空)`lastLoopTickAt` 持续刷新 → 不误杀。只有循环真卡住(事件循环阻塞 / 循环异常退出)才触发。

> 注:本看门狗用进程内 `setInterval`,能覆盖"主循环停转/异常"类卡死;对"整个事件循环被同步阻塞"的极端情形,`setInterval` 自身也无法触发——但组件 1 的单实例锁已消除本次事故(游标竞争)的根因,该极端情形不在本次范围,留待后续如复现再做外部看门狗。

## 错误处理

- 锁文件目录缺失 → 创建(现有 `store/` 已存在)。
- 拿锁系统调用抛非预期错误(非"已被占用")→ 记录并退出 `1`(保守:宁可重启也不带不确定状态跑)。
- 看门狗触发 `exit(1)`,退出码配 launchd `KeepAlive=true` 自动重启;flock 随进程退出释放。

## 测试策略

- 组件 1:单测 `acquireSingleInstanceLock` —— 同一锁路径第一次 `ok:true`,持锁未释放时第二次 `ok:false`;释放(关 fd)后可再次获得。
- 组件 2:单测 `checkLoopStall` —— `now - lastTickAt` 超阈值调用 `onStall`,未超不调用;边界值。
- 不为 `process.exit` / launchd 行为写测试(外部副作用,封装在调用层)。

## 验收标准

1. 启动第二个 host 进程时,它打印明确日志并立即退出 `1`,第一个不受影响。
2. 杀掉持锁实例后,新实例能正常拿锁启动。
3. 主循环人为卡住超过阈值时,看门狗触发进程退出(被 launchd 重启)。
4. 多群并发会话行为不变(锁不影响群路由)。
5. 两个工程 `tsc` 干净,新增单测通过,全量测试不回归。
