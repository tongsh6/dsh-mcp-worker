import { describe, expect, it } from 'vitest';
import { createFallbackRunner } from '../src/fallback-runner.js';
import type { TaskRunInput } from '../src/task-manager.js';
import type { RunOutcome } from '../src/types.js';
import { makeRunOutcome } from './helpers.js';

function fakeRunner(behavior: (input: TaskRunInput) => RunOutcome, tag: string) {
  const calls: string[] = [];
  const runner = (input: TaskRunInput) => {
    calls.push(tag);
    let resolve!: (outcome: RunOutcome) => void;
    const outcome = new Promise<RunOutcome>((r) => {
      resolve = r;
    });
    setTimeout(() => {
      const value = behavior(input);
      if (value.finalText) input.onEvent({ type: 'final', text: value.finalText });
      resolve(value);
    }, 5);
    return { pid: 1, cancel: () => resolve(makeRunOutcome({ cancelled: true })), outcome };
  };
  return { runner, calls };
}

const input: TaskRunInput = {
  id: 'task-1',
  task: 'do work',
  cwd: 'C:\\proj',
  permissionMode: 'workspace-write',
  timeoutMs: 5_000,
  onEvent: () => undefined,
};

describe('FallbackRunner', () => {
  it('primary 报 SDK 初始化失败时自动用 fallback 重跑', async () => {
    const primary = fakeRunner(
      () => makeRunOutcome({ exitCode: 1, finalText: null, errorMessage: 'SDK 后端启动失败（已尝试 2 次）：JSON-RPC 请求超时（300000ms）：initialize' }),
      'primary',
    );
    const fallback = fakeRunner(() => makeRunOutcome({ exitCode: 0, finalText: 'fallback-done' }), 'fallback');
    const run = createFallbackRunner({ primary: primary.runner, fallback: fallback.runner });
    const outcome = await run(input).outcome;
    expect(primary.calls).toEqual(['primary']);
    expect(fallback.calls).toEqual(['fallback']);
    expect(outcome.finalText).toBe('fallback-done');
    expect(outcome.events.some((event) => event.type === 'status' && event.phase === 'fallback')).toBe(true);
  });

  it('普通业务失败不触发 fallback', async () => {
    const primary = fakeRunner(
      () => makeRunOutcome({ exitCode: 1, finalText: null, errorMessage: 'tests failed: 3 failing' }),
      'primary',
    );
    const fallback = fakeRunner(() => makeRunOutcome({ exitCode: 0, finalText: 'should-not-run' }), 'fallback');
    const run = createFallbackRunner({ primary: primary.runner, fallback: fallback.runner });
    const outcome = await run(input).outcome;
    expect(fallback.calls).toEqual([]);
    expect(outcome.errorMessage).toContain('tests failed');
  });

  it('fallback 也失败时返回 fallback 的结果', async () => {
    const primary = fakeRunner(() => makeRunOutcome({ exitCode: 1, errorMessage: 'initialize timeout' }), 'primary');
    const fallback = fakeRunner(() => makeRunOutcome({ exitCode: 1, errorMessage: 'headless also failed' }), 'fallback');
    const run = createFallbackRunner({ primary: primary.runner, fallback: fallback.runner });
    const outcome = await run(input).outcome;
    expect(outcome.errorMessage).toBe('headless also failed');
  });
});
