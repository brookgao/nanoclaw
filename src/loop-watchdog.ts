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
