import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { GitEvidence } from './types.js';

const execFileAsync = promisify(execFile);

export const GIT_TIMEOUT_MS = 10_000;
export const GIT_TOTAL_TIMEOUT_MS = 20_000;
export const GIT_DIFF_STAT_MAX_BYTES = 4_096;
export const GIT_PATCH_MAX_BYTES = 2 * 1024 * 1024;
export const GIT_FILES_LIMIT = 200;

interface GitRun {
  ok: boolean;
  stdout: string;
  error?: string;
}

async function git(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<GitRun> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, stdout: String(stdout) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, stdout: '', error: message };
  }
}

/** 是否是 git 仓库；不是返回 false。 */
export async function isGitRepo(dir: string): Promise<boolean> {
  const result = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  return result.ok && result.stdout.trim() === 'true';
}

/** 任务开始前的脏文件基线（porcelain 行）；非 git 仓库返回 null。 */
export async function collectGitBaseline(dir: string): Promise<string[] | null> {
  if (!(await isGitRepo(dir))) return null;
  const status = await git(dir, ['status', '--porcelain']);
  if (!status.ok) return null;
  return status.stdout
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
}

/** porcelain 行格式：XY<space>path（不要先 trim，否则会丢状态位前的空格）。 */
function parsePorcelainPath(line: string): string {
  const body = line.length >= 3 ? line.slice(3) : line;
  const renamed = body.split(' -> ');
  return (renamed[renamed.length - 1] ?? body).replace(/^"|"$/g, '');
}

function parseNumstat(text: string): { insertions: number; deletions: number; files: number } {
  let insertions = 0;
  let deletions = 0;
  let files = 0;
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const added = Number(parts[0]);
    const removed = Number(parts[1]);
    if (Number.isFinite(added) && Number.isFinite(removed)) {
      insertions += added;
      deletions += removed;
      files += 1;
    }
  }
  return { insertions, deletions, files };
}

/**
 * 任务结束后采集 git 证据：files / diff_stat / summary / patch。
 * 失败只写 error，绝不抛出（不影响任务状态）。
 */
export async function collectGitEvidence(
  dir: string,
  baseline: string[] | null,
  taskDir: string,
  options: { enabled?: boolean } = {},
): Promise<GitEvidence | null> {
  if (options.enabled === false) return null;
  if (!(await isGitRepo(dir))) return null;

  const started = Date.now();
  const remaining = (): number => Math.max(500, GIT_TOTAL_TIMEOUT_MS - (Date.now() - started));
  const head = await git(dir, ['rev-parse', '--short', 'HEAD'], remaining());
  const branch = await git(dir, ['branch', '--show-current'], remaining());
  const status = await git(dir, ['status', '--porcelain'], remaining());
  const numstat = await git(dir, ['diff', 'HEAD', '--numstat'], remaining());
  const stat = await git(dir, ['diff', 'HEAD', '--stat'], remaining());
  const patch = await git(dir, ['diff', 'HEAD'], remaining());

  const errors = [head, branch, status, numstat, stat, patch].filter((result) => !result.ok).map((result) => result.error ?? 'git failed');
  const baselinePaths = new Set((baseline ?? []).map((line) => parsePorcelainPath(line)));
  const allFiles = status.ok
    ? status.stdout
        .split(/\r?\n/)
        .filter((line) => line.length > 0)
        .map((line) => {
          const path = parsePorcelainPath(line);
          return {
            path,
            status: line.slice(0, 2).trim() || '??',
            pre_existing: baselinePaths.has(path),
          };
        })
    : [];
  const files = allFiles.slice(0, GIT_FILES_LIMIT);
  const counts = numstat.ok ? parseNumstat(numstat.stdout) : { insertions: 0, deletions: 0, files: allFiles.length };
  const untracked = allFiles.filter((file) => file.status === '??').length;

  let patchPath: string | null = null;
  let patchTruncated = false;
  if (patch.ok) {
    await mkdir(taskDir, { recursive: true });
    patchPath = join(taskDir, 'diff.patch');
    const bytes = Buffer.from(patch.stdout, 'utf8');
    patchTruncated = bytes.length > GIT_PATCH_MAX_BYTES;
    await writeFile(patchPath, bytes.subarray(0, GIT_PATCH_MAX_BYTES), 'utf8');
  }

  const statText = stat.ok ? stat.stdout : '';
  const statTruncated = Buffer.byteLength(statText, 'utf8') > GIT_DIFF_STAT_MAX_BYTES;
  const evidence: GitEvidence = {
    dir,
    head: head.ok ? head.stdout.trim() || null : null,
    branch: branch.ok ? branch.stdout.trim() || null : null,
    files,
    ...(allFiles.length > GIT_FILES_LIMIT ? { files_truncated: true } : {}),
    diff_stat: statTruncated ? statText.slice(0, GIT_DIFF_STAT_MAX_BYTES) : statText,
    summary: {
      files_changed: counts.files,
      insertions: counts.insertions,
      deletions: counts.deletions,
      untracked,
    },
    pre_existing_dirty: (baseline ?? []).length > 0,
    patch_path: patchPath,
    ...(patchTruncated ? { patch_truncated: true } : {}),
  };
  if (errors.length > 0) evidence.error = errors[0]!.slice(0, 300);
  return evidence;
}
