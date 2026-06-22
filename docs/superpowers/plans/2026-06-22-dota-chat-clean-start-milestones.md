# DOTA 原地优化(方案 A)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让飞书群里显式触发的 DOTA run 跑得更快、不像冻住——启动时按需 compact 甩掉累积上下文、每个 Phase 回贴里程碑、写文档命中 429 自动退避。

**Architecture:** 三个正交改动。组件 1(compact-on-DOTA-start)全部收敛在 agent-runner 进程内,复用已有的 `IdleCompactController` + `stream.push('/compact')`,在 IPC 续传消息命中 DOTA 触发词且进程内已知上下文超阈值时,先注入一次 /compact 再跑;不碰 DB/host/env。组件 2 是群 CLAUDE.md 治理项(零代码)。组件 3 给 feishu-blocks-mcp 的共享 axios 实例加 429 指数退避拦截器,一处覆盖所有写块调用。

**Tech Stack:** TypeScript, Node, vitest, axios, MCP SDK。

## Global Constraints

- TDD:每个代码改动先写失败测试,看它失败,再写最小实现。
- 触发词集合(verbatim,组件 1/2 共用):`/dota`、`/dota-bugfix`、`走 DOTA`、`DOTA 一下`、`上 superpowers`(`dota`/`superpowers` 大小写不敏感)。
- compact 力度 = 软压(/compact),自动,**仅当进程内已知上下文 ≥ idle-compact 阈值**(`getIdleCompactConfig(sdkEnv).thresholdTokens`,默认 ~auto-compact 窗口 75%)时触发;低于阈值或上下文未知则跳过。
- 不动"一群一 session"架构;不接后台任务队列(那是 B-via-tmux)。
- 两个工程(根 + container/agent-runner)`tsc` 必须干净;改哪个工程跑哪个工程的 vitest。
- 关联 spec:`docs/superpowers/specs/2026-06-22-dota-chat-clean-start-milestones-design.md`。

---

### Task 1: DOTA 触发词识别(纯函数)

**Files:**
- Modify: `container/agent-runner/src/index.ts`(新增 `export function isDotaTrigger`,放在 `IdleCompactController` 之前的工具函数区)
- Test: `container/agent-runner/src/index.test.ts`

**Interfaces:**
- Produces: `export function isDotaTrigger(text: string): boolean`

- [ ] **Step 1: 写失败测试**

在 `container/agent-runner/src/index.test.ts` 顶部 import 区把 `isDotaTrigger` 加入从 `./index.js` 的 import(与已有 `getIdleCompactConfig` 等并列),然后新增:

```typescript
describe('isDotaTrigger', () => {
  it('matches explicit DOTA trigger phrases', () => {
    expect(isDotaTrigger('/dota 还价文案不一致')).toBe(true);
    expect(isDotaTrigger('/dota-bugfix 列表页崩了')).toBe(true);
    expect(isDotaTrigger('走 DOTA 把这个需求做了')).toBe(true);
    expect(isDotaTrigger('DOTA 一下')).toBe(true);
    expect(isDotaTrigger('上 superpowers')).toBe(true);
    expect(isDotaTrigger('前面的 dota 流程你继续啊')).toBe(true);
  });

  it('is case-insensitive for dota / superpowers', () => {
    expect(isDotaTrigger('/DOTA foo')).toBe(true);
    expect(isDotaTrigger('上 SuperPowers')).toBe(true);
  });

  it('does not match ordinary messages', () => {
    expect(isDotaTrigger('帮我看下这个 bug')).toBe(false);
    expect(isDotaTrigger('endorota 是什么')).toBe(false); // 不误伤含子串的词
    expect(isDotaTrigger('')).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd container/agent-runner && npx vitest run src/index.test.ts -t isDotaTrigger`
Expected: FAIL —— `isDotaTrigger is not a function` / import 不存在。

- [ ] **Step 3: 写最小实现**

在 `container/agent-runner/src/index.ts` 的 `IdleCompactController` 定义之前加入:

```typescript
/**
 * True when an inbound message explicitly asks to run the DOTA quality
 * pipeline. Trigger phrases are fixed strings (matched host/runner-side, no
 * LLM needed). Used to compact the session before the heavy run begins.
 */
export function isDotaTrigger(text: string): boolean {
  if (!text) return false;
  return (
    /(^|\s)\/dota(-bugfix)?\b/i.test(text) ||
    /走\s*dota/i.test(text) ||
    /\bdota\s*一下/i.test(text) ||
    /dota\s*流程/i.test(text) ||
    /上\s*superpowers/i.test(text)
  );
}
```

注:`\bdota` 用单词边界避免误伤 `endorota`;`/dota` 形态要求行首或空白前缀。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd container/agent-runner && npx vitest run src/index.test.ts -t isDotaTrigger`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/index.ts container/agent-runner/src/index.test.ts
git commit -m "feat(agent-runner): add isDotaTrigger detection for DOTA pipeline phrases"
```

