import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunEvent, TaskRecord } from './types.js';

export interface TaskStore {
  init(): Promise<void>;
  saveMeta(record: TaskRecord): Promise<void>;
  appendEvent(taskId: string, event: RunEvent): Promise<void>;
  loadAll(): Promise<TaskRecord[]>;
  /** 清理过期/超额任务时删除其落盘目录。 */
  remove(taskId: string): Promise<void>;
}

/**
 * 任务落盘：每个任务一个目录
 *   <tasksDir>/<taskId>/meta.json     状态与结果（不含事件）
 *   <tasksDir>/<taskId>/events.jsonl  事件流（追加写）
 * 重启后可恢复任务列表（进行中的任务会被标记为 interrupted）。
 */
export class JsonlTaskStore implements TaskStore {
  /** 同一任务的事件追加串行化：并发 appendFile 可能在多字节字符中间交错写，破坏原始 JSONL。 */
  private readonly appendChains = new Map<string, Promise<void>>();

  constructor(private readonly root: string) {}

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  dirFor(taskId: string): string {
    return join(this.root, taskId);
  }

  async saveMeta(record: TaskRecord): Promise<void> {
    const dir = this.dirFor(record.id);
    await mkdir(dir, { recursive: true });
    const { events: _events, ...meta } = record;
    const target = join(dir, 'meta.json');
    const tmp = `${target}.tmp`;
    await writeFile(tmp, JSON.stringify(meta, null, 2), 'utf8');
    await rename(tmp, target);
  }

  async appendEvent(taskId: string, event: RunEvent): Promise<void> {
    const line = `${JSON.stringify(event)}\n`;
    const previous = this.appendChains.get(taskId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const dir = this.dirFor(taskId);
        await mkdir(dir, { recursive: true });
        await appendFile(join(dir, 'events.jsonl'), line, 'utf8');
      });
    this.appendChains.set(taskId, next);
    try {
      await next;
    } finally {
      if (this.appendChains.get(taskId) === next) this.appendChains.delete(taskId);
    }
  }

  async remove(taskId: string): Promise<void> {
    await rm(this.dirFor(taskId), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }

  async loadAll(): Promise<TaskRecord[]> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    const records: TaskRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(this.root, entry.name);
      try {
        const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as Omit<TaskRecord, 'events'>;
        const rawEvents = await readFile(join(dir, 'events.jsonl'), 'utf8').catch(() => '');
        const events = rawEvents
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .map((line) => {
            try {
              return JSON.parse(line) as RunEvent;
            } catch {
              return null;
            }
          })
          .filter((event): event is RunEvent => event !== null && typeof event.type === 'string');
        records.push({ ...meta, events });
      } catch {
        // 损坏的任务目录直接跳过，不影响 worker 启动
      }
    }
    return records;
  }
}
