import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface IdempotencyRecord {
  key_hash: string;
  task_id: string;
  created_at: number;
}

/**
 * 幂等键索引：leader 重试同一 `idempotency_key` 时复用已有 task，而不是重复派活。
 * 合并自本机 Codex 在用的 dsh-mcp bridge v2.2.0（`idem-<hash>.json` + TTL）。
 *
 * 落盘文件用 key 的 sha256 前 32 位命名，避免任务文本/路径泄露到文件名。
 */
export class IdempotencyStore {
  constructor(
    private readonly dir: string,
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private hashOf(key: string): string {
    return createHash('sha256').update(key).digest('hex').slice(0, 32);
  }

  private pathFor(key: string): string {
    return join(this.dir, `idem-${this.hashOf(key)}.json`);
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  /** 命中且未过期时返回 task_id；文件缺失/损坏/过期返回 null（过期文件顺手删除）。 */
  async lookup(key: string): Promise<string | null> {
    const path = this.pathFor(key);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      return null;
    }
    let record: IdempotencyRecord;
    try {
      record = JSON.parse(raw) as IdempotencyRecord;
    } catch {
      await this.forget(key);
      return null;
    }
    if (typeof record.task_id !== 'string' || !Number.isFinite(record.created_at)) {
      await this.forget(key);
      return null;
    }
    if (this.ttlMs > 0 && this.now() - record.created_at > this.ttlMs) {
      await this.forget(key);
      return null;
    }
    return record.task_id;
  }

  /** 记录 key → task 映射（原子写：临时文件 + rename）。 */
  async remember(key: string, taskId: string): Promise<void> {
    await this.init();
    const record: IdempotencyRecord = {
      key_hash: this.hashOf(key),
      task_id: taskId,
      created_at: this.now(),
    };
    const path = this.pathFor(key);
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(record), 'utf8');
    await rename(tmp, path);
  }

  async forget(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  /** 清理过期索引文件，返回删除数量。 */
  async prune(): Promise<number> {
    if (this.ttlMs <= 0) return 0;
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const file of files) {
      if (!file.startsWith('idem-') || !file.endsWith('.json')) continue;
      const full = join(this.dir, file);
      try {
        const info = await stat(full);
        if (this.now() - info.mtimeMs > this.ttlMs) {
          await rm(full, { force: true });
          removed += 1;
        }
      } catch {
        // 单个文件清理失败不影响其它文件
      }
    }
    return removed;
  }
}