---

### Task 2: IdleCompactController.compactNow()(按需立即压)

**Files:**
- Modify: `container/agent-runner/src/index.ts`(`IdleCompactController` 类内新增 `compactNow()`)
- Test: `container/agent-runner/src/index.test.ts`

**Interfaces:**
- Consumes: 现有 `IdleCompactController` 构造(`new IdleCompactController(cfg, pushCompact)`)、私有 `contextTokens`(经 `onContextTokens` 更新)、私有 `inFlight`、`cfg.thresholdTokens`。
- Produces: `compactNow(): boolean`(发起了 /compact 返回 true,因门槛/在途跳过返回 false)。

- [ ] **Step 1: 写失败测试**

在 `container/agent-runner/src/index.test.ts` 的 IdleCompact 相关 describe 里新增:

```typescript
describe('IdleCompactController.compactNow', () => {
  const cfg = { enabled: true, thresholdTokens: 45000, delayMs: 30000 };

  it('pushes /compact immediately when context is at/over threshold', () => {
    const pushed: string[] = [];
    const c = new IdleCompactController(cfg, () => pushed.push('/compact'));
    c.onContextTokens(60000);
    expect(c.compactNow()).toBe(true);
    expect(pushed).toEqual(['/compact']);
    expect(c.compactInFlight).toBe(true);
  });

  it('skips when context is below threshold', () => {
    const pushed: string[] = [];
    const c = new IdleCompactController(cfg, () => pushed.push('/compact'));
    c.onContextTokens(1000);
    expect(c.compactNow()).toBe(false);
    expect(pushed).toEqual([]);
  });

  it('skips when context is unknown (cold start)', () => {
    const pushed: string[] = [];
    const c = new IdleCompactController(cfg, () => pushed.push('/compact'));
    expect(c.compactNow()).toBe(false);
    expect(pushed).toEqual([]);
  });

  it('skips when a compact is already in flight', () => {
    const pushed: string[] = [];
    const c = new IdleCompactController(cfg, () => pushed.push('/compact'));
    c.onContextTokens(60000);
    c.compactNow();
    expect(c.compactNow()).toBe(false); // second call no-ops
    expect(pushed).toEqual(['/compact']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd container/agent-runner && npx vitest run src/index.test.ts -t "compactNow"`
Expected: FAIL —— `compactNow is not a function`。

- [ ] **Step 3: 写最小实现**

在 `IdleCompactController` 类里(`onResult` 之后、`get compactInFlight` 之前)加入:

```typescript
  /**
   * Force a /compact now, bypassing the idle timer — used to shrink the
   * session right before a heavy DOTA run. No-op (returns false) if a compact
   * is already in flight, or if the latest context is unknown or below the
   * threshold (cold/small sessions don't need it and a no-op /compact may
   * never yield a boundary). The compact turn's result is suppressed by the
   * existing onResult()/onCompactBoundary() path.
   */
  compactNow(): boolean {
    if (this.inFlight) return false;
    if (
      this.contextTokens === undefined ||
      this.contextTokens < this.cfg.thresholdTokens
    ) {
      return false;
    }
    this.cancel();
    this.inFlight = true;
    this.boundarySeen = false;
    log(
      `DOTA-start compact: context ~${this.contextTokens} tokens >= ${this.cfg.thresholdTokens}, sending /compact`,
    );
    this.pushCompact();
    return true;
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd container/agent-runner && npx vitest run src/index.test.ts -t "compactNow"`
Expected: PASS。同时全量 `npx vitest run src/index.test.ts` 不破其它 IdleCompact 测试。

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/index.ts container/agent-runner/src/index.test.ts
git commit -m "feat(agent-runner): IdleCompactController.compactNow() for on-demand compaction"
```

---

### Task 3: 把 compact-on-DOTA-start 接进 runQuery 的 IPC 续传路径

**Files:**
- Modify: `container/agent-runner/src/index.ts`(`runQuery` 内 IPC pipe-in 循环,当前 line 670-677 附近)

**Interfaces:**
- Consumes: `isDotaTrigger`(Task 1)、`idleCompact.compactNow()`(Task 2)、现有 `stream.push`。

- [ ] **Step 1: 实现接线**

在 `runQuery` 的 `pollIpcDuringQuery` 里,把续传消息推入 stream 的 for 循环改为:命中 DOTA 触发词时,先 `compactNow()` 再 push 文本。当前代码:

```typescript
    for (const m of messages) {
      log(`Piping IPC message into active query (${m.text.length} chars)`);
      stream.push(m.text, m.images);
    }
