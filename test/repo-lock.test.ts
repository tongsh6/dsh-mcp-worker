import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { TaskManager } from '../src/task-manager.js';
import type { TaskRunInput, TaskRunner } from '../src/task-manager.js';
import type { RunHandle, RunOutcome } from '../src/types.js';
import { MemoryStore, makeRunOutcome, makeTestConfig, waitFor } from './helpers.js';

const execFileAsync = promisify(execFile);
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await Promise.resolve(fn()).catch(() => undefined);
});

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', ['-C', cwd, ...args], { windowsHide: true });
}

interface Call {
  cwd: string;
  permissionMode: string;
}

/** 挂起型 runner：任务保持运行，直到测试显式 release（用于验证排队与并发）。 */
function makeGatedRunner(calls: Call[]): { runner: TaskRunner; pending: Array<() => void> } {
  const pending: Array<() => void> = [];
  const runner: TaskRunner = (input: TaskRunInput): RunHandle => {
    calls.push({ cwd: input.cwd, permissionMode: input.permissionMode });
    let settled = false;
    let resolveOutcome!: (outcome: RunOutcome) => void;
    const outcome = new Promise<RunOutcome>((resolve) => {
      resolveOutcome = resolve;
    });
    const release = (): void => {
      if (settled) return;
      settled = true;
      input.onEvent({ type: 'final', text: 'gated-ok' });
      resolveOutcome(makeRunOutcome({ finalText: 'gated-ok' }));
    };
    pending.push(release);
    return {
      pid: 1,
      cancel: (): void => {
        if (settled) return;
        settled = true;
        resolveOutcome(makeRunOutcome({ cancelled: true }));
      },
      outcome,
    };
  };
  return { runner, pending };
}

async function setupRepo(base: string): Promise<string> {
  const repo = join(base, 'repo');
  await mkdir(join(repo, 'sub'), { recursive: true });
  await git(repo, ['init', '-q']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'test']);
  await writeFile(join(repo, 'a.txt'), 'a', 'utf8');
  await writeFile(join(repo, 'sub', 'b.txt'), 'b', 'utf8');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-q', '-m', 'init']);
  return repo;
}

describe('per-repo 并发锁', () => {
  it('同一 git 仓库的子目录任务串行：第二个排队到第一个结束', async () => {
    const base = await mkdtemp(join(tmpdir(), 'repo-lock-'));
    try {
      const repo = await setupRepo(base);
      const calls: Call[] = [];
      const { runner, pending } = makeGatedRunner(calls);
      const config = makeTestConfig({
        cleanupIntervalMs: 0,
        maxConcurrent: 4,
        maxConcurrentPerCwd: 1,
      });
      const manager = new TaskManager({ runner, store: new MemoryStore(), config });
      await manager.init();
      cleanups.push(() => manager.stop());

      const first = await manager.create({ task: 'first-repo', cwd: repo });
      await waitFor(() => manager.get(first.id)?.status === 'running', 10_000);

      const second = await manager.create({ task: 'second-sub', cwd: join(repo, 'sub') });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(manager.get(second.id)?.status).toBe('queued');
      const queuedStatus = await manager.status(second.id);
      expect(queuedStatus.queued_reason).toBe('concurrency');

      // 只放行第一个任务；第二个必须等第一个结束后才被调度
      pending.shift()?.();
      await waitFor(() => manager.get(first.id)?.status === 'succeeded', 10_000);
      const firstEndedAt = manager.get(first.id)?.endedAt ?? 0;
      await waitFor(() => manager.get(second.id)?.status === 'running', 10_000);
      expect(manager.get(second.id)?.startedAt ?? 0).toBeGreaterThanOrEqual(firstEndedAt);
      pending.shift()?.();
      await waitFor(() => manager.get(second.id)?.status === 'succeeded', 10_000);
    } finally {
      await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => undefined);
    }
  }, 60_000);

  it('不同非 git 目录的任务仍可并发（锁 key 回退 cwd）', async () => {
    const base = await mkdtemp(join(tmpdir(), 'repo-lock-plain-'));
    try {
      const dir1 = join(base, 'one');
      const dir2 = join(base, 'two');
      await mkdir(dir1, { recursive: true });
      await mkdir(dir2, { recursive: true });
      const calls: Call[] = [];
      const { runner, pending } = makeGatedRunner(calls);
      const config = makeTestConfig({
        cleanupIntervalMs: 0,
        maxConcurrent: 4,
        maxConcurrentPerCwd: 1,
      });
      const manager = new TaskManager({ runner, store: new MemoryStore(), config });
      await manager.init();
      cleanups.push(() => manager.stop());

      const first = await manager.create({ task: 'one', cwd: dir1 });
      const second = await manager.create({ task: 'two', cwd: dir2 });
      await waitFor(
        () => manager.get(first.id)?.status === 'running' && manager.get(second.id)?.status === 'running',
        10_000,
      );
      expect(calls).toHaveLength(2);
      for (const taskId of [first.id, second.id]) expect(manager.get(taskId)?.status).toBe('running');
      for (const release of pending.splice(0)) release();
      await waitFor(
        () => manager.get(first.id)?.status === 'succeeded' && manager.get(second.id)?.status === 'succeeded',
        10_000,
      );
    } finally {
      await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => undefined);
    }
  }, 60_000);
});
