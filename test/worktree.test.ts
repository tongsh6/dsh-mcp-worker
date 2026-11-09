import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createDetachedWorktree } from '../src/worktree.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', ['-C', cwd, ...args], { windowsHide: true });
}

describe('D2 自动 worktree', () => {
  it('干净 git 仓库会创建 detached worktree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wt-repo-'));
    const worktreeRoot = await mkdtemp(join(tmpdir(), 'wt-root-'));
    try {
      await git(root, ['init', '-q']);
      await git(root, ['config', 'user.email', 'test@example.com']);
      await git(root, ['config', 'user.name', 'test']);
      await writeFile(join(root, 'a.txt'), 'hello', 'utf8');
      await git(root, ['add', '.']);
      await git(root, ['commit', '-q', '-m', 'init']);
      const worktree = await createDetachedWorktree(root, worktreeRoot, Date.now());
      expect(worktree).not.toBeNull();
      expect(worktree?.path.startsWith(worktreeRoot)).toBe(true);
      const { stdout } = await execFileAsync('git', ['-C', worktree!.path, 'rev-parse', '--is-inside-work-tree'], {
        windowsHide: true,
      });
      expect(stdout.trim()).toBe('true');
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
      await rm(worktreeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
    }
  });

  it('有未提交改动的仓库不创建 worktree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wt-repo-'));
    const worktreeRoot = await mkdtemp(join(tmpdir(), 'wt-root-'));
    try {
      await git(root, ['init', '-q']);
      await writeFile(join(root, 'dirty.txt'), 'x', 'utf8');
      expect(await createDetachedWorktree(root, worktreeRoot, Date.now())).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
      await rm(worktreeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
    }
  });
});
