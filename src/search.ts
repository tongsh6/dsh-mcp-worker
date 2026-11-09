import type { TaskRecord } from './types.js';

export interface SearchMatch {
  task_id: string;
  status: string;
  cwd: string;
  field: 'output' | 'event';
  snippet: string;
}

/**
 * 在已结束/运行中任务的最终输出与工具结果里做大小写不敏感的子串检索。
 * 结果有界（默认 20 条、每条 snippet 200 字符），避免把 worker 内存打爆。
 */
export function searchTasks(tasks: TaskRecord[], query: string, limit = 20, snippetSize = 200): SearchMatch[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  const max = Math.max(1, Math.min(100, Math.trunc(limit)));
  const matches: SearchMatch[] = [];

  for (const task of tasks) {
    if (matches.length >= max) break;
    const fields: Array<{ field: SearchMatch['field']; text: string }> = [];
    if (typeof task.finalText === 'string' && task.finalText.length > 0) {
      fields.push({ field: 'output', text: task.finalText });
    }
    for (const event of task.events) {
      if (event.type !== 'tool_result') continue;
      const text = stringify(event.result);
      if (text.length > 0) fields.push({ field: 'event', text: text.slice(0, 4_000) });
    }

    for (const { field, text } of fields) {
      const index = text.toLowerCase().indexOf(needle);
      if (index < 0) continue;
      matches.push({
        task_id: task.id,
        status: task.status,
        cwd: task.cwd,
        field,
        snippet: makeSnippet(text, index, needle.length, snippetSize),
      });
      break;
    }
  }
  return matches;
}

function makeSnippet(text: string, index: number, needleLength: number, size: number): string {
  const half = Math.floor(size / 2);
  const start = Math.max(0, index - half);
  const end = Math.min(text.length, index + needleLength + half);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}
