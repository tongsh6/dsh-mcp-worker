import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { resolveRepoRoot } from '../src/repo-root.js';

const execFileAsync = promisify(execFile);
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await Promise.resolve(fn()).catch(() => undefined);
});

/** 在指定目录执行 git（真实临时仓库，不做 mock）。 */
async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', ['-C', cwd, ...args], { windowsHide: true });
}

/** 创建真实临时 git 仓库（含一次提交），返回临时父目录与仓库根。 */
async function initRepo(): Promise<{ base: string; repo: string }> {
  const base = await mkdtemp(join(tmpdir(), 'repo-root-'));
  cleanups.push(() => rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const repo = join(base, 'repo');
  await mkdir(repo, { recursive: true });
  await git(repo, ['init', '-q']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'test']);
  await writeFile(join(repo, 'a.txt'), 'hello', 'utf8');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-q', '-m', 'init']);
  return { base, repo };
}

/** 创建非 git 的临时目录。 */
async function initPlainDir(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'repo-root-plain-'));
  cleanups.push(() => rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  return base;
}

/** Windows 下盘符与路径分隔符大小写不敏感，比较前统一 resolve + 小写。 */
function samePath(actual: string | null, expected: string): boolean {
  return typeof actual === 'string' && resolve(actual).toLowerCase() === resolve(expected).toLowerCase();
}

/** 构造一个确定不存在的临时路径（不创建）。 */
function missingPath(): string {
  return join(tmpdir(), `repo-root-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe('resolveRepoRoot', () => {
  it('仓库根目录 → 返回仓库根（绝对路径）', async () => {
    const { repo } = await initRepo();

    const root = await resolveRepoRoot(repo);

    expect(root).not.toBeNull();
    expect(isAbsolute(root as string)).toBe(true);
    expect(samePath(root, repo)).toBe(true);
  });

  it('仓库子目录 → 仍返回仓库根', async () => {
    const { repo } = await initRepo();
    const nested = join(repo, 'packages', 'deep', 'nested');
    await mkdir(nested, { recursive: true });

    const root = await resolveRepoRoot(nested);

    expect(samePath(root, repo)).toBe(true);
  });

  it('非 git 的临时目录 → null', async () => {
    const plain = await initPlainDir();

    expect(await resolveRepoRoot(plain)).toBeNull();
  });

  it('不存在的路径 → null 且快速返回（不进 git 进程）', async () => {
    const startedAt = performance.now();
    for (let i = 0; i < 20; i += 1) {
      expect(await resolveRepoRoot(missingPath())).toBeNull();
    }
    // 单次 git 调用通常就要几十毫秒，20 次仍 <1s 说明存在性检查短路生效
    expect(performance.now() - startedAt).toBeLessThan(1000);
  });

  it('存在但不是目录（普通文件）→ null', async () => {
    const plain = await initPlainDir();
    const file = join(plain, 'not-a-dir.txt');
    await writeFile(file, 'x', 'utf8');

    expect(await resolveRepoRoot(file)).toBeNull();
  });

  it('返回路径已 resolve 规范化（传入含 .. 的路径）', async () => {
    const { repo } = await initRepo();
    const sub = join(repo, 'sub');
    await mkdir(sub, { recursive: true });

    const root = await resolveRepoRoot(join(sub, '..'));

    expect(root).not.toBeNull();
    expect(isAbsolute(root as string)).toBe(true);
    // 已规范化：再 resolve 一次不改变结果（无 ..、无尾部分隔符）
    expect(root).toBe(resolve(root as string));
    expect(samePath(root, repo)).toBe(true);
  });

  it('不抛异常：空字符串 / 相对路径形式的不存在目录均返回 null', async () => {
    await expect(resolveRepoRoot('')).resolves.toBeNull();
    await expect(resolveRepoRoot(join('definitely', 'missing', 'dir'))).resolves.toBeNull();
  });
});
