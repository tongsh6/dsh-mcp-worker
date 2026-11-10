import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { collectGitBaseline, collectGitEvidence } from '../src/git-evidence.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', ['-C', cwd, ...args], { windowsHide: true });
}

async function makeRepo(): Promise<{ repo: string; taskDir: string }> {
  const repo = await mkdtemp(join(tmpdir(), 'git-evidence-repo-'));
  const taskDir = await mkdtemp(join(tmpdir(), 'git-evidence-task-'));
  await git(repo, ['init', '-q']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'test']);
  await writeFile(join(repo, 'dirty.txt'), 'before\n', 'utf8');
  await writeFile(join(repo, 'tracked.txt'), 'one\n', 'utf8');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-q', '-m', 'init']);
  await writeFile(join(repo, 'dirty.txt'), 'before dirty\n', 'utf8');
  return { repo, taskDir };
}

describe('git-evidence：基线、变更文件与 diff 落盘', () => {
  it('标记 pre_existing，采集新增文件与 diff，patch 不含未跟踪文件', async () => {
    const { repo, taskDir } = await makeRepo();
    try {
      const baseline = await collectGitBaseline(repo);
      expect(baseline?.some((line) => line.includes('dirty.txt'))).toBe(true);

      await writeFile(join(repo, 'tracked.txt'), 'one\nchanged\n', 'utf8');
      await writeFile(join(repo, 'new-file.txt'), 'new\n', 'utf8');
      const evidence = await collectGitEvidence(repo, baseline, taskDir);
      expect(evidence).not.toBeNull();
      expect(evidence?.head).toBeTruthy();
      expect(evidence?.pre_existing_dirty).toBe(true);
      const dirty = evidence?.files.find((file) => file.path === 'dirty.txt');
      expect(dirty?.pre_existing).toBe(true);
      const untracked = evidence?.files.find((file) => file.path === 'new-file.txt');
      expect(untracked).toMatchObject({ status: '??', pre_existing: false });
      expect(evidence?.summary?.untracked).toBe(1);
      expect(evidence?.summary?.insertions ?? 0).toBeGreaterThan(0);
      expect(evidence?.diff_stat).toContain('untracked: 1 files');
      expect(evidence?.patch_path).toBeTruthy();
      const patch = await readFile(evidence!.patch_path!, 'utf8');
      expect(patch).toContain('tracked.txt');
      expect(patch).toContain('new-file.txt');
      expect(patch).toContain('new file mode');
    } finally {
      await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
      await rm(taskDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
    }
  });

  it('非 git 目录返回 null', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'git-evidence-nonrepo-'));
    try {
      expect(await collectGitBaseline(dir)).toBeNull();
      expect(await collectGitEvidence(dir, null, dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
    }
  });
});
