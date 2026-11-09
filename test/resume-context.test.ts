import { describe, expect, it } from 'vitest';
import { TaskManager } from '../src/task-manager.js';
import type { RunOutcome } from '../src/types.js';
import { MemoryStore, makeRunOutcome, makeTestConfig, waitFor } from './helpers.js';

/** 捕获 runner 收到的 resumeContext；模拟一次带 session 事件的完成。 */
function makeContextRunner(captured: Array<string | undefined>) {
  return (input: Parameters<Parameters<typeof TaskManager>[0]['runner']>[0]) => {
    captured.push(input.resumeContext);
    let resolve!: (outcome: RunOutcome) => void;
    const outcome = new Promise<RunOutcome>((r) => {
      resolve = r;
    });
    setTimeout(() => {
      input.onEvent({ type: 'session', sessionId: input.sessionId ?? `mcp-${input.id}`, cwd: input.cwd });
      input.onEvent({ type: 'final', text: 'done-shell' });
      resolve(makeRunOutcome({ finalText: 'done-shell' }));
    }, 5);
    return { pid: 1, cancel: () => resolve(makeRunOutcome({ cancelled: true })), outcome };
  };
}

describe('续聊上下文恢复', () => {
  it('同 session 的新任务会带上上一轮任务/结果摘要', async () => {
    const captured: Array<string | undefined> = [];
    const manager = new TaskManager({
      runner: makeContextRunner(captured),
      store: new MemoryStore(),
      config: makeTestConfig({ cleanupIntervalMs: 0 }),
    });
    await manager.init();
    const first = await manager.create({ task: 'original-task', cwd: 'C:\\proj', sessionId: 'sess-1' });
    await waitFor(() => manager.get(first.id)?.status === 'succeeded');
    const second = await manager.create({ task: 'continue-task', cwd: 'C:\\proj', sessionId: 'sess-1' });
    await waitFor(() => manager.get(second.id)?.status === 'succeeded');
    expect(captured[0]).toBeUndefined();
    expect(captured[1]).toContain('续聊上下文');
    expect(captured[1]).toContain('original-task');
    expect(captured[1]).toContain('done-shell');
    manager.stop();
  });
});
