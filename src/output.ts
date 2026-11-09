import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface BoundTextOptions {
  /** 返回给 leader 的最大字符数；超出则落盘。 */
  maxChars: number;
  /** 落盘根目录（通常是 tasksDir）。 */
  spillDir: string;
  taskId: string;
  fileName?: string;
}

export interface BoundTextResult {
  text: string;
  spilled: boolean;
  path?: string;
  originalChars: number;
}

/**
 * 控制返回给 leader 的输出体积：超限时把完整内容落盘，返回「摘要 + 路径」。
 * 落盘内容保证无损，便于后续用 read 工具或人工查看。
 */
export async function boundText(text: string, options: BoundTextOptions): Promise<BoundTextResult> {
  const originalChars = text.length;
  if (originalChars <= options.maxChars) {
    return { text, spilled: false, originalChars };
  }

  const dir = join(options.spillDir, options.taskId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, options.fileName ?? 'result.txt');
  await writeFile(path, text, 'utf8');

  const headLength = Math.floor(options.maxChars * 0.7);
  const tailLength = Math.max(0, Math.floor(options.maxChars * 0.2));
  const head = text.slice(0, headLength);
  const tail = tailLength > 0 ? text.slice(-tailLength) : '';

  const summary = [
    `[输出过长：${originalChars} 字符，已截断；完整内容见 ${path}]`,
    '',
    head,
    tailLength > 0 ? '\n...[truncated]...\n' : '\n...[truncated]...',
    tail,
  ].join('\n');

  return { text: summary, spilled: true, path, originalChars };
}
