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
