import { describe, expect, it } from 'vitest';
import { TaskManager } from '../src/task-manager.js';
import type { RunOutcome } from '../src/types.js';
import { MemoryStore, makeRunOutcome, makeTestConfig, waitFor } from './helpers.js';

/** 发两个 tool_call、一条 text、一条带 usage 的 step_end，然后失败结束。 */
function makeObservableRunner(outcome: RunOutcome) {
  return (input: Parameters<Parameters<typeof TaskManager>[0]['runner']>[0]) => {
    let resolve!: (value: RunOutcome) => void;
    const promise = new Promise<RunOutcome>((r) => {
      resolve = r;
    });
    setTimeout(() => {
      input.onEvent({ type: 'tool_call', tool: 'read' });
      input.onEvent({ type: 'tool_result', message: { role: 'tool', isError: false } });
      input.onEvent({ type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } });
      input.onEvent({ type: 'tool_call', tool: 'edit' });
      input.onEvent({ type: 'text', text: '阶段性成果：已定位到问题文件' });
      input.onEvent({ type: 'status', phase: 'step_end', turn: 1, step: 2, usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 } });
      resolve(outcome);
    }, 5);
    return { pid: 1, cancel: () => resolve(makeRunOutcome({ cancelled: true })), outcome: promise };
  };
}

describe('可观测性：status / result 字段', () => {
  it('status 返回实时 tokens/steps/tool_calls；失败结果带 partial_output 与 failure_kind', async () => {
    const manager = new TaskManager({
      runner: makeObservableRunner(makeRunOutcome({ exitCode: 1, errorMessage: 'SDK 后端已被终止' })),
      store: new MemoryStore(),
      config: makeTestConfig({ cleanupIntervalMs: 0 }),
    });
    await manager.init();
    const record = await manager.create({ task: 'observability', cwd: 'C:\\proj' });
    await waitFor(() => manager.get(record.id)?.status === 'failed');

    const status = await manager.status(record.id);
    expect(status.steps).toBe(2);
    expect(status.tool_calls).toBe(2);
    expect(status.tokens).toMatchObject({ inputTokens: 150, outputTokens: 30, totalTokens: 180 });

    const result = await manager.result(record.id);
    expect(result.status).toBe('failed');
    expect(result.partial_output).toBe('阶段性成果：已定位到问题文件');
    expect(result.failure_kind).toBe('backend_crash');
    expect(result.usage.tool_calls).toBe(2);
    manager.stop();
  });

  it('超出 token 预算时自动取消并标记 failed', async () => {
    const runner = (input: Parameters<Parameters<typeof TaskManager>[0]['runner']>[0]) => {
      let resolve!: (value: RunOutcome) => void;
      const promise = new Promise<RunOutcome>((r) => {
        resolve = r;
      });
      setTimeout(() => {
        input.onEvent({ type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 } });
      }, 5);
      return { pid: 1, cancel: () => resolve(makeRunOutcome({ cancelled: true })), outcome: promise };
    };
    const manager = new TaskManager({
      runner,
      store: new MemoryStore(),
      config: makeTestConfig({ cleanupIntervalMs: 0, maxTaskTokens: 1000 }),
    });
    await manager.init();
    const record = await manager.create({ task: 'token-budget', cwd: 'C:\\proj' });
    await waitFor(() => manager.get(record.id)?.status === 'failed');
    const result = await manager.result(record.id);
    expect(result.error).toContain('token_budget_exceeded');
    expect(result.failure_kind).toBe('token_budget');
    expect((manager.get(record.id)?.events ?? []).some((event) => event.type === 'status' && event.phase === 'token_budget_exceeded')).toBe(
      true,
    );
    manager.stop();
  });
});
