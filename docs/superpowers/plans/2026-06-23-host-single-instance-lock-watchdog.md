# Host 单实例锁 + 存活看门狗 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 保证同一时间只有一个 host 编排进程在跑,并在唯一实例主循环卡死时自动重启。

**Architecture:** 两个正交、各自可单测的小模块,接进 `src/index.ts` 的 `main()` / 主循环。① 单实例锁:进程启动最早处绑定一个本地回环端口作为原子锁(Node 无原生 flock,端口绑定是等价的"原子获取 + 进程死亡自动释放"原语,零依赖),绑不上即退出。② 看门狗:主循环每轮打卡时间戳,独立定时器检测卡顿超阈值则 `exit(1)` 让 launchd 重启。

**Tech Stack:** TypeScript, Node `net`, vitest。

## Global Constraints

- TDD:每个代码改动先写失败测试,看失败,再最小实现。
- **机制偏离 spec 的说明**:spec 写的是 `flock`;Node 无内置 flock,改用 `net` 绑定 `127.0.0.1:<端口>` 实现同等语义(原子、进程死亡自动释放、无残留锁文件)。一并把 spec 该处更新。
- 锁端口默认 `47291`,可经环境变量 `NANOCLAW_LOCK_PORT` 覆盖。
- 看门狗卡顿阈值默认 `180000` ms,可经 `NANOCLAW_LOOP_STALL_MS` 覆盖;检测定时器周期 30000 ms。
- 退出码 `1` 配 launchd `KeepAlive=true` 自动重启。
- 不影响多群:锁只挡第二份 host 副本,不限制群路由/并发。
- 根工程 `tsc` 干净,新增单测通过,全量不回归。
- 关联 spec:`docs/superpowers/specs/2026-06-23-host-single-instance-lock-watchdog-design.md`。

---

### Task 1: 单实例锁模块 + 接进 main()

**Files:**
- Create: `src/single-instance.ts`
- Test: `src/single-instance.test.ts`
- Modify: `src/index.ts`(`main()` 最早处)

**Interfaces:**
- Produces: `acquireSingleInstanceLock(port: number): Promise<{ ok: true; server: import('net').Server } | { ok: false }>` —— 绑定成功返回 `ok:true`+server(须保持打开以持锁);端口被占(`EADDRINUSE`)返回 `ok:false`。

- [ ] **Step 1: 写失败测试**

`src/single-instance.test.ts`:

```typescript
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'net';
import { acquireSingleInstanceLock } from './single-instance.js';

const PORT = 47999; // test-only port
const open: Server[] = [];
afterEach(() => {
  for (const s of open) s.close();
  open.length = 0;
});

describe('acquireSingleInstanceLock', () => {
  it('acquires when port is free', async () => {
    const r = await acquireSingleInstanceLock(PORT);
    expect(r.ok).toBe(true);
    if (r.ok) open.push(r.server);
  });

  it('fails to acquire when port is already held', async () => {
    const first = await acquireSingleInstanceLock(PORT);
    expect(first.ok).toBe(true);
    if (first.ok) open.push(first.server);
    const second = await acquireSingleInstanceLock(PORT);
    expect(second.ok).toBe(false);
  });

  it('can re-acquire after the holder releases', async () => {
    const first = await acquireSingleInstanceLock(PORT);
    expect(first.ok).toBe(true);
    if (first.ok) await new Promise<void>((res) => first.server.close(() => res()));
    const again = await acquireSingleInstanceLock(PORT);
    expect(again.ok).toBe(true);
    if (again.ok) open.push(again.server);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/single-instance.test.ts`
Expected: FAIL —— 模块/函数不存在。

- [ ] **Step 3: 写最小实现**

`src/single-instance.ts`:

```typescript
import net from 'net';

/**
 * Single-instance lock via a loopback port bind. The OS guarantees only one
 * process can hold a given 127.0.0.1:<port>; the bind is released
 * automatically when the process dies (no stale lock file / PID cleanup).
 * Keep the returned server open for the process lifetime to hold the lock.
 */
export function acquireSingleInstanceLock(
  port: number,
): Promise<{ ok: true; server: net.Server } | { ok: false }> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') resolve({ ok: false });
      else resolve({ ok: false });
    });
    server.listen(port, '127.0.0.1', () => {
      resolve({ ok: true, server });
    });
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/single-instance.test.ts`
Expected: PASS(3 个)。

- [ ] **Step 5: 接进 main()**

`src/index.ts` 顶部 import 区加:

```typescript
import { acquireSingleInstanceLock } from './single-instance.js';
```

`main()` 函数体**最前面**(`ensureSystemRunning()` 之前)插入:

```typescript
  const lockPort = Number(process.env.NANOCLAW_LOCK_PORT ?? 47291);
  const lock = await acquireSingleInstanceLock(lockPort);
  if (!lock.ok) {
    logger.error(
      { lockPort },
      '[lock] another nanoclaw host instance is already running; exiting',
    );
    process.exit(1);
  }
```

- [ ] **Step 6: 构建确认编译干净**

Run: `npm run build`
Expected: tsc 无报错。

- [ ] **Step 7: Commit**

```bash
git add src/single-instance.ts src/single-instance.test.ts src/index.ts
git commit -m "feat(host): single-instance lock via loopback port bind"
```

---

### Task 2: 主循环存活看门狗

