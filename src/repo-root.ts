import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** git 调用超时：解析仓库根只是轻量查询，超时即视为不可用。 */
const GIT_TIMEOUT_MS = 5_000;
/** git 输出上限：--show-toplevel 只有一行，1MB 足够。 */
const GIT_MAX_BUFFER = 1024 * 1024;

/** cwd 是否为已存在的目录（同步、快速，避免对假路径白白启动 git 进程）。 */
function isExistingDirectory(cwd: string): boolean {
  if (cwd.length === 0) return false;
  if (!existsSync(cwd)) return false;
  try {
    return statSync(cwd).isDirectory();
  } catch {
    return false;
  }
}

/** 解析 cwd 所属 git 仓库根目录；非 git/不存在/git 不可用时返回 null（调用方回退 cwd）。 */
export async function resolveRepoRoot(cwd: string): Promise<string | null> {
  // 不存在/不是目录：直接返回 null，不启动 git 进程（测试里假路径很多）
  if (!isExistingDirectory(cwd)) return null;
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: GIT_MAX_BUFFER,
    });
    const repoRoot = String(stdout).trim();
    return repoRoot ? resolve(repoRoot) : null;
  } catch {
    // 非 git 仓库（exit≠0）、git 缺失（ENOENT）、超时等一律回退
    return null;
  }
}
