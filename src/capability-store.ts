import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type CachedPermissionMode = 'read-only' | 'workspace-write' | 'danger-full-access';

interface CapabilityEntry {
  mode: CachedPermissionMode;
  reason?: string;
  updatedAt: number;
}

interface FileShape {
  version: 1;
  entries: Record<string, CapabilityEntry>;
}

/**
 * cwd 能力缓存：记住某个目录实际可用的沙箱模式，跨 worker 进程持久化。
 * 目的：同一目录不要每次新线程都先撞一次 ACL 再降级；auto 模式据此直接选模式。
 */
export class CwdCapabilityStore {
  private entries = new Map<string, CapabilityEntry>();
  private writeChain: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(
    private readonly file: string,
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async init(): Promise<void> {
    this.initialized = true;
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as FileShape;
      const cutoff = this.now() - this.ttlMs;
      for (const [cwd, entry] of Object.entries(raw.entries ?? {})) {
        if (entry && typeof entry.mode === 'string' && entry.updatedAt >= cutoff) {
          this.entries.set(normalizeCwd(cwd), entry);
        }
      }
    } catch {
      // 文件不存在/损坏：从空缓存开始
    }
  }

  get(cwd: string): CapabilityEntry | null {
    const entry = this.entries.get(normalizeCwd(cwd));
    if (!entry) return null;
    if (entry.updatedAt < this.now() - this.ttlMs) {
      this.entries.delete(normalizeCwd(cwd));
      return null;
    }
    return entry;
  }

  async set(cwd: string, mode: CachedPermissionMode, reason?: string): Promise<void> {
    this.entries.set(normalizeCwd(cwd), {
      mode,
      ...(reason ? { reason: reason.slice(0, 300) } : {}),
      updatedAt: this.now(),
    });
    await this.persist();
  }

  async persist(): Promise<void> {
    if (!this.initialized) return;
    this.writeChain = this.writeChain.then(async () => {
      const shape: FileShape = { version: 1, entries: Object.fromEntries(this.entries) };
      const tmp = `${this.file}.tmp`;
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(tmp, JSON.stringify(shape, null, 2), 'utf8');
      await rename(tmp, this.file);
    });
    await this.writeChain.catch(() => undefined);
  }

  async dispose(): Promise<void> {
    await this.writeChain.catch(() => undefined);
  }
}

export function normalizeCwd(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