```

改为:

```typescript
    for (const m of messages) {
      if (isDotaTrigger(m.text) && idleCompact.compactNow()) {
        log('DOTA trigger detected in IPC message; injected /compact before run');
      }
      log(`Piping IPC message into active query (${m.text.length} chars)`);
      stream.push(m.text, m.images);
    }
```

(`compactNow()` 内部 `pushCompact` = `stream.push('/compact')`,FIFO 保证 /compact 这一 turn 先于消息文本执行;门槛不过则不注入,行为不变。)

> **已知限制(不在本任务修)**:若 DOTA 触发词是冷启动进程的**第一条** prompt(`stream.push(prompt)` at line 647,此时 `contextTokens` 仍 undefined),`compactNow()` 会因"上下文未知"跳过。这是边缘场景(进程冷启动且 resume 了大 session 且首条即 DOTA);常态下 DOTA 触发是打进已活会话、走 IPC 续传,此路径已覆盖。后续可在 B-via-tmux 或单独迭代处理。

- [ ] **Step 2: 构建确认类型/编译干净**

Run: `cd container/agent-runner && npm run build`
Expected: tsc 无报错。

- [ ] **Step 3: 全量测试确认无回归**

Run: `cd container/agent-runner && npx vitest run`
Expected: 全部 PASS(含 Task 1/2 新测试与既有 IdleCompact 测试)。

> 说明:`runQuery` 是长流式函数、依赖真实 SDK 流,单元测试不直接覆盖这两行接线;正确性由 Task 1/2 的纯函数/控制器单测 + 编译 + 运行期日志(`DOTA-start compact: ...`)保证。验收见 Task 5 后的手动验证。

- [ ] **Step 4: Commit**

```bash
git add container/agent-runner/src/index.ts
git commit -m "feat(agent-runner): compact session on DOTA trigger via IPC pipe-in"
```

---

### Task 4: append_blocks 429 指数退避(feishu-blocks-mcp)

**Files:**
- Modify: `container/feishu-blocks-mcp/src/index.ts`(新增退避决策纯函数 + 给 `feishuHttp` 加响应拦截器,line 35 附近)
- Test: `container/feishu-blocks-mcp/src/backoff.test.ts`(新建;若该工程无 vitest 配置,见 Step 0)

**Interfaces:**
- Produces: `export function feishuRetryDelayMs(attempt: number): number`(第 attempt 次重试的退避毫秒,含 jitter 上限);拦截器使用它。

- [ ] **Step 0: 确认 container/feishu-blocks-mcp 有 vitest**

Run: `cd container/feishu-blocks-mcp && cat package.json`
- 若已有 `vitest` 依赖与 test 脚本 → 直接用。
- 若没有 → 把退避纯函数 `feishuRetryDelayMs` 与拦截器分文件:纯函数放 `container/feishu-blocks-mcp/src/backoff.ts` 并 `export`,在根工程(已用 vitest)新增测试 `src/feishu-backoff.test.ts` 直接 import 该相对路径测试纯函数;拦截器在 `index.ts` 引用它。(纯函数无 IO,跨工程 import 测试可行。)实施时按实际 vitest 归属择一,本计划默认纯函数可测即可。

- [ ] **Step 1: 写失败测试**(以纯函数为测试对象)

```typescript
import { describe, expect, it } from 'vitest';
import { feishuRetryDelayMs } from '../container/feishu-blocks-mcp/src/backoff.js';

