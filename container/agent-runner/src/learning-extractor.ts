// container/agent-runner/src/learning-extractor.ts

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

const DECISION_KEYWORDS = [
  '结论', '决定', '教训', '发现', '原因是', '解决方案',
  '根因', '要点', '关键', '修复方法', '最佳实践',
];

const CONCLUSION_PATTERNS = [
  /^总结[：:]/m,
  /^所以[，,]/m,
  /^最终[，,]/m,
  /^因此[，,]/m,
  /## (?:结论|要点|总结|教训)/m,
];

export function extractLearnings(messages: ParsedMessage[]): string[] {
  const learnings = new Set<string>();

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;

    const lines = msg.content.split('\n').map(l => l.trim()).filter(Boolean);

    for (const line of lines) {
      if (line.length < 10 || line.length > 500) continue;

      const hasKeyword = DECISION_KEYWORDS.some(kw => line.includes(kw));
      const hasPattern = CONCLUSION_PATTERNS.some(p => p.test(line));

      if (hasKeyword || hasPattern) {
        const cleaned = line
          .replace(/^#+\s*/, '')
          .replace(/^\*\*(.+)\*\*$/, '$1')
          .replace(/^[-*]\s*/, '');
        if (cleaned.length >= 10) {
          learnings.add(cleaned);
        }
      }
    }
  }

  return [...learnings];
}

export function formatLearningEntry(learning: string, source: string): string {
  const date = new Date().toISOString().split('T')[0];
  return `[${date}] ${learning} | 来源: ${source}`;
}
