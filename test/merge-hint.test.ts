import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { TaskManager } from '../src/task-manager.js';
import type { TaskRunInput, TaskRunner } from '../src/task-manager.js';
import type { RunEvent, RunHandle, RunOutcome } from '../src/types.js';
import { MemoryStore, makeRunOutcome, makeTestConfig, waitFor } from './helpers.js';

const execFileAsync = promisify(execFile);
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await Promise.resolve(fn()).catch(() => undefined);
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { windowsHide: true });
  return String(stdout);
}

function aclToolResult(): RunEvent {
  return {
    type: 'tool_result',
    message: {
      role: 'tool',
      isError: true,
      content: [
        {
          type: 'text',
          text: 'SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\\work\\repo)',
        },
      ],
    },
  };
}

interface Call {
  cwd: string;
  permissionMode: string;
}

/** workspace-write 两段都 ACL 失败；danger-full-access 段在 worktree 里写一个文件模拟 DSH 改动。 */
function makeEditRunner(calls: Call[]): TaskRunner {
  return (input: TaskRunInput): RunHandle => {
    calls.push({ cwd: input.cwd, permissionMode: input.permissionMode });
    let settled = false;
    let resolveOutcome!: (outcome: RunOutcome) => void;
    const outcome = new Promise<RunOutcome>((resolve) => {
      resolveOutcome = resolve;
    });
    const finish = (value: RunOutcome): void => {
      if (settled) return;
      settled = true;
      resolveOutcome(value);
    };
    setTimeout(() => {
      if (input.permissionMode === 'workspace-write') {
        input.onEvent(aclToolResult());
        input.onEvent({ type: 'text', text: '[DSH:NEEDS_DECISION]\n\n环境不可用' });
        finish(makeRunOutcome({ exitCode: 0, finalText: '[DSH:NEEDS_DECISION]' }));
        return;
      }
      if (input.permissionMode !== 'danger-full-access') {
        input.onEvent({ type: 'final', text: 'read-only-ok' });
        finish(makeRunOutcome({ exitCode: 0, finalText: 'read-only-ok' }));
        return;
      }
      void writeFile(join(input.cwd, 'fixed.txt'), 'fixed by dsh', 'utf8').then(() => {
        input.onEvent({ type: 'final', text: 'fixed' });
        finish(makeRunOutcome({ exitCode: 0, finalText: 'fixed' }));
      });
    }, 5);
    return { pid: 1, cancel: () => finish(makeRunOutcome({ cancelled: true })), outcome };
  };
}

async function setup() {
  const base = await mkdtemp(join(tmpdir(), 'merge-hint-'));
  const repo = join(base, 'repo');
  const worktreeRoot = join(base, 'worktrees');
  await mkdir(repo, { recursive: true });
  await git(repo, ['init', '-q']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'test']);
  await writeFile(join(repo, 'a.txt'), 'hello', 'utf8');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-q', '-m', 'init']);
  const calls: Call[] = [];
  const config = makeTestConfig({
    cleanupIntervalMs: 0,
    autoWorktree: true,
    aclFallback: 'danger-full-access',
    aclFailFast: false,
    evidenceGit: true,
    worktreeRoot,
    maxConcurrentPerCwd: 4,
  });
  const manager = new TaskManager({ runner: makeEditRunner(calls), store: new MemoryStore(), config });
  await manager.init();
  cleanups.push(() => manager.stop());
  cleanups.push(() => rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  return { manager, calls, repo, worktreeRoot };
}

function isTerminal(manager: TaskManager, taskId: string): boolean {
  const status = manager.get(taskId)?.status;
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

describe('worktree 合入指引（merge_hint）', () => {
  it('worktree 任务返回 base_commit / patch_path / apply_command，且 patch 可应用到原仓库', async () => {
    const { manager, repo, worktreeRoot } = await setup();
    const record = await manager.create({ task: 'worktree-merge', cwd: repo });
    await waitFor(() => isTerminal(manager, record.id), 30_000);
    const result = await manager.result(record.id);

    expect(result.status).toBe('succeeded');
    expect(result.worktree?.path.startsWith(worktreeRoot)).toBe(true);
    expect(result.worktree?.base_commit).toMatch(/^[0-9a-f]{40}$/);
    const patchPath = result.merge_hint?.patch_path ?? null;
    expect(patchPath && isAbsolute(patchPath)).toBe(true);
    expect(result.merge_hint).toMatchObject({
      base_commit: result.worktree?.base_commit,
      patch_path: patchPath,
    });
    expect(result.merge_hint?.apply_command).toContain(repo);
    expect(result.merge_hint?.apply_command).toContain(String(patchPath));

    // merge_hint 指向的 patch 确实能合入原仓库（v0.9.1 起的 untracked 支持）
    await git(repo, ['apply', '--3way', String(patchPath)]);
    expect((await readFile(join(repo, 'fixed.txt'), 'utf8')).trim()).toBe('fixed by dsh');
  }, 60_000);

  it('没有 worktree 的任务不返回 merge_hint', async () => {
    const { manager } = await setup();
    const record = await manager.create({ task: 'no-worktree', cwd: 'D:\\work\\plain', permissionMode: 'read-only' });
    await waitFor(() => isTerminal(manager, record.id), 15_000);
    const result = await manager.result(record.id);
    expect(result.worktree ?? null).toBeNull();
    expect(result.merge_hint).toBeNull();
  }, 30_000);
});
