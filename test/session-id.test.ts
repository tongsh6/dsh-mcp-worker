import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskManager } from '../src/task-manager.js';
import type { RunHandle, TaskRunner, TaskRunInput } from '../src/task-manager.js';
import { JsonlTaskStore } from '../src/store.js';
import { MemoryStore, makeRunOutcome, makeTestConfig, waitFor } from './helpers.js';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await Promise.resolve(fn()).catch(() => undefined);
});

function isTerminal(manager: TaskManager, taskId: string): boolean {
  const status = manager.get(taskId)?.status;
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

/** 立即发一个指定 session 事件并完成；用于模拟 DSH 返回的实际 session id。 */
function makeActualSessionRunner(
  calls: Array<{ cwd: string; permissionMode: string; sessionId?: string }>,
  actualSessionId: string,
): TaskRunner {
  return (input: TaskRunInput): RunHandle => {
    calls.push({ cwd: input.cwd, permissionMode: input.permissionMode, sessionId: input.sessionId });
    input.onEvent({ type: 'session', sessionId: actualSessionId, cwd: input.cwd });
    input.onEvent({ type: 'final', text: 'ok' });
    return {
      pid: 1,
      cancel: () => undefined,
      outcome: Promise.resolve(makeRunOutcome({ finalText: 'ok', sessionId: actualSessionId })),
    };
  };
}

/** 发 session 事件后挂起，直到 release()，用于观察运行期的 session 锁。 */
function makeGatedSessionRunner(actualSessionId: string): { runner: TaskRunner; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runner: TaskRunner = (input: TaskRunInput): RunHandle => {
    let resolveOutcome!: (outcome: ReturnType<typeof makeRunOutcome>) => void;
    const outcome = new Promise<ReturnType<typeof makeRunOutcome>>((resolve) => {
      resolveOutcome = resolve;
    });
    input.onEvent({ type: 'session', sessionId: actualSessionId, cwd: input.cwd });
    void gate.then(() => {
      input.onEvent({ type: 'final', text: 'ok' });
      resolveOutcome(makeRunOutcome({ finalText: 'ok', sessionId: actualSessionId }));
    });
    return { pid: 1, cancel: () => resolveOutcome(makeRunOutcome({ cancelled: true })), outcome };
  };
  return { runner, release };
}

describe('session id 回填与持久化', () => {
  it('首次 run 即返回非空 session_id，且 status/result/tasks 使用同一 ID', async () => {
    const runner: TaskRunner = (input: TaskRunInput): RunHandle => {
      const sessionId = input.sessionId ?? null;
      input.onEvent({ type: 'session', sessionId, cwd: input.cwd });
      input.onEvent({ type: 'final', text: 'done' });
      return {
        pid: 1,
        cancel: () => undefined,
        outcome: Promise.resolve(makeRunOutcome({ finalText: 'done', sessionId })),
      };
    };
    const manager = new TaskManager({ runner, store: new MemoryStore(), config: makeTestConfig() });
    await manager.init();
    cleanups.push(() => manager.stop());

    const record = await manager.create({ task: 'first-run', cwd: 'C:\\proj' });
    expect(typeof record.sessionId).toBe('string');
    expect(record.sessionId).toBeTruthy();

    await waitFor(() => isTerminal(manager, record.id));
    const status = await manager.status(record.id);
    const result = await manager.result(record.id);
    const summary = manager.summaries(1)[0];

    expect(status.session_id).toBe(record.sessionId);
    expect(result.session_id).toBe(record.sessionId);
    expect(summary?.session_id).toBe(record.sessionId);
  });

  it('SDK 实际 session（自动换新 ID）回填到 result/status 与最后一个 session 事件', async () => {
    const { SdkBackendPool } = await import('../src/sdk-pool.js');
    const { createSdkRunner } = await import('../src/sdk-runner.js');
    const { fileURLToPath } = await import('node:url');
    const fixture = fileURLToPath(new URL('./fixtures/fake-sdk.js', import.meta.url));
    const pool = new SdkBackendPool({
      spawn: { command: process.execPath, args: [fixture] },
      profile: 'sdk',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      idleMs: 60_000,
      initTimeoutMs: 30_000,
      env: { ...process.env, FAKE_SDK_REJECT_SESSION: 'mcp-prev-session' },
    });
    cleanups.push(() => pool.shutdown());
    const manager = new TaskManager({
      runner: createSdkRunner(pool),
      store: new MemoryStore(),
      config: makeTestConfig({ backend: 'sdk', maxConcurrent: 2 }),
    });
    await manager.init();
    cleanups.push(() => manager.stop());

    const record = await manager.create({
      task: 'continue-work',
      cwd: process.cwd(),
      sessionId: 'mcp-prev-session',
    });
    await waitFor(() => isTerminal(manager, record.id));

    const events = manager.get(record.id)?.events ?? [];
    const sessionEvents = events
      .filter((event) => event.type === 'session' && typeof event.sessionId === 'string')
      .map((event) => event.sessionId as string);
    const actual = sessionEvents.at(-1);
    expect(actual).toBeTruthy();
    expect(actual).toContain('resume');

    const status = await manager.status(record.id);
    const result = await manager.result(record.id);
    expect(status.session_id).toBe(actual);
    expect(result.session_id).toBe(actual);
    expect(manager.summaries(1)[0]?.session_id).toBe(actual);
  });

  it('实际 session id 落盘，worker 重启后 status/result 仍返回该 ID', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'session-persist-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    const tasksDir = join(dir, 'tasks');
    const store = new JsonlTaskStore(tasksDir);
    const config = makeTestConfig({ tasksDir, cleanupIntervalMs: 0 });
    const calls: Array<{ cwd: string; permissionMode: string; sessionId?: string }> = [];
    const manager = new TaskManager({
      runner: makeActualSessionRunner(calls, 'sess-actual-1'),
      store,
      config,
    });
    await manager.init();
    cleanups.push(() => manager.stop());

    const record = await manager.create({ task: 'persist', cwd: 'C:\\proj' });
    await waitFor(() => isTerminal(manager, record.id), 20_000);
    const metaPath = join(tasksDir, record.id, 'meta.json');
    await waitFor(async () => (await readFile(metaPath, 'utf8').catch(() => '')).includes('sess-actual-1'), 60_000);

    manager.stop();
    const restarted = new TaskManager({
      runner: () => {
        throw new Error('已结束任务不应重新执行');
      },
      store,
      config,
    });
    await restarted.init();
    cleanups.push(() => restarted.stop());

    const status = await restarted.status(record.id);
    const result = await restarted.result(record.id);
    expect(status.session_id).toBe('sess-actual-1');
    expect(result.session_id).toBe('sess-actual-1');
  }, 90_000);

  it('session 变更迁移串行锁：新 ID 不可并行冲入，结束后旧锁不残留', async () => {
    const { runner, release } = makeGatedSessionRunner('sess-actual-2');
    const manager = new TaskManager({
      runner,
      store: new MemoryStore(),
      config: makeTestConfig({ maxConcurrent: 4, maxConcurrentPerCwd: 4 }),
    });
    await manager.init();
    cleanups.push(() => manager.stop());

    const first = await manager.create({ task: 'first', cwd: 'C:\\proj', sessionId: 'sess-1' });
    await waitFor(() => manager.get(first.id)?.sessionId === 'sess-actual-2', 2_000);

    const second = await manager.create({ task: 'second', cwd: 'C:\\proj', sessionId: 'sess-actual-2' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(manager.get(second.id)?.status).toBe('queued');
    expect(manager.get(second.id)?.startedAt).toBeUndefined();

    release();
    await waitFor(() => isTerminal(manager, first.id) && isTerminal(manager, second.id), 5_000);

    const third = await manager.create({ task: 'third', cwd: 'C:\\proj', sessionId: 'sess-1' });
    await waitFor(() => isTerminal(manager, third.id), 2_000);
    expect(manager.get(third.id)?.status).toBe('succeeded');
  }, 15_000);

  it('运行中换 ID 时旧 ID/新 ID 都保持串行，已排队旧 ID 任务接续最新实际 ID', async () => {
    const calls: Array<{ task: string; sessionId?: string }> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner: TaskRunner = (input: TaskRunInput): RunHandle => {
      calls.push({ task: input.task, sessionId: input.sessionId });
      let resolveOutcome!: (outcome: ReturnType<typeof makeRunOutcome>) => void;
      const outcome = new Promise<ReturnType<typeof makeRunOutcome>>((resolve) => {
        resolveOutcome = resolve;
      });
      if (input.task === 'first') {
        // 让 second 先在原始 ID 上排队，再发生 actual-new 换号。
        setTimeout(() => input.onEvent({ type: 'session', sessionId: 'actual-new', cwd: input.cwd }), 20);
        void gate.then(() => {
          input.onEvent({ type: 'final', text: 'first' });
          resolveOutcome(makeRunOutcome({ finalText: 'first', sessionId: 'actual-new' }));
        });
      } else {
        const actual = input.task === 'control' ? 'control-actual' : 'actual-new';
        input.onEvent({ type: 'session', sessionId: actual, cwd: input.cwd });
        resolveOutcome(makeRunOutcome({ finalText: input.task, sessionId: actual }));
      }
      return { pid: 1, cancel: () => resolveOutcome(makeRunOutcome({ cancelled: true })), outcome };
    };
    const manager = new TaskManager({
      runner,
      store: new MemoryStore(),
      config: makeTestConfig({ maxConcurrent: 4, maxConcurrentPerCwd: 4 }),
    });
    await manager.init();
    cleanups.push(() => manager.stop());

    const first = await manager.create({ task: 'first', cwd: 'C:\\proj', sessionId: 'original' });
    const second = await manager.create({ task: 'second', cwd: 'C:\\proj', sessionId: 'original' });
    await waitFor(() => manager.get(first.id)?.sessionId === 'actual-new', 2_000);
    const control = await manager.create({ task: 'control', cwd: 'C:\\proj', sessionId: 'control' });
    const newTask = await manager.create({ task: 'new', cwd: 'C:\\proj', sessionId: 'actual-new' });
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(manager.get(first.id)?.status).toBe('running');
    expect(manager.get(second.id)?.status).toBe('queued');
    expect(manager.get(second.id)?.startedAt).toBeUndefined();
    expect(manager.get(newTask.id)?.status).toBe('queued');
    expect(calls.map((call) => call.task)).toEqual(['first', 'control']);

    release();
    await waitFor(
      () =>
        isTerminal(manager, first.id) &&
        isTerminal(manager, second.id) &&
        isTerminal(manager, control.id) &&
        isTerminal(manager, newTask.id),
      5_000,
    );
    expect(manager.get(second.id)?.status).toBe('succeeded');
    expect(manager.get(newTask.id)?.status).toBe('succeeded');
    expect(calls.find((call) => call.task === 'second')?.sessionId).toBe('actual-new');
    expect(calls.find((call) => call.task === 'new')?.sessionId).toBe('actual-new');
    expect((await manager.result(second.id)).session_id).toBe('actual-new');

    const later = await manager.create({ task: 'later', cwd: 'C:\\proj', sessionId: 'original' });
    await waitFor(() => isTerminal(manager, later.id), 2_000);
    expect(manager.get(later.id)?.status).toBe('succeeded');
    expect(calls.find((call) => call.task === 'later')?.sessionId).toBe('actual-new');
  }, 15_000);
});
