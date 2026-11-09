import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { startDshRun } from '../src/dsh-runner.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-dsh.js', import.meta.url));
const SPAWN = { command: process.execPath, args: [FIXTURE] };

describe('startDshRun（用假 DSH fixture）', () => {
  it('成功任务：读取 final、sessionId、事件与退出码', async () => {
    const handle = startDshRun({
      task: 'hello',
      cwd: process.cwd(),
      timeoutMs: 5_000,
      spawn: SPAWN,
      profile: 'headless',
      onEvent: () => {},
    });
    const outcome = await handle.outcome;
    expect(outcome.exitCode).toBe(0);
    expect(outcome.finalText).toBe('ok:hello');
    expect(outcome.sessionId).toBe('sess-fake');
    expect(outcome.stderrTail).toContain('[fake-dsh]');
    expect(outcome.events.some((e) => e.type === 'final')).toBe(true);
  });

  it('失败任务：捕获 error 事件、退出码 1，stderr 保留诊断', async () => {
    const outcome = await startDshRun({
      task: 'FAIL',
      cwd: process.cwd(),
      timeoutMs: 5_000,
      spawn: SPAWN,
      profile: 'headless',
      onEvent: () => {},
    }).outcome;
    expect(outcome.exitCode).toBe(1);
    expect(outcome.errorMessage).toBe('simulated failure');
    expect(outcome.finalText).toBeNull();
    expect(outcome.stderrTail).toContain('simulated failure');
  });

  it('超时：杀掉进程并标记 timedOut', async () => {
    const started = Date.now();
    const outcome = await startDshRun({
      task: 'HANG',
      cwd: process.cwd(),
      timeoutMs: 300,
      spawn: SPAWN,
      profile: 'headless',
      onEvent: () => {},
    }).outcome;
    expect(outcome.timedOut).toBe(true);
    expect(outcome.cancelled).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('主动取消：标记 cancelled 并尽快结束', async () => {
    const handle = startDshRun({
      task: 'HANG',
      cwd: process.cwd(),
      timeoutMs: 30_000,
      spawn: SPAWN,
      profile: 'headless',
      onEvent: () => {},
    });
    setTimeout(() => handle.cancel(), 100);
    const outcome = await handle.outcome;
    expect(outcome.cancelled).toBe(true);
    expect(outcome.timedOut).toBe(false);
  });
});
