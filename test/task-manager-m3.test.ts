import { describe, expect, it } from 'vitest';
import { TaskManager } from '../src/task-manager.js';
import type { AuditEntry, TaskRecord } from '../src/types.js';
import { MemoryStore, makeFakeRunner, makeTestConfig, waitFor } from './helpers.js';

function isTerminal(record: TaskRecord | undefined): boolean {
  return !!record && ['succeeded', 'failed', 'cancelled'].includes(record.status);
}

async function waitTerminal(manager: TaskManager, taskId: string): Promise<void> {
  await waitFor(() => isTerminal(manager.get(taskId)));
}

function makeManager(options: {
  config?: Parameters<typeof makeTestConfig>[0];
  delayMs?: number;
  finalText?: string;
  now?: () => number;
  audit?: AuditEntry[];
  store?: MemoryStore;
} = {}) {
  const store = options.store ?? new MemoryStore();
  const fake = makeFakeRunner({ delayMs: options.delayMs ?? 5, finalText: options.finalText ?? 'done' });
  const config = makeTestConfig({ cleanupIntervalMs: 0, ...options.config });
  const audit: AuditEntry[] = options.audit ?? [];
  const manager = new TaskManager({
    runner: fake.runner,
    store,
    config,
    ...(options.now ? { now: options.now } : {}),
    audit: (entry) => audit.push(entry),
  });
  return { manager, fake, store, config, audit };
}

describe('TaskManager M3：TTL 清理', () => {
  it('过期任务被 sweep 移除（内存 + 落盘）', async () => {
    let now = 1_000_000;
    const { manager, store } = makeManager({ config: { taskTtlMs: 1_000 }, now: () => now });
    await manager.init();
    const record = await manager.create({ task: 'old', cwd: 'C:\\proj' });
    await waitTerminal(manager, record.id);

    now += 5_000;
    const { removed } = manager.sweep();
    expect(removed).toContain(record.id);
    expect(manager.get(record.id)).toBeUndefined();
    expect(store.records.has(record.id)).toBe(false);
  });

  it('未过期任务不会被清理', async () => {
    let now = 1_000_000;
    const { manager } = makeManager({ config: { taskTtlMs: 60_000 }, now: () => now });
    await manager.init();
    const record = await manager.create({ task: 'fresh', cwd: 'C:\\proj' });
    await waitTerminal(manager, record.id);
    now += 5_000;
    expect(manager.sweep().removed).toEqual([]);
    expect(manager.get(record.id)).toBeDefined();
  });
});

describe('TaskManager M3：任务数上限', () => {
  it('超出上限时先淘汰最老的已结束任务', async () => {
    const { manager } = makeManager({ config: { maxTasks: 2, taskTtlMs: 24 * 3600 * 1000 } });
    await manager.init();
    const first = await manager.create({ task: 'a', cwd: 'C:\\p' });
    await waitTerminal(manager, first.id);
    const second = await manager.create({ task: 'b', cwd: 'C:\\p' });
    await waitTerminal(manager, second.id);
    const third = await manager.create({ task: 'c', cwd: 'C:\\p' });
    await waitTerminal(manager, third.id);

    const ids = manager.list().map((record) => record.id);
    expect(ids).toHaveLength(2);
    expect(ids).not.toContain(first.id);
    expect(ids).toContain(third.id);
  });

  it('全部是未结束任务时拒绝新任务（quota_exceeded）', async () => {
    const { manager } = makeManager({ config: { maxTasks: 2, maxConcurrent: 1 }, delayMs: 5_000 });
    await manager.init();
    await manager.create({ task: 'running', cwd: 'C:\\p' });
    await manager.create({ task: 'queued', cwd: 'C:\\p' });
    await expect(manager.create({ task: 'third', cwd: 'C:\\p' })).rejects.toMatchObject({ code: 'quota_exceeded' });
    manager.abortAll();
  });
});

describe('TaskManager M3：每 cwd 并发配额', () => {
  it('同一 cwd 超出配额时排队并给出 queued_reason=concurrency', async () => {
    const { manager } = makeManager({ delayMs: 120, config: { maxConcurrent: 4, maxConcurrentPerCwd: 1 } });
    await manager.init();
    const first = await manager.create({ task: 'a', cwd: 'C:\\proj-a' });
    const second = await manager.create({ task: 'b', cwd: 'C:\\proj-a' });
    const other = await manager.create({ task: 'c', cwd: 'C:\\proj-b' });

    await waitFor(() => manager.get(first.id)?.status === 'running');
    const queuedStatus = await manager.status(second.id);
    expect(queuedStatus.status).toBe('queued');
    expect(queuedStatus.queued_reason).toBe('concurrency');

    await waitTerminal(manager, first.id);
    await waitTerminal(manager, second.id);
    await waitTerminal(manager, other.id);
  });

  it('同 session 排队给出 queued_reason=session', async () => {
    const { manager } = makeManager({ delayMs: 120, config: { maxConcurrent: 4, maxConcurrentPerCwd: 4 } });
    await manager.init();
    const first = await manager.create({ task: 'a', cwd: 'C:\\proj', sessionId: 's1' });
    const second = await manager.create({ task: 'b', cwd: 'C:\\proj', sessionId: 's1' });
    await waitFor(() => manager.get(first.id)?.status === 'running');
    const queuedStatus = await manager.status(second.id);
    expect(queuedStatus.queued_reason).toBe('session');
    await waitTerminal(manager, first.id);
    await waitTerminal(manager, second.id);
  });
});

describe('TaskManager M3：审计', () => {
  it('任务生命周期产生审计事件', async () => {
    const audit: AuditEntry[] = [];
    const { manager, audit: sink } = makeManager({ audit });
    await manager.init();
    const record = await manager.create({ task: 'audited', cwd: 'C:\\proj' });
    await waitTerminal(manager, record.id);
    const events = sink.map((entry) => entry.event);
    expect(events).toContain('task_created');
    expect(events).toContain('task_started');
    expect(events).toContain('task_succeeded');
    expect(sink.find((entry) => entry.event === 'task_created')?.task_id).toBe(record.id);
  });
});
