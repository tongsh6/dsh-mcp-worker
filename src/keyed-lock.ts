/**
 * 按 key 串行执行的锁：同一 key 的任务排队，不同 key 并行。
 * 用于「同一 DSH session 只能单写者」的约束。
 */
export class KeyedLock {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly pending = new Map<string, number>();

  runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    this.pending.set(key, (this.pending.get(key) ?? 0) + 1);
    const previous = this.chains.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    // 在结果 promise 内部释放计数，保证「await 到结果时锁已释放」
    const result = run.then(
      (value) => {
        this.release(key);
        return value;
      },
      (error: unknown) => {
        this.release(key);
        throw error;
      },
    );
    const gate: Promise<void> = result.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, gate);
    void gate.then(() => {
      if (this.chains.get(key) === gate) this.chains.delete(key);
    });
    return result;
  }

  isBusy(key: string): boolean {
    return this.pending.has(key);
  }

  busyKeys(): string[] {
    return [...this.pending.keys()];
  }

  private release(key: string): void {
    const next = (this.pending.get(key) ?? 1) - 1;
    if (next <= 0) {
      this.pending.delete(key);
      return;
    }
    this.pending.set(key, next);
  }
}
