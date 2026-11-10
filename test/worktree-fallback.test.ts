import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', ['-C', cwd, ...args], { windowsHide: true });
}

interface Call {
  cwd: string;
  permissionMode: string;
  attempt?: number;
}

const ACL_TEXT = 'SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\\work\\repo)';

function aclToolResult(): RunEvent {
  return {
    type: 'tool_result',
    message: {
      role: 'tool',
      isError: true,
      content: [{ type: 'text', text: ACL_TEXT }],
    },
  };
}

/**
 * 按 permissionMode 模拟 DSH 行为的 runner：
 * - workspace-write：发 ACL tool_result（可选挂起直到 cancel），按 aclFail 决定是否正常结束；
 * - danger-full-access：成功。
 */
function makeAclRunner(
  calls: Call[],
  opts: { aclFail?: boolean; hangOnWorkspaceWrite?: boolean; decisionText?: string } = {},
): { runner: TaskRunner; cancels: () => number } {
  let cancels = 0;
  const runner: TaskRunner = (input: TaskRunInput): RunHandle => {
    calls.push({ cwd: input.cwd, permissionMode: input.permissionMode, attempt: input.attempt });
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
        if (opts.hangOnWorkspaceWrite) return; // 等 manager 的 fail-fast cancel
        const text = opts.decisionText ?? '[DSH:NEEDS_DECISION]\n\n环境不可用，请 leader 决策。';
        input.onEvent({ type: 'text', text });
        finish(makeRunOutcome({ exitCode: 0, finalText: text }));
        return;
      }
      input.onEvent({ type: 'final', text: 'full-ok' });
      finish(makeRunOutcome({ exitCode: 0, finalText: 'full-ok' }));
    }, 5);
    return {
      pid: 1,
      cancel: (): void => {
        cancels += 1;
        finish(makeRunOutcome({ exitCode: null, finalText: null, cancelled: true }));
      },
      outcome,
    };
  };
  return { runner, cancels: () => cancels };
}

async function setupRepo(base: string): Promise<{ repo: string; worktreeRoot: string }> {
  const repo = join(base, 'repo');
  const worktreeRoot = join(base, 'worktrees');
  await mkdir(repo, { recursive: true });
  await git(repo, ['init', '-q']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'test']);
  await writeFile(join(repo, 'a.txt'), 'hello', 'utf8');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-q', '-m', 'init']);
  return { repo, worktreeRoot };
}

