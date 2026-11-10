import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface WorktreeInfo {
  path: string;
  branch: string;
  repoRoot: string;
  /** worktree 基于的提交（合入/审计用）；HEAD 无法解析时为 null。 */
  baseCommit: string | null;
}

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      timeout: 20_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, stdout: String(stdout) };
  } catch {
    return { ok: false, stdout: '' };
  }
}

/**
 * 为受限仓库创建「可写 worktree」：仅当 cwd 是干净 git 仓库时尝试。
 * 目的：ACL 拒绝 workspace-write 时，不改仓库 ACL、也不用全权，直接在独立 worktree 里写。
 */
export async function createDetachedWorktree(
  cwd: string,
  worktreeRoot: string,
  now: number,
): Promise<WorktreeInfo | null> {
  const rootResult = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (!rootResult.ok) return null;
  const repoRoot = rootResult.stdout.trim();
  if (!repoRoot) return null;
  const status = await git(repoRoot, ['status', '--porcelain']);
  if (!status.ok || status.stdout.trim().length > 0) return null; // 有未提交改动：不自动复制
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const name = `${basename(repoRoot).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 40)}-${stamp}`;
  const path = join(worktreeRoot, name);
  const head = await git(repoRoot, ['rev-parse', 'HEAD']);
  await mkdir(worktreeRoot, { recursive: true });
  const added = await git(repoRoot, ['worktree', 'add', '--detach', path]);
  if (!added.ok) return null;
  return { path, branch: 'detached', repoRoot, baseCommit: head.ok ? head.stdout.trim() || null : null };
}
