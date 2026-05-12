# 飞书文件附件读取

**日期**: 2026-05-12
**状态**: 已批准

## 问题

飞书群里用户上传文件（msg_type=file）时，NanoClaw 的 `parseInbound()` 直接返回 null，agent 完全看不到文件内容。用户 @阿飞 并附带 .md 文件，阿飞只收到 @ 文本，反复要求用户"发一下文件路径"。

## 方案

将文件内容内联到消息正文中交给 agent。不新增类型、不改下游 pipeline。

### 范围

- 仅支持文本类文件（UTF-8 可读）
- 500 KB 大小上限，超限截断并附提示
- 非文本文件只显示文件名和大小，提示用户转格式

### 改动文件

| 文件 | 改动 |
|------|------|
| `src/channels/feishu.ts` | parseInbound 增加 file 类型、handleEvent 增加文件下载+拼接、新增 downloadFile() |
| `src/channels/feishu.test.ts` | 新增 file 类型解析、截断、非文本降级的测试用例 |

不改：`types.ts`、`index.ts`、`container-runner.ts`、`router.ts`。

## 设计

### ParsedInbound 扩展

```typescript
interface ParsedInbound {
  text: string;
  imageKeys: string[];
  botMentioned: boolean;
  fileKey?: string;   // 新增
  fileName?: string;  // 新增
}
```

### parseInbound() 新增 file 分支

飞书 file 消息的 content 结构：`{"file_key": "xxx", "file_name": "openspec.md"}`

```typescript
if (m.message_type === 'file') {
  const c = JSON.parse(m.content);
  const fileKey = c?.file_key;
  const fileName = c?.file_name ?? 'unknown';
  if (!fileKey) return null;
  return { text: '', imageKeys: [], botMentioned, fileKey, fileName };
}
```

### 文本类型白名单

```typescript
const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.yaml', '.yml', '.csv', '.xml',
  '.html', '.htm', '.css', '.js', '.ts', '.jsx', '.tsx',
  '.py', '.go', '.rs', '.java', '.kt', '.rb', '.sh',
  '.sql', '.toml', '.ini', '.cfg', '.conf', '.env',
  '.log', '.svg',
]);
```

无后缀文件也尝试 UTF-8 解码，解码失败按非文本处理。

### handleEvent() 文件处理流程

在图片处理之后、deliver 之前插入：

```
if (parsed.fileKey) {
  reactAck(messageId);
  buf = downloadFile(messageId, fileKey);
  ext = extname(fileName).toLowerCase();

  if (TEXT_EXTENSIONS.has(ext) || ext === '') {
    text = buf.toString('utf-8');
    // 验证 UTF-8 有效性（检查替换字符比例）
    if (非有效 UTF-8) → 走非文本降级
    sizeKB = (buf.length / 1024).toFixed(1);
    if (buf.length > 500 * 1024) {
      text = text.slice(0, 500 * 1024);
      text += `\n[... 文件已截断，原始大小 ${sizeKB} KB，仅显示前 500 KB]`;
    }
    cleanedText += `\n\n---📎 ${fileName} (${sizeKB} KB)---\n${text}\n---文件结束---`;
  } else {
    cleanedText += `\n\n[📎 ${fileName} (${sizeKB} KB) - 不支持的文件类型，请转为文本格式发送]`;
  }
}
```

### downloadFile()

复用 downloadImage() 的模式，`type` 参数改为 `'file'`：

```typescript
async downloadFile(messageId: string, fileKey: string): Promise<Buffer> {
  const res = await this.client.request(
    {
      method: 'GET',
      url: `/open-apis/im/v1/messages/${messageId}/resources/${fileKey}`,
      params: { type: 'file' },
      responseType: 'arraybuffer',
    },
    { maxContentLength: 10 * 1024 * 1024, timeout: 15000 },
  );
  if (Buffer.isBuffer(res)) return res;
  if (res instanceof ArrayBuffer) return Buffer.from(res);
  if (res?.data) return Buffer.from(res.data);
  return Buffer.from(res);
}
```

### 消息拼接示例

用户发送 "@阿飞-PM 根据这个openspec文件去生成测试用例" + openspec.md：

```
根据这个openspec文件去生成测试用例

---📎 openspec.md (23.4 KB)---
# OpenSpec
## 功能需求
...
---文件结束---
```

### 测试用例

1. parseInbound 对 file 类型返回正确的 fileKey / fileName
2. parseInbound 对 file 类型 content 解析失败返回 null
3. 文本文件拼接格式正确
4. 超 500 KB 截断 + 提示文案
5. 非文本后缀的降级提示
6. 无后缀 + 有效 UTF-8 → 当文本处理
7. 无后缀 + 无效 UTF-8 → 当非文本处理
8. audio/video/sticker 仍然返回 null（回归）

### 边界情况

- **file 消息没有伴随文本**：用户只发文件不说话 → `cleanedText` 为空，只有文件内容块。需要确保 `cleanedText` 不为空才能通过下游 DB filter。
- **file + @bot 在群里**：file 消息也可能带 mentions，botMentioned 需正确解析。
- **下载失败**：reactFail + 发送错误提示，不 deliver。