describe('feishuRetryDelayMs', () => {
  it('grows exponentially with attempt', () => {
    expect(feishuRetryDelayMs(1)).toBeGreaterThanOrEqual(500);
    expect(feishuRetryDelayMs(1)).toBeLessThanOrEqual(1500); // base 1s ± jitter
    expect(feishuRetryDelayMs(2)).toBeGreaterThan(feishuRetryDelayMs(1) - 1); // ~2s
    expect(feishuRetryDelayMs(3)).toBeGreaterThan(2000); // ~4s
  });

  it('caps the delay', () => {
    expect(feishuRetryDelayMs(10)).toBeLessThanOrEqual(30000);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/feishu-backoff.test.ts`(在测试归属工程内)
Expected: FAIL —— 模块/函数不存在。

- [ ] **Step 3: 写纯函数实现**

新建 `container/feishu-blocks-mcp/src/backoff.ts`:

```typescript
/**
 * Exponential backoff (base 1s, ×2 per attempt) with up to ±50% jitter,
 * capped at 30s. attempt is 1-based (1 = first retry).
 */
export function feishuRetryDelayMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** (attempt - 1), 30000);
  const jitter = base * 0.5 * (((attempt * 2654435761) % 1000) / 1000); // deterministic jitter, no Math.random
  return Math.min(Math.round(base + jitter), 30000);
}

export const FEISHU_MAX_RETRIES = 4;
```

(用确定性 jitter 避免依赖 `Math.random`,既可测又够散。)

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/feishu-backoff.test.ts`
Expected: PASS。

- [ ] **Step 5: 给 feishuHttp 加退避拦截器**

在 `container/feishu-blocks-mcp/src/index.ts` line 35 `const feishuHttp = axios.create({ proxy: false });` 之后加入:

```typescript
import { feishuRetryDelayMs, FEISHU_MAX_RETRIES } from "./backoff.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Retry on Feishu rate limiting (HTTP 429). Covers every feishuHttp call
// (append blocks, tables, images, sheets, bitable) from one place.
feishuHttp.interceptors.response.use(undefined, async (error) => {
  const cfg = error?.config;
  const status = error?.response?.status;
  if (status === 429 && cfg) {
    cfg.__retryCount = (cfg.__retryCount ?? 0) + 1;
    if (cfg.__retryCount <= FEISHU_MAX_RETRIES) {
      const delay = feishuRetryDelayMs(cfg.__retryCount);
      await sleep(delay);
      return feishuHttp(cfg);
    }
  }
  return Promise.reject(error);
});
```

- [ ] **Step 6: 构建确认编译干净**

Run: `cd container/feishu-blocks-mcp && npm run build`
Expected: tsc 无报错。

- [ ] **Step 7: Commit**

```bash
git add container/feishu-blocks-mcp/src/backoff.ts container/feishu-blocks-mcp/src/index.ts <test file>
git commit -m "feat(feishu-blocks-mcp): exponential backoff retry on 429 for all feishu calls"
```

---

### Task 5: 阶段里程碑治理 + 落点(零代码)

**Files:**
- Modify:DOTA 治理段所在的 CLAUDE.md(实施时先定位,见 Step 1)

- [ ] **Step 1: 定位 DOTA 治理段的权威落点**

Run: `grep -rl "DOTA 三国管线\|方案挡六步\|/dota <需求>" groups/global/CLAUDE.md groups/feishu_main/CLAUDE.md groups/feishu_pm-lite/CLAUDE.md`
按 [[reference_nanoclaw_global_claudemd_inheritance]]:global 覆盖非 main 群、feishu_main 独立。若 DOTA 段在 `groups/global/CLAUDE.md` → 改 global + feishu_main 双写;若只在各群副本 → 改 global 使其全员生效(并视情况补 feishu_main)。

- [ ] **Step 2: 在 DOTA 治理段加里程碑铁律**

在"DOTA 三国管线"小节加入一条:

```markdown
**Phase 边界里程碑(必做):** 每跨入一个 Phase,先用 `send_message` 发一条单行里程碑,例:`✓ Phase 2 plan 完成 → ▶ Phase 3 审查(critic)`。实时工具细节仍走流式卡片;里程碑用于让用户随时看到推进、判断是否卡死。8 个 Phase ≈ 8 条,不要在 Phase 内部刷屏。
```

- [ ] **Step 3: Commit**

```bash
git add groups/global/CLAUDE.md  # 及/或 groups/feishu_main/CLAUDE.md
git commit -m "docs(governance): DOTA 每 Phase 边界回贴里程碑消息"
```

---

### 收尾:验证 + code review

- [ ] **构建+全量测试(两工程)**
  - Run: `npm run build && npx vitest run`(根工程)
  - Run: `cd container/agent-runner && npm run build && npx vitest run`
  - Expected: 全绿,tsc 干净。
- [ ] **重启 host 让改动生效**:`launchctl kickstart -k gui/$(id -u)/com.nanoclaw`(agent-runner 改动需重编 dist;feishu-blocks-mcp 同理)。
- [ ] **手动验收(组件 1+2)**:在测试群发「走 DOTA <小需求>」,观察日志出现 `DOTA-start compact`,且每 Phase 群里出现里程碑消息。
- [ ] **手动验收(组件 3)**:DOTA 写文档阶段不再"写一块干等一块";日志/行为显示 429 被退避吸收。
- [ ] **code review**:按 `superpowers:requesting-code-review` 派审,`receiving-code-review` 处理反馈。

## Self-Review(plan vs spec 覆盖)

- spec 组件 1(compact-on-start)→ Task 1+2+3。✅
- spec 组件 2(里程碑)→ Task 5。✅
- spec 组件 3(429 退避)→ Task 4。✅
- spec 错误处理(compact 失败降级)→ compactNow 门槛跳过即"降级为照常跑";429 超上限 reject 原错误(不静默吞)。✅
- spec 验收标准 1-5 → 收尾手动验收 + 两工程测试覆盖。✅
- 开放点(阈值门数据来源)→ plan 选定"进程内 lastContextTokens"(spec 选项 2 的轻量变体,无需 DB/host/env),并在 Task 3 记录冷启动首条的已知限制。✅
