import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MessageStream, drainIpcInput, _setIpcInputDir } from './index.js';

describe('MessageStream multimodal', () => {
  it('yields string content when no images', async () => {
    const ms = new MessageStream();
    ms.push('hello');
    ms.end();
    const out = [];
    for await (const m of ms) out.push(m);
    expect(out).toHaveLength(1);
    expect(out[0].message.content).toBe('hello');
  });

  it('yields ContentBlockParam[] when images present', async () => {
    const ms = new MessageStream();
    ms.push('hello', [
      { mediaType: 'image/jpeg', base64: 'AAAA', sourceKey: 'k1' },
    ]);
    ms.end();
    const out = [];
    for await (const m of ms) out.push(m);
    expect(out[0].message.content).toEqual([
      { type: 'text', text: 'hello' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' },
      },
    ]);
  });

  it('yields ContentBlockParam[] with multiple images in order', async () => {
    const ms = new MessageStream();
    ms.push('look', [
      { mediaType: 'image/jpeg', base64: 'AAAA', sourceKey: 'k1' },
      { mediaType: 'image/jpeg', base64: 'BBBB', sourceKey: 'k2' },
    ]);
    ms.end();
    const out = [];
    for await (const m of ms) out.push(m);
    const content = out[0].message.content as any[];
    expect(content).toHaveLength(3);
    expect(content[0].type).toBe('text');
    expect(content[1].source.data).toBe('AAAA');
    expect(content[2].source.data).toBe('BBBB');
  });
});

describe('drainIpcInput multimodal', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-test-'));
    _setIpcInputDir(tmp);
  });
  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('parses IPC file with images field', () => {
    fs.writeFileSync(
      path.join(tmp, '1.json'),
      JSON.stringify({
        type: 'message',
        text: 'hi',
        images: [{ mediaType: 'image/jpeg', base64: 'AAAA', sourceKey: 'k1' }],
      }),
    );
    const out = drainIpcInput();
    expect(out).toEqual([
      {
        text: 'hi',
        images: [{ mediaType: 'image/jpeg', base64: 'AAAA', sourceKey: 'k1' }],
      },
    ]);
  });

  it('parses IPC file without images field (backward compat)', () => {
    fs.writeFileSync(
      path.join(tmp, '2.json'),
      JSON.stringify({ type: 'message', text: 'hi' }),
    );
    const out = drainIpcInput();
    expect(out).toEqual([{ text: 'hi' }]);
    expect(out[0].images).toBeUndefined();
  });

  it('skips files with invalid JSON', () => {
    fs.writeFileSync(path.join(tmp, 'bad.json'), '{not json');
    fs.writeFileSync(
      path.join(tmp, 'good.json'),
      JSON.stringify({ type: 'message', text: 'ok' }),
    );
    const out = drainIpcInput();
    expect(out).toEqual([{ text: 'ok' }]);
  });
});
