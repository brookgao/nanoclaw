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
    if (!second.ok) expect(second.code).toBe('EADDRINUSE');
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
