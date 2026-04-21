import fs from 'fs';
import path from 'path';

const DEFAULT_IPC_DIR = '/workspace/ipc';

function ipcDir(): string {
  return process.env.NANOCLAW_IPC_DIR || DEFAULT_IPC_DIR;
}

function randomHex(n: number): string {
  const chars = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * 16)];
  return s;
}

export async function callSync<Req extends object, Resp>(
  action: string,
  data: Req,
  timeoutMs = 15000,
): Promise<Resp> {
  const base = ipcDir();
  const reqDir = path.join(base, 'sync_requests');
  const respDir = path.join(base, 'sync_responses');
  fs.mkdirSync(reqDir, { recursive: true });
  fs.mkdirSync(respDir, { recursive: true });

  const reqid = `${Date.now()}-${randomHex(8)}`;
  const reqPath = path.join(reqDir, `${reqid}.json`);
  const respPath = path.join(respDir, `${reqid}.json`);

  const tmpPath = `${reqPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify({ action, ...data }));
  fs.renameSync(tmpPath, reqPath);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(respPath)) {
      const raw = fs.readFileSync(respPath, 'utf-8');
      try { fs.unlinkSync(respPath); } catch { /* noop */ }
      try { fs.unlinkSync(reqPath); } catch { /* noop */ }
      const body = JSON.parse(raw);
      if (body.error) throw new Error(body.error);
      return body.data as Resp;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  try { fs.unlinkSync(reqPath); } catch { /* noop */ }
  throw new Error(`sync IPC timeout after ${timeoutMs}ms: ${action}`);
}