**Files:**
- Create: `src/loop-watchdog.ts`
- Test: `src/loop-watchdog.test.ts`
- Modify: `src/index.ts`(主循环打卡 + `main()` 启动看门狗定时器)

**Interfaces:**
- Produces: `checkLoopStall(now: number, lastTickAt: number, thresholdMs: number, onStall: () => void): void` —— `now - lastTickAt > thresholdMs` 时调用 `onStall`,否则不调用。

- [ ] **Step 1: 写失败测试**

`src/loop-watchdog.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { checkLoopStall } from './loop-watchdog.js';

describe('checkLoopStall', () => {
  it('calls onStall when the loop has not ticked within the threshold', () => {
    const onStall = vi.fn();
    checkLoopStall(200_000, 0, 180_000, onStall);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it('does not call onStall when within the threshold', () => {
    const onStall = vi.fn();
    checkLoopStall(100_000, 0, 180_000, onStall);
    expect(onStall).not.toHaveBeenCalled();
  });

  it('treats exactly-at-threshold as not stalled', () => {
    const onStall = vi.fn();
    checkLoopStall(180_000, 0, 180_000, onStall);
    expect(onStall).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/loop-watchdog.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 写最小实现**

`src/loop-watchdog.ts`:

```typescript
/**
 * Pure watchdog check: if the message loop hasn't ticked within thresholdMs,
 * invoke onStall (the caller wires onStall to process.exit so launchd restarts).
 */
export function checkLoopStall(
  now: number,
  lastTickAt: number,
  thresholdMs: number,
  onStall: () => void,
): void {
  if (now - lastTickAt > thresholdMs) onStall();
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/loop-watchdog.test.ts`
Expected: PASS(3 个)。

- [ ] **Step 5: 主循环打卡 + 启动看门狗**

`src/index.ts` 顶部 import:

```typescript
import { checkLoopStall } from './loop-watchdog.js';
```

模块级变量(与其它 module-level state 并列,如 `lastTimestamp` 附近)加:

```typescript
let lastLoopTickAt = Date.now();
```

`startMessageLoop` 的 `while (true) {` 之后**第一行**加打卡:

```typescript
  while (true) {
    lastLoopTickAt = Date.now();
    try {
```

`main()` 里(在启动消息循环处附近,确保只装一次)加看门狗定时器:

```typescript
  const stallMs = Number(process.env.NANOCLAW_LOOP_STALL_MS ?? 180_000);
  setInterval(() => {
    checkLoopStall(Date.now(), lastLoopTickAt, stallMs, () => {
      logger.error(
        { stallMs, sinceMs: Date.now() - lastLoopTickAt },
        '[watchdog] message loop stalled; exiting for restart',
      );
      process.exit(1);
    });
  }, 30_000).unref();
```

(`.unref()` 让该定时器不阻止进程正常退出。)

- [ ] **Step 6: 构建 + 全量测试**

Run: `npm run build && npx vitest run`
Expected: tsc 干净;全量(含 Task 1/2 新测试)PASS,无回归。

- [ ] **Step 7: Commit**

```bash
git add src/loop-watchdog.ts src/loop-watchdog.test.ts src/index.ts
git commit -m "feat(host): message-loop stall watchdog (auto-restart on hang)"
```

---

### Task 3: 更新 spec 机制说明(flock → port bind)

**Files:**
- Modify: `docs/superpowers/specs/2026-06-23-host-single-instance-lock-watchdog-design.md`

- [ ] **Step 1: 把 spec 组件 1 的 `flock` 描述改为端口绑定**

把"对 `store/nanoclaw.lock` 抢一把独占非阻塞 `flock`"那段,替换为:绑定 `127.0.0.1:<端口>`(默认 47291,`NANOCLAW_LOCK_PORT` 可覆盖)作为单实例锁;OS 保证同端口仅一个进程持有,进程死亡自动释放。说明:Node 无原生 flock,端口绑定取得同等"原子 + 自动释放"语义。

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-06-23-host-single-instance-lock-watchdog-design.md
git commit -m "docs(spec): note flock→loopback-port-bind for the single-instance lock"
```

---

### 收尾:验证 + 部署 + review

- [ ] **全量测试 + 构建**:`npm run build && npx vitest run` → 全绿。
- [ ] **手动验收(锁)**:`node dist/index.js` 启第二个实例 → 它打印 `another nanoclaw host instance is already running` 并退出 1;原实例不受影响。
- [ ] **手动验收(看门狗)**:临时把 `NANOCLAW_LOOP_STALL_MS` 设很小并人为阻塞循环验证触发(或信任单测 + 代码审查)。
- [ ] **部署**:重启 host(单实例锁生效后,确保只剩一个)。
- [ ] **code review**:`superpowers:requesting-code-review` 派审,`receiving-code-review` 处理反馈。

## Self-Review(plan vs spec)

- spec 组件 1(单实例锁)→ Task 1。✅(机制 flock→端口绑定,Task 3 同步 spec)
- spec 组件 2(看门狗)→ Task 2。✅
- spec 错误处理(拿不到锁退出 1 / 看门狗 exit(1))→ Task 1 Step5、Task 2 Step5。✅
- spec 测试策略(纯函数单测,不测 process.exit)→ Task 1/2 测试只测获取结果与 stall 判定。✅
- spec 验收标准 1-5 → 收尾手动验收 + 单测 + 多群不受影响(锁不碰路由)。✅
- 已知偏离:flock→端口绑定,已在 Global Constraints + Task 3 记录并同步 spec。
