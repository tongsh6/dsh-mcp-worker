import { describe, expect, it } from 'vitest';
import { TaskManager } from '../src/task-manager.js';
import type { RunOutcome } from '../src/types.js';
import { MemoryStore, makeRunOutcome, makeTestConfig, waitFor } from './helpers.js';

function makeSequenceRunner(outcomes: RunOutcome[]) {
  const calls: Array<{ permissionMode: string; attempt?: number }> = [];
  const runner = (input: Parameters<Parameters<typeof TaskManager>[0]['runner']>[0]) => {
    calls.push({ permissionMode: input.permissionMode, attempt: input.attempt });
    let resolve!: (outcome: RunOutcome) => void;
    const outcome = new Promise<RunOutcome>((r) => {
      resolve = r;
    });
    const next = outcomes[Math.min(calls.length - 1, outcomes.length - 1)];
    setTimeout(() => {
      input.onEvent({ type: 'text', text: 'progress' });
      resolve(makeRunOutcome(next));
    }, 5);
    return { pid: 1, cancel: () => resolve(makeRunOutcome({ cancelled: true })), outcome };
  };
  return { runner, calls };
}

describe('C3 瞬态失败自动重试 / B3 失败诊断', () => {
  it('backend_crash 失败后自动重试一次并成功', async () => {
    const { runner, calls } = makeSequenceRunner([
      makeRunOutcome({ exitCode: 1, errorMessage: 'SDK 后端已被终止' }),
      makeRunOutcome({ exitCode: 0, finalText: 'retry-ok' }),
    ]);
    const manager = new TaskManager({
      runner,
      store: new MemoryStore(),
      config: makeTestConfig({ cleanupIntervalMs: 0, retryTransient: true }),
    });
    await manager.init();
    const record = await manager.create({ task: 'retry', cwd: 'C:\\proj' });
    await waitFor(() => manager.get(record.id)?.status === 'succeeded');
    const result = await manager.result(record.id);
    expect(calls).toHaveLength(2);
    expect(result.output).toBe('retry-ok');
    expect(result.retries).toBe(1);
    const events = manager.get(record.id)?.events ?? [];
    expect(events.some((event) => event.type === 'status' && event.phase === 'transient_retry')).toBe(true);
    manager.stop();
  });

  it('失败时返回 diagnosis（kind/stage/suggestion）', async () => {
    const manager = new TaskManager({
      runner: makeSequenceRunner([makeRunOutcome({ exitCode: 1, errorMessage: 'SDK 后端已被终止' })]).runner,
      store: new MemoryStore(),
      config: makeTestConfig({ cleanupIntervalMs: 0, retryTransient: false }),
    });
    await manager.init();
    const record = await manager.create({ task: 'diag', cwd: 'C:\\proj' });
    await waitFor(() => manager.get(record.id)?.status === 'failed');
    const result = await manager.result(record.id);
    expect(result.diagnosis).toMatchObject({ kind: 'backend_crash' });
    expect(result.diagnosis?.suggestion.length).toBeGreaterThan(0);
    expect(result.diagnosis?.stage).toBeTruthy();
    manager.stop();
  });
});
