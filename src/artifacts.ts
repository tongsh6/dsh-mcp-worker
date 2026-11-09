import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkerError } from './errors.js';

const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_READ_CHARS = 100_000;

export interface ArtifactReadResult {
  task_id: string;
  source: 'result' | 'events' | 'diff' | 'evidence';
  file: string;
  content: string;
  offset: number;
  next_offset: number;
  total_chars: number;
  eof: boolean;
}

const SOURCE_FILES: Record<ArtifactReadResult['source'], string> = {
  result: 'result.txt',
  events: 'events.jsonl',
  diff: 'diff.patch',
  evidence: 'evidence.json',
};

/**
 * 分页读取任务落盘产物（result.txt / events.jsonl / diff.patch / evidence.json）。
 * 仅允许 tasksDir 下的合法 task_id，避免路径穿越。
 */
export async function readTaskArtifact(
  tasksDir: string,
  taskId: string,
  source: ArtifactReadResult['source'] = 'result',
  offset = 0,
  maxChars = 20_000,
): Promise<ArtifactReadResult> {
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new WorkerError('bad_request', `非法 task_id：${taskId}`);
  }
  const fileName = SOURCE_FILES[source] ?? 'result.txt';
  const file = join(tasksDir, taskId, fileName);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    throw new WorkerError('task_not_found', `产物不存在：${fileName}（任务可能未落盘或已被清理）`);
  }

  const start = Math.max(0, Math.min(Math.trunc(offset), raw.length));
  const size = Math.max(100, Math.min(Math.trunc(maxChars), MAX_READ_CHARS));
  const content = raw.slice(start, start + size);
  const nextOffset = start + content.length;
  return {
    task_id: taskId,
    source,
    file,
    content,
    offset: start,
    next_offset: nextOffset,
    total_chars: raw.length,
    eof: nextOffset >= raw.length,
  };
}
