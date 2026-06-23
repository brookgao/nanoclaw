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
    server.once('error', () => resolve({ ok: false }));
    server.listen(port, '127.0.0.1', () => {
      resolve({ ok: true, server });
    });
  });
}
