import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { CwdCapabilityStore } from '../src/capability-store.js';
import { TaskManager } from '../src/task-manager.js';
import type { RunHandle, TaskRunner, TaskRunInput } from '../src/task-manager.js';
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

function makeRecordingRunner(calls: Call[]): TaskRunner {
  return (input: TaskRunInput): RunHandle => {
    calls.push({ cwd: input.cwd, permissionMode: input.permissionMode });
    input.onEvent({ type: 'session', sessionId: input.sessionId ?? 'sess-wt', cwd: input.cwd });
    input.onEvent({ type: 'final', text: 'wt-ok' });
    return {
      pid: 1,
      cancel: () => undefined,
      outcome: Promise.resolve(makeRunOutcome({ finalText: 'wt-ok', sessionId: input.sessionId ?? 'sess-wt' })),
    };
  };
}

/** 干净 git 仓库 + 已缓存「原 cwd 只能 danger-full-access」的 worker 环境。 */
async function setup() {
  const base = await mkdtemp(join(tmpdir(), 'wt-auto-'));
  const repo = join(base, 'repo');
  const dshHome = join(base, 'home');
  const worktreeRoot = join(base, 'worktrees');
  await mkdir(repo, { recursive: true });
  await git(repo, ['init', '-q']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'test']);
  await writeFile(join(repo, 'a.txt'), 'hello', 'utf8');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-q', '-m', 'init']);

  const capabilityFile = join(dshHome, 'mcp-cwd-capabilities.json');
  const seed = new CwdCapabilityStore(capabilityFile, 60_000);
  await seed.init();
  await seed.set(repo, 'danger-full-access', 'ACL denied for workspace-write');
  await seed.dispose();

  const config = makeTestConfig({
    cleanupIntervalMs: 0,
    capabilityStore: true,
    autoWorktree: true,
    aclFallback: 'danger-full-access',
    dshHome,
    worktreeRoot,
    maxConcurrentPerCwd: 4,
  });
  const calls: Call[] = [];
  const manager = new TaskManager({ runner: makeRecordingRunner(calls), store: new MemoryStore(), config });
  await manager.init();
  cleanups.push(() => manager.stop());
  cleanups.push(() => rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  return { manager, calls, repo, worktreeRoot };
}

function isTerminal(manager: TaskManager, taskId: string): boolean {
  const status = manager.get(taskId)?.status;
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

describe('auto 模式与 worktree 执行策略', () => {
  it('cwd 能力缓存为 danger 时，同 cwd 连续 auto 任务仍优先走 worktree', async () => {
    const { manager, calls, repo, worktreeRoot } = await setup();

    const first = await manager.create({ task: 'first-auto', cwd: repo, permissionMode: 'auto' });
    await waitFor(() => isTerminal(manager, first.id));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await manager.create({ task: 'second-auto', cwd: repo, permissionMode: 'auto' });
    await waitFor(() => isTerminal(manager, second.id));

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.cwd.startsWith(worktreeRoot)).toBe(true);
      expect(call.permissionMode).toBe('workspace-write');
    }
    expect(calls.some((call) => call.permissionMode === 'danger-full-access')).toBe(false);

    for (const id of [first.id, second.id]) {
      const result = await manager.result(id);
      expect(result.status).toBe('succeeded');
      expect(result.worktree?.path.startsWith(worktreeRoot)).toBe(true);
      expect(result.effective_permission_mode).toBe('workspace-write');
    }
  }, 30_000);

  it('显式 danger-full-access 不被 auto worktree 策略改写', async () => {
    const { manager, calls, repo } = await setup();
    const record = await manager.create({ task: 'explicit-full', cwd: repo, permissionMode: 'danger-full-access' });
    await waitFor(() => isTerminal(manager, record.id));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ cwd: repo, permissionMode: 'danger-full-access' });
    const result = await manager.result(record.id);
    expect(result.worktree).toBeNull();
    expect(result.effective_permission_mode).toBe('danger-full-access');
  }, 20_000);

  it('显式 workspace-write + 已知 cwd 不可写时仍按既有策略先切 worktree', async () => {
    const { manager, calls, repo, worktreeRoot } = await setup();
    const record = await manager.create({ task: 'explicit-write', cwd: repo, permissionMode: 'workspace-write' });
    await waitFor(() => isTerminal(manager, record.id));

    expect(calls).toHaveLength(1);
    expect(calls[0].cwd.startsWith(worktreeRoot)).toBe(true);
    expect(calls[0].permissionMode).toBe('workspace-write');
  }, 20_000);
});
