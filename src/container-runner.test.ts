import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  ONECLI_URL: 'http://localhost:10254',
  TIMEZONE: 'America/Los_Angeles',
  GH_TOKEN: undefined,
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Mock container-runtime
vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  hostGatewayArgs: () => [],
  readonlyMountArgs: (h: string, c: string) => ['-v', `${h}:${c}:ro`],
  stopContainer: vi.fn(),
}));

// Mock OneCLI SDK
vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    applyContainerConfig = vi.fn().mockResolvedValue(true);
    createAgent = vi.fn().mockResolvedValue({ id: 'test' });
    ensureAgent = vi
      .fn()
      .mockResolvedValue({ name: 'test', identifier: 'test', created: true });
  },
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import { runContainerAgent, ContainerOutput } from './container-runner.js';
import type { ContainerInput } from './container-runner.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});

describe('timeout resolution', () => {
  it('resolveIdleMs returns per-group idleTimeout when set', async () => {
    const { resolveIdleMs } = await import('./container-runner.js');
    const group: RegisteredGroup = {
      name: 't',
      folder: 't',
      trigger: '@t',
      added_at: '',
      containerConfig: { idleTimeout: 120000 },
    };
    expect(resolveIdleMs(group)).toBe(120000);
  });

  it('resolveIdleMs falls back to global IDLE_TIMEOUT when unset', async () => {
    const { resolveIdleMs } = await import('./container-runner.js');
    const group: RegisteredGroup = {
      name: 't',
      folder: 't',
      trigger: '@t',
      added_at: '',
    };
    // IDLE_TIMEOUT mock = 1800000 (see mock at top of file)
    expect(resolveIdleMs(group)).toBe(1800000);
  });

  it('computeHardTimeoutMs floors on per-group idleTimeout + 30s grace', async () => {
    const { computeHardTimeoutMs } = await import('./container-runner.js');
    const group: RegisteredGroup = {
      name: 't',
      folder: 't',
      trigger: '@t',
      added_at: '',
      containerConfig: { timeout: 60000, idleTimeout: 120000 },
    };
    // Math.max(60000, 120000 + 30000) = 150000
    expect(computeHardTimeoutMs(group)).toBe(150000);
  });

  it('computeHardTimeoutMs uses global fallback when group has no idleTimeout', async () => {
    const { computeHardTimeoutMs } = await import('./container-runner.js');
    const group: RegisteredGroup = {
      name: 't',
      folder: 't',
      trigger: '@t',
      added_at: '',
    };
    // configTimeout default = CONTAINER_TIMEOUT (1800000 mock);
    // IDLE_TIMEOUT (1800000) + 30000 = 1830000; Math.max = 1830000
    expect(computeHardTimeoutMs(group)).toBe(1830000);
  });
});

describe('buildContainerArgs env injection', () => {
  it('injects CLAUDE_CODE_AUTO_COMPACT_WINDOW when group sets autoCompactWindow', async () => {
    const { buildContainerArgs } = await import('./container-runner.js');
    const group: RegisteredGroup = {
      name: 'test',
      folder: 'test',
      trigger: '@test',
      added_at: '',
      containerConfig: { autoCompactWindow: 100000 },
    };
    const args = await buildContainerArgs(
      [],
      'nanoclaw-test-1',
      undefined,
      group,
    );
    const joined = args.join(' ');
    expect(joined).toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000');
  });

  it('does not inject CLAUDE_CODE_AUTO_COMPACT_WINDOW when group does not set autoCompactWindow', async () => {
    const { buildContainerArgs } = await import('./container-runner.js');
    const group: RegisteredGroup = {
      name: 'test',
      folder: 'test',
      trigger: '@test',
      added_at: '',
    };
    const args = await buildContainerArgs(
      [],
      'nanoclaw-test-2',
      undefined,
      group,
    );
    expect(args.join(' ')).not.toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
  });
});

describe('ContainerInput images field', () => {
  it('ContainerInput serializes images field through JSON', () => {
    const input: ContainerInput = {
      prompt: '<messages/>',
      groupFolder: 'g1',
      chatJid: 'c1',
      isMain: false,
      images: [{ mediaType: 'image/jpeg', base64: 'AAAA', sourceKey: 'k1' }],
    };
    const roundtripped = JSON.parse(JSON.stringify(input));
    expect(roundtripped.images).toHaveLength(1);
    expect(roundtripped.images[0].sourceKey).toBe('k1');
  });

  it('ContainerInput omits images field when undefined', () => {
    const input: ContainerInput = {
      prompt: '<messages/>',
      groupFolder: 'g1',
      chatJid: 'c1',
      isMain: false,
    };
    const roundtripped = JSON.parse(JSON.stringify(input));
    expect('images' in roundtripped).toBe(false);
  });
});
