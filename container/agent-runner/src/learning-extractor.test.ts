// container/agent-runner/src/learning-extractor.test.ts
import { describe, it, expect } from 'vitest';
import { extractLearnings, formatLearningEntry } from './learning-extractor.js';

describe('extractLearnings', () => {
  it('extracts lines containing decision keywords from assistant messages', () => {
    const messages = [
      { role: 'user' as const, content: '为什么这个接口报错了' },
      { role: 'assistant' as const, content: '经过排查，根因是数据库连接池耗尽。解决方案是增加连接池上限到 50。' },
    ];
    const result = extractLearnings(messages);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0]).toContain('根因');
  });

  it('extracts lines following conclusion patterns', () => {
    const messages = [
      { role: 'assistant' as const, content: '分析了三种方案后，\n\n总结：使用 WAL 模式可以解决并发写入问题。' },
    ];
    const result = extractLearnings(messages);
    expect(result.some(l => l.includes('WAL'))).toBe(true);
  });

  it('returns empty array when no learnings found', () => {
    const messages = [
      { role: 'user' as const, content: '你好' },
      { role: 'assistant' as const, content: '你好！有什么可以帮助你的吗？' },
    ];
    const result = extractLearnings(messages);
    expect(result).toEqual([]);
  });

  it('only extracts from assistant messages, not user messages', () => {
    const messages = [
      { role: 'user' as const, content: '结论是什么' },
      { role: 'assistant' as const, content: '请提供更多信息。' },
    ];
    const result = extractLearnings(messages);
    expect(result).toEqual([]);
  });

  it('deduplicates identical extractions', () => {
    const messages = [
      { role: 'assistant' as const, content: '根因是连接池耗尽导致超时。\n根因是连接池耗尽导致超时。' },
    ];
    const result = extractLearnings(messages);
    expect(result.length).toBe(1);
  });
});

describe('formatLearningEntry', () => {
  it('formats with date and source', () => {
    const entry = formatLearningEntry('数据库连接池需要增大到50', 'conversation-debug-db.md');
    expect(entry).toMatch(/^\[\d{4}-\d{2}-\d{2}\]/);
    expect(entry).toContain('数据库连接池需要增大到50');
    expect(entry).toContain('来源: conversation-debug-db.md');
  });
});
