import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
  const untrackedPaths = allFiles.filter((file) => file.status === '??');
  const untrackedCount = untrackedPaths.length;

  const trackedPatch = patch.ok ? patch.stdout : '';
  const untrackedPatch = await buildUntrackedPatch(
    dir,
    untrackedPaths,
    Math.max(0, GIT_PATCH_MAX_BYTES - Buffer.byteLength(trackedPatch, 'utf8')),
  );

  let patchPath: string | null = null;
  let patchTruncated = false;
  if (patch.ok || untrackedPatch.patch) {
    await mkdir(taskDir, { recursive: true });
    patchPath = join(taskDir, 'diff.patch');
    const combined = `${trackedPatch}${untrackedPatch.patch}`;
    const bytes = Buffer.from(combined, 'utf8');
    patchTruncated = untrackedPatch.truncated || bytes.length > GIT_PATCH_MAX_BYTES;
    await writeFile(patchPath, bytes.subarray(0, GIT_PATCH_MAX_BYTES), 'utf8');
  }

  const statText = stat.ok ? stat.stdout : '';
  const untrackedStat =
    untrackedCount > 0 ? `${statText}${statText.endsWith('\n') ? '' : '\n'}+ untracked: ${untrackedCount} files, ${untrackedPatch.insertions} lines\n` : statText;
  const statTruncated = Buffer.byteLength(untrackedStat, 'utf8') > GIT_DIFF_STAT_MAX_BYTES;
  const evidence: GitEvidence = {
    dir,
    head: head.ok ? head.stdout.trim() || null : null,
    branch: branch.ok ? branch.stdout.trim() || null : null,
    files,
    ...(allFiles.length > GIT_FILES_LIMIT ? { files_truncated: true } : {}),
    diff_stat: statTruncated ? untrackedStat.slice(0, GIT_DIFF_STAT_MAX_BYTES) : untrackedStat,
    summary: {
      files_changed: counts.files,
      insertions: counts.insertions + untrackedPatch.insertions,
      deletions: counts.deletions,
      untracked: untrackedCount,
    },
    pre_existing_dirty: (baseline ?? []).length > 0,
    patch_path: patchPath,
    ...(patchTruncated ? { patch_truncated: true } : {}),
  };
  if (errors.length > 0) evidence.error = errors[0]!.slice(0, 300);
  return evidence;
}

const UNTRACKED_MAX_FILES = 50;
const UNTRACKED_FILE_MAX_BYTES = 256 * 1024;
const UNTRACKED_LINES_LIMIT = 4_000;

/** 把未跟踪文件渲染成 `new file` diff（有界）；二进制只记文件名。 */
async function buildUntrackedPatch(
  dir: string,
  files: Array<{ path: string }>,
  budget: number,
): Promise<{ patch: string; insertions: number; truncated: boolean }> {
  if (budget <= 0 || files.length === 0) return { patch: '', insertions: 0, truncated: files.length > 0 };
  let output = '';
  let insertions = 0;
  let truncated = false;
  for (const file of files.slice(0, UNTRACKED_MAX_FILES)) {
    if (Buffer.byteLength(output, 'utf8') >= budget - 256) {
      truncated = true;
      break;
    }
    let buffer: Buffer;
    try {
      buffer = await readFile(join(dir, file.path));
    } catch {
      continue;
    }
    if (buffer.includes(0)) {
      const binary = `diff --git a/${file.path} b/${file.path}\nBinary files /dev/null and b/${file.path} differ\n`;
      if (Buffer.byteLength(output + binary, 'utf8') <= budget) output += binary;
      else truncated = true;
      continue;
    }
    const text = buffer.subarray(0, UNTRACKED_FILE_MAX_BYTES).toString('utf8');
    const lines = text.split(/\r?\n/);
    if (lines[lines.length - 1] === '') lines.pop();
    const limited = lines.slice(0, UNTRACKED_LINES_LIMIT);
    const fileTruncated = lines.length > UNTRACKED_LINES_LIMIT || buffer.length > UNTRACKED_FILE_MAX_BYTES;
    const section = `diff --git a/${file.path} b/${file.path}\nnew file mode 100644\n--- /dev/null\n+++ b/${file.path}\n@@ -0,0 +1,${limited.length} @@\n${limited
      .map((line) => `+${line}`)
      .join('\n')}\n`;
    if (Buffer.byteLength(output + section, 'utf8') > budget) {
      truncated = true;
      break;
    }
    output += section;
    insertions += limited.length;
    if (fileTruncated) truncated = true;
  }
  return { patch: output ? `\n${output}` : '', insertions, truncated };
}
