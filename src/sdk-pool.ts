import { SdkBackend, type SdkBackendOptions } from './sdk-backend.js';

export interface SdkPoolOptions {
  spawn: { command: string; args: string[]; shell?: boolean };
  profile: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
  maxTokens?: number;
  idleMs: number;
  initTimeoutMs: number;
  /** 空闲扫描间隔（毫秒）；测试可调小，默认 30–60s。 */
  sweepIntervalMs?: number;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

interface PoolEntry {
  promise: Promise<SdkBackend>;
  backend?: SdkBackend;
}

/**
 * 按 cwd 缓存长驻 SDK 后端：同一项目目录复用同一个 `dsh --profile sdk` 进程。
 * 空闲超过 idleMs 自动回收；进程异常退出后自动从池中移除，下次任务重建。
 */
export class SdkBackendPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly sweeper: NodeJS.Timeout;
  private readonly now: () => number;

  constructor(private readonly options: SdkPoolOptions) {
    this.now = options.now ?? (() => Date.now());
    const interval = options.sweepIntervalMs ?? Math.max(30_000, Math.min(60_000, options.idleMs));
    this.sweeper = setInterval(() => this.sweep(), interval);
    this.sweeper.unref?.();
  }

  async acquire(cwd: string, permissionMode?: string): Promise<SdkBackend> {
    const key = `${normalizeCwd(cwd)}|${permissionMode ?? 'default'}`;
    const existing = this.entries.get(key);
    if (existing) {
      const backend = await existing.promise.catch(() => undefined);
      if (backend && !backend.isClosed) return backend;
      if (this.entries.get(key) === existing) this.entries.delete(key);
    }

    const entry: PoolEntry = { promise: SdkBackend.start(this.backendOptions(cwd, permissionMode)) };
    this.entries.set(key, entry);
    try {
      const backend = await entry.promise;
      entry.backend = backend;
      backend.onExit(() => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      });
      return backend;
    } catch (error) {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    }
  }

  /** 杀掉某个后端（取消任务时用），并把它从池中移除。 */
  kill(backend: SdkBackend): void {
    backend.cancel();
    for (const [key, entry] of this.entries) {
      if (entry.backend === backend) this.entries.delete(key);
    }
  }

  async shutdown(): Promise<void> {
    clearInterval(this.sweeper);
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(
      entries.map(async (entry) => {
        const backend = await entry.promise.catch(() => undefined);
        if (backend) await backend.shutdown();
      }),
    );
  }

  stats(): { active: number; idleMs: number } {
    let active = 0;
    for (const entry of this.entries.values()) {
      if (entry.backend && !entry.backend.isClosed) active += 1;
    }
    return { active, idleMs: this.options.idleMs };
  }

  private backendOptions(cwd: string, permissionMode?: string): SdkBackendOptions {
    return {
      spawn: this.options.spawn,
      profile: this.options.profile,
      cwd,
      provider: this.options.provider,
      model: this.options.model,
      ...(this.options.reasoningEffort ? { reasoningEffort: this.options.reasoningEffort } : {}),
      ...(this.options.maxTokens ? { maxTokens: this.options.maxTokens } : {}),
      initTimeoutMs: this.options.initTimeoutMs,
      env: {
        ...this.options.env,
        ...(permissionMode ? { DSH_PERMISSION_MODE: permissionMode } : {}),
      },
    };
  }

  private sweep(): void {
    for (const [key, entry] of this.entries) {
      const backend = entry.backend;
      if (!backend) continue;
      if (backend.isClosed) {
        this.entries.delete(key);
        continue;
      }
      // 正在执行 prompt 的后端不能被空闲回收，否则长任务会被杀掉（真实 11 分钟任务被 10min idle 误杀）
      if (backend.busy) continue;
      if (this.now() - backend.lastUsedAt > this.options.idleMs) {
        this.entries.delete(key);
        void backend.shutdown();
      }
    }
  }
}

function normalizeCwd(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
