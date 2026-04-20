import { describe, it, expect } from 'vitest';
import { formatMessages } from './router.js';
import type { NewMessage, ImageAttachment } from './types.js';

const mkImg = (key: string): ImageAttachment => ({
  mediaType: 'image/jpeg',
  base64: 'AAAA',
  sourceKey: key,
});

function mkMsg(content: string, images?: ImageAttachment[]): NewMessage {
  return {
    id: `id-${content}`,
    chat_jid: 'chat',
    sender: 'u',
    sender_name: 'User',
    content,
    timestamp: '2026-04-20T10:00:00Z',
    images,
  };
}

describe('formatMessages image markers', () => {
  it('no images → xml populated, images: []', () => {
    const r = formatMessages([mkMsg('hello')], 'UTC');
    expect(r.xml).toContain('<message');
    expect(r.xml).not.toContain('[图');
    expect(r.images).toEqual([]);
  });

  it('single message with 2 images → [图 1] [图 2] appended', () => {
    const r = formatMessages([mkMsg('what is this?', [mkImg('k1'), mkImg('k2')])], 'UTC');
    expect(r.xml).toContain('what is this? [图 1] [图 2]');
    expect(r.images.map((i) => i.sourceKey)).toEqual(['k1', 'k2']);
  });

  it('two messages with 1 image each → globally numbered', () => {
    const r = formatMessages(
      [mkMsg('first', [mkImg('a')]), mkMsg('second', [mkImg('b')])],
      'UTC',
    );
    expect(r.xml).toMatch(/first \[图 1\].*second \[图 2\]/s);
    expect(r.images.map((i) => i.sourceKey)).toEqual(['a', 'b']);
  });

  it('mixed: one message with images, one without', () => {
    const r = formatMessages([mkMsg('with', [mkImg('a')]), mkMsg('without')], 'UTC');
    expect(r.xml).toContain('with [图 1]');
    expect(r.xml).not.toContain('without [图');
    expect(r.images).toHaveLength(1);
  });
});
