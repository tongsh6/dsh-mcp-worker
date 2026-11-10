import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { cleanupStaleWorktrees } from '../src/worktree-cleanup.js';

const execFileAsync = promisify(execFile);
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await Promise.resolve(fn()).catch(() => undefined);
});

const TTL_MS = 60_000;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { windowsHide: true });
  return String(stdout);
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

interface Setup {
  base: string;
  repo: string;
  worktreeRoot: string;
  tasksDir: string;
}

/** 真实临时 git 仓库 + 空的 worktreeRoot / tasksDir。 */
async function setup(): Promise<Setup> {
  const base = await mkdtemp(join(tmpdir(), 'wt-cleanup-'));
  cleanups.push(() => rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const repo = join(base, 'repo');
  const worktreeRoot = join(base, 'worktrees');
  const tasksDir = join(base, 'tasks');
  await mkdir(repo, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  await mkdir(tasksDir, { recursive: true });
  await git(repo, ['init', '-q']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'test']);
  await writeFile(join(repo, 'a.txt'), 'hello', 'utf8');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-q', '-m', 'init']);
  return { base, repo, worktreeRoot, tasksDir };
}

async function addWorktree(repo: string, path: string): Promise<void> {
  await git(repo, ['worktree', 'add', '--detach', path]);
}

/** 写一个任务目录的 meta.json（只包含清理逻辑关心的字段）。 */
async function writeMeta(
  tasksDir: string,
  id: string,
  meta: { status: string; endedAt?: number; worktreePath?: string; originalCwd?: string },
): Promise<string> {
  const dir = join(tasksDir, id);
  await mkdir(dir, { recursive: true });
  const target = join(dir, 'meta.json');
  const payload: Record<string, unknown> = {
    id,
    task: `task ${id}`,
    cwd: meta.originalCwd ?? '',
    permissionMode: 'workspace-write',
    createdAt: 0,
    timedOut: false,
  };
  if (meta.status !== undefined) payload.status = meta.status;
  if (meta.endedAt !== undefined) payload.endedAt = meta.endedAt;
  if (meta.worktreePath !== undefined) payload.worktree = { path: meta.worktreePath, branch: 'detached' };
  if (meta.originalCwd !== undefined) payload.originalCwd = meta.originalCwd;
  await writeFile(target, JSON.stringify(payload, null, 2), 'utf8');
  return target;
}

/** `git worktree list --porcelain` 里的工作树路径数量。 */
async function worktreeCount(repo: string): Promise<number> {
  const output = await git(repo, ['worktree', 'list', '--porcelain']);
  return output
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .length;
}

describe('cleanupStaleWorktrees', () => {
  it('tasksDir 不存在时返回空结果且不报错', async () => {
    const base = await mkdtemp(join(tmpdir(), 'wt-cleanup-'));
    cleanups.push(() => rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
    const result = await cleanupStaleWorktrees({
      tasksDir: join(base, 'missing-tasks'),
      worktreeRoot: join(base, 'missing-worktrees'),
      ttlMs: TTL_MS,
      now: Date.now(),
    });
    expect(result).toEqual({ removed: [], pruned: [], failed: [], skipped: [] });
  });

  it('删除已过期终态任务的 worktree，只剩主工作树且不改 meta.json', async () => {
    const { repo, worktreeRoot, tasksDir } = await setup();
    const worktreePath = join(worktreeRoot, 'wt-expired');
    await addWorktree(repo, worktreePath);
    expect(await worktreeCount(repo)).toBe(2);

    const now = Date.now();
    const metaFile = await writeMeta(tasksDir, 'task-expired', {
      status: 'succeeded',
      endedAt: now - TTL_MS - 1_000,
      worktreePath,
      originalCwd: repo,
    });
    const metaBefore = await readFile(metaFile, 'utf8');

    const result = await cleanupStaleWorktrees({ tasksDir, worktreeRoot, ttlMs: TTL_MS, now });

    expect(result.removed).toEqual([resolve(worktreePath)]);
    expect(result.pruned).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(await exists(worktreePath)).toBe(false);
    expect(await worktreeCount(repo)).toBe(1);
    expect(await readFile(metaFile, 'utf8')).toBe(metaBefore);
  });

  it('未结束的任务（status running）不删除 worktree', async () => {
    const { repo, worktreeRoot, tasksDir } = await setup();
    const worktreePath = join(worktreeRoot, 'wt-running');
    await addWorktree(repo, worktreePath);

    const now = Date.now();
    await writeMeta(tasksDir, 'task-running', {
      status: 'running',
      endedAt: now - TTL_MS - 1_000,
      worktreePath,
      originalCwd: repo,
    });

    const result = await cleanupStaleWorktrees({ tasksDir, worktreeRoot, ttlMs: TTL_MS, now });

    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([resolve(worktreePath)]);
    expect(await exists(worktreePath)).toBe(true);
    expect(await worktreeCount(repo)).toBe(2);
  });

  it('worktree 路径不在 worktreeRoot 内时不删除（防止误删 root 外目录）', async () => {
    const { base, repo, worktreeRoot, tasksDir } = await setup();
    const outsideRoot = join(base, 'outside');
    await mkdir(outsideRoot, { recursive: true });
    const worktreePath = join(outsideRoot, 'wt-outside');
    await addWorktree(repo, worktreePath);

    const now = Date.now();
    await writeMeta(tasksDir, 'task-outside', {
      status: 'failed',
      endedAt: now - TTL_MS - 1_000,
      worktreePath,
      originalCwd: repo,
    });

    const result = await cleanupStaleWorktrees({ tasksDir, worktreeRoot, ttlMs: TTL_MS, now });

    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([resolve(worktreePath)]);
    expect(await exists(worktreePath)).toBe(true);
    expect(await worktreeCount(repo)).toBe(2);
  });

  it('worktree 目录已不存在时执行 prune 且不报错', async () => {
    const { repo, worktreeRoot, tasksDir } = await setup();
    const worktreePath = join(worktreeRoot, 'wt-gone');
    await addWorktree(repo, worktreePath);
    await rm(worktreePath, { recursive: true, force: true });
    expect(await exists(worktreePath)).toBe(false);

    const now = Date.now();
    await writeMeta(tasksDir, 'task-gone', {
      status: 'cancelled',
      endedAt: now - TTL_MS - 1_000,
      worktreePath,
      originalCwd: repo,
    });

    const result = await cleanupStaleWorktrees({ tasksDir, worktreeRoot, ttlMs: TTL_MS, now });

    expect(result.removed).toEqual([]);
    expect(result.pruned).toEqual([resolve(worktreePath)]);
    expect(result.failed).toEqual([]);
    expect(await worktreeCount(repo)).toBe(1);
  });

  it('ttl 未到期时不删除', async () => {
    const { repo, worktreeRoot, tasksDir } = await setup();
    const worktreePath = join(worktreeRoot, 'wt-fresh');
    await addWorktree(repo, worktreePath);

    const now = Date.now();
    await writeMeta(tasksDir, 'task-fresh', {
      status: 'succeeded',
      endedAt: now - TTL_MS + 1_000,
      worktreePath,
      originalCwd: repo,
    });

    const result = await cleanupStaleWorktrees({ tasksDir, worktreeRoot, ttlMs: TTL_MS, now });

    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([resolve(worktreePath)]);
    expect(await exists(worktreePath)).toBe(true);
    expect(await worktreeCount(repo)).toBe(2);
  });

  it('meta 无 originalCwd 时从 worktree 自身解析 repo root 并删除', async () => {
    const { repo, worktreeRoot, tasksDir } = await setup();
    const worktreePath = join(worktreeRoot, 'wt-no-original');
    await addWorktree(repo, worktreePath);

    const now = Date.now();
    await writeMeta(tasksDir, 'task-no-original', {
      status: 'failed',
      endedAt: now - TTL_MS - 1_000,
      worktreePath,
    });

    const result = await cleanupStaleWorktrees({ tasksDir, worktreeRoot, ttlMs: TTL_MS, now });

    expect(result.removed).toEqual([resolve(worktreePath)]);
    expect(result.failed).toEqual([]);
    expect(await exists(worktreePath)).toBe(false);
    expect(await worktreeCount(repo)).toBe(1);
  });
});
