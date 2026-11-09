import { describe, expect, it } from 'vitest';
import { TaskManager } from '../src/task-manager.js';
import type { TaskRecord } from '../src/types.js';
import { MemoryStore, makeFakeRunner, makeTestConfig, waitFor } from './helpers.js';

function makeManager(options: {
  store?: MemoryStore;
  fake?: ReturnType<typeof makeFakeRunner>;
  maxConcurrent?: number;
} = {}) {
  const store = options.store ?? new MemoryStore();
  const fake = options.fake ?? makeFakeRunner({ delayMs: 10, finalText: 'done' });
  const manager = new TaskManager({
    runner: fake.runner,
    store,
    config: makeTestConfig({ maxConcurrent: options.maxConcurrent ?? 2 }),
  });
  return { manager, store, fake };
}

function isTerminal(record: TaskRecord | undefined): boolean {
  return !!record && ['succeeded', 'failed', 'cancelled'].includes(record.status);
}

describe('TaskManager', () => {
  it('创建任务后异步执行，最终 succeeded 且能取到结果', async () => {
    const { manager } = makeManager();
    await manager.init();
    const record = await manager.create({ task: 'do it', cwd: 'C:\\proj' });
    expect(record.status).toBe('queued');
    await waitFor(() => isTerminal(manager.get(record.id)));
    const result = await manager.result(record.id);
    expect(result.status).toBe('succeeded');
    expect(result.output).toBe('done');
    expect(result.events_count).toBeGreaterThan(0);
  });

  it('runner 失败时任务标记 failed 并保留错误', async () => {
    const fake = makeFakeRunner({ delayMs: 5, fail: true });
    const { manager } = makeManager({ fake });
    await manager.init();
    const record = await manager.create({ task: 'fail', cwd: 'C:\\proj' });
    await waitFor(() => isTerminal(manager.get(record.id)));
    const result = await manager.result(record.id);
    expect(result.status).toBe('failed');
    expect(result.output).toBeNull();
    expect(result.error).toContain('fake failure');
  });

  it('status 使用 cursor 做增量返回', async () => {
    const { manager } = makeManager();
    await manager.init();
    const record = await manager.create({ task: 'x', cwd: 'C:\\proj' });
    await waitFor(() => isTerminal(manager.get(record.id)));
    const first = await manager.status(record.id, { cursor: 0 });
    expect(first.events.length).toBeGreaterThan(0);
    const second = await manager.status(record.id, { cursor: first.next_cursor });
    expect(second.events).toHaveLength(0);
    expect(second.next_cursor).toBe(first.next_cursor);
  });

  it('status 长轮询会等到新事件', async () => {
    const fake = makeFakeRunner({ delayMs: 120, finalText: 'slow' });
    const { manager } = makeManager({ fake });
    await manager.init();
    const record = await manager.create({ task: 'slow', cwd: 'C:\\proj' });
    await waitFor(() => manager.get(record.id)?.status === 'running');
    const started = Date.now();
    const payload = await manager.status(record.id, { waitMs: 2_000 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(payload.events.length).toBeGreaterThan(0);
  });

  it('取消运行中的任务', async () => {
    const fake = makeFakeRunner({ delayMs: 5_000 });
    const { manager } = makeManager({ fake });
    await manager.init();
    const record = await manager.create({ task: 'hang', cwd: 'C:\\proj' });
    await waitFor(() => manager.get(record.id)?.status === 'running');
    const cancelled = await manager.cancel(record.id);
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.status).toBe('cancelled');
    expect(fake.cancelCount()).toBe(1);
  });

  it('并发上限生效：第二个任务在第一个结束前不会开始', async () => {
    const fake = makeFakeRunner({ delayMs: 80 });
    const { manager } = makeManager({ fake, maxConcurrent: 1 });
    await manager.init();
    const first = await manager.create({ task: 'a', cwd: 'C:\\proj' });
    const second = await manager.create({ task: 'b', cwd: 'C:\\proj' });
    await waitFor(() => isTerminal(manager.get(first.id)) && isTerminal(manager.get(second.id)));
    const firstRecord = manager.get(first.id)!;
    const secondRecord = manager.get(second.id)!;
    expect(secondRecord.startedAt ?? 0).toBeGreaterThanOrEqual(firstRecord.endedAt ?? 0);
  });

  it('同一 session 串行执行，不同 session 并行', async () => {
    const fake = makeFakeRunner({ delayMs: 60 });
    const { manager } = makeManager({ fake, maxConcurrent: 4 });
    await manager.init();
    const a1 = await manager.create({ task: 'a1', cwd: 'C:\\proj', sessionId: 's1' });
    const a2 = await manager.create({ task: 'a2', cwd: 'C:\\proj', sessionId: 's1' });
    const b1 = await manager.create({ task: 'b1', cwd: 'C:\\proj', sessionId: 's2' });
    await waitFor(() => isTerminal(manager.get(a1.id)) && isTerminal(manager.get(a2.id)) && isTerminal(manager.get(b1.id)));
    const rec1 = manager.get(a1.id)!;
    const rec2 = manager.get(a2.id)!;
    expect(rec2.startedAt ?? 0).toBeGreaterThanOrEqual(rec1.endedAt ?? 0);
    // 不同 session 应产生并发（b1 在 a1 结束前已开始）
    expect(manager.get(b1.id)!.startedAt ?? 0).toBeLessThan(rec1.endedAt ?? 0);
  });

  it('重启恢复：未完成任务被标记为 failed(interrupted)', async () => {
    const store = new MemoryStore();
    const stale: TaskRecord = {
      id: 'stale-1',
      status: 'running',
      task: 'old',
      cwd: 'C:\\proj',
      permissionMode: 'workspace-write',
      createdAt: Date.now() - 1_000,
      events: [],
      timedOut: false,
    };
    await store.saveMeta(stale);
    const { manager } = makeManager({ store });
    await manager.init();
    const recovered = manager.get('stale-1')!;
    expect(recovered.status).toBe('failed');
    expect(recovered.error).toContain('interrupted');
  });

  it('未完成任务调用 result 返回 task_not_finished', async () => {
    const fake = makeFakeRunner({ delayMs: 5_000 });
    const { manager } = makeManager({ fake });
    await manager.init();
    const record = await manager.create({ task: 'hang', cwd: 'C:\\proj' });
    await expect(manager.result(record.id)).rejects.toMatchObject({ code: 'task_not_finished' });
    await manager.cancel(record.id);
  });

  it('事件持久化到 store', async () => {
    const { manager, store } = makeManager();
    await manager.init();
    const record = await manager.create({ task: 'x', cwd: 'C:\\proj' });
    await waitFor(() => isTerminal(manager.get(record.id)));
    const persisted = store.records.get(record.id);
    expect(persisted?.events.length).toBeGreaterThan(0);
  });
});
