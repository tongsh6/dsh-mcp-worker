import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuditEntry } from './types.js';

/**
 * 审计日志：append-only JSONL。
 * 记录任务生命周期、审批决定等有外部影响的事件，便于事后追溯。
 */
export class AuditLog {
  constructor(private readonly dir: string) {}

  get filePath(): string {
    return join(this.dir, 'audit.jsonl');
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async append(entry: AuditEntry): Promise<void> {
    await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  /** 读取最近 limit 条（按时间正序返回；损坏行忽略）。 */
  async read(limit = 50): Promise<AuditEntry[]> {
    const raw = await readFile(this.filePath, 'utf8').catch(() => '');
    const entries: AuditEntry[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        const value = JSON.parse(line) as AuditEntry;
        if (typeof value?.event === 'string') entries.push(value);
      } catch {
        // 损坏行忽略
      }
    }
    return entries.slice(-Math.max(1, limit));
  }
}