function isTerminal(manager: TaskManager, taskId: string): boolean {
  const status = manager.get(taskId)?.status;
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

describe('worktree 二级兜底与 ACL 归因', () => {
  it('worktree 重试仍 ACL 失败时，自动二次升级 danger-full-access，并保留首次决策文本', async () => {
    const base = await mkdtemp(join(tmpdir(), 'wt-fallback-'));
    try {
      const { repo, worktreeRoot } = await setupRepo(base);
      const calls: Call[] = [];
      const { runner } = makeAclRunner(calls, { aclFail: true });
      const config = makeTestConfig({
        cleanupIntervalMs: 0,
        autoWorktree: true,
        aclFallback: 'danger-full-access',
        aclFailFast: false,
        worktreeRoot,
      });
      const manager = new TaskManager({ runner, store: new MemoryStore(), config });
      await manager.init();
      cleanups.push(() => manager.stop());

      const record = await manager.create({ task: 'chain', cwd: repo });
      await waitFor(() => isTerminal(manager, record.id), 20_000);
      const result = await manager.result(record.id);

      expect(result.status).toBe('succeeded');
      expect(result.effective_permission_mode).toBe('danger-full-access');
      expect(calls.map((call) => call.permissionMode)).toEqual([
        'workspace-write',
        'workspace-write',
        'danger-full-access',
      ]);
      expect(calls[1]!.cwd.startsWith(worktreeRoot)).toBe(true);
      expect(result.sandbox_fallback).toMatchObject({ from: 'workspace-write', to: 'danger-full-access' });
      expect(result.worktree?.path.startsWith(worktreeRoot)).toBe(true);
      // attempts：三段的权限、ACL 标记与首次决策文本都要保留
      expect(result.attempts).toHaveLength(3);
      expect(result.attempts?.[0]).toMatchObject({ index: 1, permission_mode: 'workspace-write', acl_blocked: true });
      expect(result.attempts?.[0]?.final_text_tail).toContain('[DSH:NEEDS_DECISION]');
      expect(result.attempts?.[1]).toMatchObject({ index: 2, permission_mode: 'workspace-write', acl_blocked: true });
      expect(result.attempts?.[2]).toMatchObject({ index: 3, permission_mode: 'danger-full-access', acl_blocked: false });
      expect(result.sandbox_blocked).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => undefined);
    }
  }, 60_000);

  it('ACL fail-fast：首条 ACL 失败立即中止当前 attempt，不用等长超时', async () => {
    const base = await mkdtemp(join(tmpdir(), 'wt-fastabort-'));
    try {
      const { repo, worktreeRoot } = await setupRepo(base);
      const calls: Call[] = [];
      const { runner, cancels } = makeAclRunner(calls, { hangOnWorkspaceWrite: true });
      const config = makeTestConfig({
        cleanupIntervalMs: 0,
        autoWorktree: true,
        aclFallback: 'danger-full-access',
        aclFailFast: true,
        worktreeRoot,
        defaultTimeoutMs: 60_000,
      });
      const manager = new TaskManager({ runner, store: new MemoryStore(), config });
      await manager.init();
      cleanups.push(() => manager.stop());

      const startedAt = Date.now();
      const record = await manager.create({ task: 'fast-abort', cwd: repo });
      await waitFor(() => isTerminal(manager, record.id), 20_000);
      const elapsed = Date.now() - startedAt;
      const result = await manager.result(record.id);

      expect(result.status).toBe('succeeded');
      expect(elapsed).toBeLessThan(10_000);
      expect(cancels()).toBe(2); // 原目录 + worktree 两次 workspace-write 都被 ACL fail-fast 中止
      expect(calls.map((call) => call.permissionMode)).toEqual([
        'workspace-write',
        'workspace-write',
        'danger-full-access',
      ]);
    } finally {
      await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => undefined);
    }
  }, 60_000);

  it('取消任务时保留 ACL 归因：failure_kind=sandbox_acl + sandbox_blocked', async () => {
    const calls: Call[] = [];
    const { runner } = makeAclRunner(calls, { hangOnWorkspaceWrite: true });
    const config = makeTestConfig({
      cleanupIntervalMs: 0,
      autoWorktree: false,
      aclFallback: 'off',
      aclFailFast: false,
    });
    const manager = new TaskManager({ runner, store: new MemoryStore(), config });
    await manager.init();
    cleanups.push(() => manager.stop());

    const record = await manager.create({ task: 'cancel-attribution', cwd: 'D:\\work\\repo' });
    await waitFor(() => manager.get(record.id)?.status === 'running', 5_000);
    await waitFor(() => manager.get(record.id)?.sandboxBlocked === true, 5_000);
    await manager.cancel(record.id);
    await waitFor(() => isTerminal(manager, record.id), 5_000);
    const result = await manager.result(record.id);

    expect(result.status).toBe('cancelled');
    expect(result.failure_kind).toBe('sandbox_acl');
    expect(result.sandbox_blocked).toBe(true);
    expect(result.sandbox_blocked_detail).toContain('grantWrite');
    expect(result.diagnosis?.suggestion).toContain('icacls');
  }, 30_000);

  it('回合正常结束但命令全被 ACL 拦住时，不再静默判成功（false success）', async () => {
    const calls: Call[] = [];
    const { runner } = makeAclRunner(calls, { aclFail: true });
    const config = makeTestConfig({
      cleanupIntervalMs: 0,
      autoWorktree: false,
      aclFallback: 'off',
      aclFailFast: false,
      allowFullAccessFallback: false,
    });
    const manager = new TaskManager({ runner, store: new MemoryStore(), config });
    await manager.init();
    cleanups.push(() => manager.stop());

    const record = await manager.create({ task: 'false-success', cwd: 'D:\\work\\repo' });
    await waitFor(() => isTerminal(manager, record.id), 10_000);
    const result = await manager.result(record.id);

    expect(result.status).toBe('failed');
    expect(result.failure_kind).toBe('sandbox_acl');
    expect(result.sandbox_blocked).toBe(true);
    expect(result.error).toContain('grantWrite');
  }, 30_000);

  it('allowFullAccessFallback=false 时不做全权降级，直接按 sandbox_acl 失败', async () => {
    const base = await mkdtemp(join(tmpdir(), 'wt-nofull-'));
    try {
      const { repo, worktreeRoot } = await setupRepo(base);
      const calls: Call[] = [];
      const { runner } = makeAclRunner(calls, { aclFail: true });
      const config = makeTestConfig({
        cleanupIntervalMs: 0,
        autoWorktree: true,
        aclFallback: 'danger-full-access',
        aclFailFast: false,
        allowFullAccessFallback: false,
        worktreeRoot,
      });
      const manager = new TaskManager({ runner, store: new MemoryStore(), config });
      await manager.init();
      cleanups.push(() => manager.stop());

      const record = await manager.create({ task: 'no-full', cwd: repo });
      await waitFor(() => isTerminal(manager, record.id), 20_000);
      const result = await manager.result(record.id);

      expect(calls.map((call) => call.permissionMode)).toEqual(['workspace-write', 'workspace-write']);
      expect(result.status).toBe('failed');
      expect(result.failure_kind).toBe('sandbox_acl');
      expect(result.sandbox_blocked).toBe(true);
      expect(result.error).toContain('icacls');
    } finally {
      await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => undefined);
    }
  }, 60_000);
});
