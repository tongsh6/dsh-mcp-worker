import { describe, expect, it } from 'vitest';
import { TaskManager } from '../src/task-manager.js';
import type { RunOutcome } from '../src/types.js';
import { MemoryStore, makeTestConfig, makeRunOutcome, waitFor } from './helpers.js';

/** 假 runner：发两个带 usage 的 step_end，再成功结束。 */
function makeUsageRunner() {
  return (input: Parameters<Parameters<typeof TaskManager>[0]['runner']>[0]) => {
    let resolve!: (outcome: RunOutcome) => void;
    const outcome = new Promise<RunOutcome>((r) => {
      resolve = r;
    });
    setTimeout(() => {
      input.onEvent({
        type: 'status',
        phase: 'step_end',
        turn: 1,
        step: 1,
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, totalTokens: 120 },
      });
      input.onEvent({
        type: 'status',
        phase: 'step_end',
        turn: 1,
        step: 2,
        usage: { inputTokens: 50, outputTokens: 10, cacheWriteTokens: 5, totalTokens: 60 },
      });
      input.onEvent({ type: 'final', text: 'done' });
      resolve(makeRunOutcome({ finalText: 'done' }));
    }, 5);
    return { pid: 1, cancel: () => resolve(makeRunOutcome({ cancelled: true })), outcome };
  };
}

describe('TaskManager token 计量', () => {
  it('累加事件 usage 并写入 dsh_result.usage.tokens', async () => {
    const config = makeTestConfig({ cleanupIntervalMs: 0 });
    const manager = new TaskManager({ runner: makeUsageRunner(), store: new MemoryStore(), config });
    await manager.init();
    const record = await manager.create({ task: 'usage', cwd: 'C:\\proj' });
    await waitFor(() => manager.get(record.id)?.status === 'succeeded');
    const result = await manager.result(record.id);
    expect(result.usage.tokens).toEqual({
      inputTokens: 150,
      outputTokens: 30,
      cacheReadTokens: 30,
      cacheWriteTokens: 5,
      reasoningTokens: 0,
      totalTokens: 180,
    });
    manager.stop();
  });
});
