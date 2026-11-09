import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BatchManager } from '../src/batch-manager.js';
import { TaskManager, type TaskRunner } from '../src/task-manager.js';
import type { RunOutcome } from '../src/types.js';
import { MemoryStore, makeFakeRunner, makeRunOutcome, makeTestConfig, waitFor } from './helpers.js';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await Promise.resolve(fn()).catch(() => undefined);
});

async function setup(options: { maxBatchTasks?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'batch-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const config = makeTestConfig({ cleanupIntervalMs: 0 });
  const fake = makeFakeRunner({ delayMs: 5, finalText: 'done' });
  const manager = new TaskManager({ runner: fake.runner, store: new MemoryStore(), config });
  await manager.init();
  cleanups.push(() => manager.stop());
  cleanups.push(() => manager.abortAll());
  const batches = new BatchManager(manager, dir, options.maxBatchTasks ?? 8);
  await batches.init();
  return { manager, batches };
}

describe('BatchManager', () => {
  it('批量创建 → 聚合状态 → 聚合结果', async () => {
    const { manager, batches } = await setup();
    const batch = await batches.create([
      { task: 'a', cwd: 'C:\\proj' },
      { task: 'b', cwd: 'C:\\proj' },
    ]);
    expect(batch.taskIds).toHaveLength(2);

    await waitFor(() => {
      const statuses = batch.taskIds.map((id) => manager.get(id)?.status);
      return statuses.every((status) => status === 'succeeded');
    });
    const status = await batches.status(batch.id);
    expect(status.status).toBe('completed');
    expect(status.counts.succeeded).toBe(2);

    const result = await batches.result(batch.id);
    expect(result.results.map((item) => item.output)).toEqual(['done', 'done']);
    expect(result.results.every((item) => item.status === 'succeeded')).toBe(true);
  });

  it('超过 maxBatchTasks 时拒绝', async () => {
    const { batches } = await setup({ maxBatchTasks: 1 });
    await expect(
      batches.create([
        { task: 'a', cwd: 'C:\\proj' },
        { task: 'b', cwd: 'C:\\proj' },
      ]),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('混合结果聚合为 partial_failed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'batch-mixed-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    const config = makeTestConfig({ cleanupIntervalMs: 0 });
    const runner: TaskRunner = (input) => {
      let resolveOutcome!: (outcome: RunOutcome) => void;
      const outcome = new Promise<RunOutcome>((resolve) => {
        resolveOutcome = resolve;
      });
      setTimeout(() => {
        if (input.task.includes('fail')) {
          input.onEvent({ type: 'error', message: 'boom' });
          resolveOutcome(makeRunOutcome({ exitCode: 1, finalText: null, errorMessage: 'boom' }));
          return;
        }
        input.onEvent({ type: 'final', text: 'ok' });
        resolveOutcome(makeRunOutcome({ finalText: 'ok' }));
      }, 5);
      return { pid: 1, cancel: () => resolveOutcome(makeRunOutcome({ cancelled: true })), outcome };
    };
    const manager = new TaskManager({ runner, store: new MemoryStore(), config });
    await manager.init();
    cleanups.push(() => manager.stop());
    const batches = new BatchManager(manager, dir, 8);
    await batches.init();

    const batch = await batches.create([
      { task: 'ok-task', cwd: 'C:\\a' },
      { task: 'fail-task', cwd: 'C:\\b' },
    ]);
    await waitFor(() => batch.taskIds.every((id) => ['succeeded', 'failed', 'cancelled'].includes(manager.get(id)?.status ?? '')));
    const status = await batches.status(batch.id);
    expect(status.status).toBe('partial_failed');
    expect(status.counts).toMatchObject({ succeeded: 1, failed: 1 });
  });
});
