import { execFile } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface WorktreeCleanupOptions {
  tasksDir: string;
  worktreeRoot: string;
  ttlMs: number;
  now: number;
}

export interface WorktreeCleanupResult {
  removed: string[];
  pruned: string[];
  failed: Array<{ path: string; error: string }>;
  skipped: string[];
}

/** 任务终态：只有这些状态的任务，其 worktree 才允许被清理。 */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['succeeded', 'failed', 'cancelled']);

/** 所有 git 子进程统一使用的执行参数（禁止弹窗、限制超时与输出体积）。 */
const GIT_EXEC_OPTIONS = {
  timeout: 20_000,
  windowsHide: true,
  maxBuffer: 4 * 1024 * 1024,
} as const;

/** 落盘 meta.json 中清理逻辑关心的字段；属于外部数据，读取时逐项校验。 */
interface TaskMetaJson {
  status?: unknown;
  endedAt?: unknown;
  worktree?: unknown;
  originalCwd?: unknown;
}

type GitResult = { ok: true; stdout: string } | { ok: false; error: string };

/** 把 execFile 抛出的错误压成可读文本（保留 git stderr 原文）。 */
function describeGitError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const stderrField = (error as { stderr?: unknown }).stderr;
  const stderr = typeof stderrField === 'string' ? stderrField.trim() : '';
  const message = error.message || String(error);
  const text = stderr && !message.includes(stderr) ? `${message}: ${stderr}` : message;
  return text.length > 2_000 ? `${text.slice(0, 2_000)}...` : text;
}

/** 执行 git 命令；失败时返回错误文本而不是抛出，便于按条记录 failed。 */
async function git(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], GIT_EXEC_OPTIONS);
    return { ok: true, stdout: String(stdout) };
  } catch (error) {
    return { ok: false, error: describeGitError(error) };
  }
}

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/**
 * 路径比较基准：先解析成绝对路径；Windows 下再做大小写折叠。
 * 大小写不敏感是 Windows 文件系统的现实，否则 D:\Root 与 d:\root 会被误判为「root 外」。
 */
function normalizeForCompare(path: string): string {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

/** 候选路径是否真的位于 root 目录内部（含路径边界；root 自身与 root 外一律为 false）。 */
function isInsideDirectory(root: string, candidate: string): boolean {
  const rel = relative(normalizeForCompare(root), normalizeForCompare(candidate));
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

/** 从 meta.worktree.path 取候选路径；字段缺失或类型不对时返回 null。 */
function worktreePathOf(meta: TaskMetaJson): string | null {
  const worktree = meta.worktree;
  if (!worktree || typeof worktree !== 'object') return null;
  const path = (worktree as { path?: unknown }).path;
  return typeof path === 'string' && path.trim().length > 0 ? path : null;
}

/** 该任务是否满足清理条件：终态、已到期、且 worktree 位于 worktreeRoot 内。 */
function isCleanupCandidate(
  meta: TaskMetaJson,
  worktreePath: string,
  worktreeRoot: string,
  options: WorktreeCleanupOptions,
): boolean {
  if (typeof meta.status !== 'string' || !TERMINAL_STATUSES.has(meta.status)) return false;
  if (typeof meta.endedAt !== 'number' || !Number.isFinite(meta.endedAt)) return false;
  if (!(options.now - meta.endedAt > options.ttlMs)) return false;
  return isInsideDirectory(worktreeRoot, worktreePath);
}

/**
 * 解析 worktree 所属仓库根目录：
 *   1. meta.originalCwd 存在 → `git -C <originalCwd> rev-parse --show-toplevel`；
 *   2. 否则 → `git -C <worktreePath> rev-parse --git-common-dir`，取 git 公共目录的父目录。
 * 解析失败返回 null（调用方记 failed，不崩溃）。
 */
async function resolveRepoRoot(meta: TaskMetaJson, worktreePath: string): Promise<string | null> {
  if (typeof meta.originalCwd === 'string' && meta.originalCwd.trim().length > 0) {
    const toplevel = await git(meta.originalCwd, ['rev-parse', '--show-toplevel']);
    if (toplevel.ok) {
      const root = toplevel.stdout.trim();
      if (root.length > 0) return resolve(root);
    }
  }
  const common = await git(worktreePath, ['rev-parse', '--git-common-dir']);
  if (!common.ok) return null;
  const commonDir = common.stdout.trim();
  if (commonDir.length === 0) return null;
  // 主工作树下该输出可能是相对路径（.git），因此按 worktreePath 解析后再取父目录。
  return dirname(resolve(worktreePath, commonDir));
}

/** 读取 tasksDir 下所有任务的 meta.json；目录不存在或单个文件损坏都不算错误。 */
async function readTaskMetas(tasksDir: string): Promise<TaskMetaJson[]> {
  const entries = await readdir(tasksDir, { withFileTypes: true }).catch(() => []);
  const metas: TaskMetaJson[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = await readFile(join(tasksDir, entry.name, 'meta.json'), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') metas.push(parsed as TaskMetaJson);
    } catch {
      // meta.json 缺失或损坏：跳过该任务目录，不影响其他任务的清理。
    }
  }
  return metas;
}

/** 清理单个候选 worktree：目录还在就 git worktree remove，已不存在就 prune。 */
async function cleanupWorktree(
  meta: TaskMetaJson,
  worktreePath: string,
  result: WorktreeCleanupResult,
): Promise<void> {
  const repoRoot = await resolveRepoRoot(meta, worktreePath);
  if (repoRoot === null) {
    result.failed.push({
      path: worktreePath,
      error: `cannot resolve git repository root for worktree: ${worktreePath}`,
    });
    return;
  }
  if (!(await pathExists(worktreePath))) {
    // 目录已被人工删除：只需让 git 忘掉这条 worktree 记录。
    const pruned = await git(repoRoot, ['worktree', 'prune']);
    if (pruned.ok) result.pruned.push(worktreePath);
    else result.failed.push({ path: worktreePath, error: pruned.error });
    return;
  }
  const removed = await git(repoRoot, ['worktree', 'remove', '--force', worktreePath]);
  if (removed.ok) result.removed.push(worktreePath);
  else result.failed.push({ path: worktreePath, error: removed.error });
}

/**
 * 清理已过期任务的 worktree：扫描 tasksDir 下各任务目录的 meta.json，删除超过 ttlMs 的终态任务
 * 在 worktreeRoot 内的 worktree。只通过 git worktree remove/prune 操作，绝不直接 rm 目录，
 * 也不修改 meta.json。失败按条记录，不抛错。
 */
export async function cleanupStaleWorktrees(
  options: WorktreeCleanupOptions,
): Promise<WorktreeCleanupResult> {
  const result: WorktreeCleanupResult = { removed: [], pruned: [], failed: [], skipped: [] };
  const worktreeRoot = resolve(options.worktreeRoot);
  for (const meta of await readTaskMetas(options.tasksDir)) {
    const rawPath = worktreePathOf(meta);
    if (rawPath === null) continue;
    const worktreePath = resolve(rawPath);
    if (!isCleanupCandidate(meta, worktreePath, worktreeRoot, options)) {
      // 记录被跳过的候选路径（尤其是 root 外路径），便于排查「为什么不删」与防误删审计。
      result.skipped.push(worktreePath);
      continue;
    }
    await cleanupWorktree(meta, worktreePath, result);
  }
  return result;
}
