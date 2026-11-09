import type { RunEvent } from './types.js';

/**
 * 按行解析 DSH `--json` 的 NDJSON 事件流。
 * 容忍跨 chunk 的半行、空行、CRLF，以及非法 JSON（只计数，不抛错）。
 */
export class NdjsonParser {
  private buffer = '';
  private readonly maxBufferChars: number;
  /** 被跳过的非法/非事件行数量（诊断用）。 */
  skipped = 0;

  constructor(maxBufferChars = 8 * 1024 * 1024) {
    this.maxBufferChars = maxBufferChars;
  }

  push(chunk: string): RunEvent[] {
    this.buffer += chunk;
    const events: RunEvent[] = [];
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      const event = parseLine(line);
      if (event) {
        events.push(event);
      } else if (line.trim().length > 0) {
        this.skipped += 1;
      }
      index = this.buffer.indexOf('\n');
    }
    // 防御：异常超长且没有换行的残片直接丢弃，避免无界内存增长
    if (this.buffer.length > this.maxBufferChars) {
      this.buffer = '';
      this.skipped += 1;
    }
    return events;
  }

  /** 进程结束时调用：处理最后一行没有换行的残留内容。 */
  flush(): RunEvent[] {
    const rest = this.buffer;
    this.buffer = '';
    if (rest.trim().length === 0) return [];
    const event = parseLine(rest);
    if (event) return [event];
    this.skipped += 1;
    return [];
  }
}

function parseLine(line: string): RunEvent | null {
  const text = line.trim();
  if (text.length === 0) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (value !== null && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string') {
      return value as RunEvent;
    }
    return null;
  } catch {
    return null;
  }
}
