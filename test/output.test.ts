import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { boundText } from '../src/output.js';

const dirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-output-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('boundText', () => {
  it('不超限时原样返回', async () => {
    const dir = await makeTmpDir();
    const result = await boundText('hello', { maxChars: 100, spillDir: dir, taskId: 't1' });
    expect(result.spilled).toBe(false);
    expect(result.text).toBe('hello');
    expect(result.path).toBeUndefined();
  });

  it('超限时落盘并返回摘要 + 路径', async () => {
    const dir = await makeTmpDir();
    const text = 'x'.repeat(500) + 'END';
    const result = await boundText(text, { maxChars: 100, spillDir: dir, taskId: 't1' });
    expect(result.spilled).toBe(true);
    expect(result.originalChars).toBe(text.length);
    expect(result.path).toBeTruthy();
    expect(result.text).toContain('truncated');
    expect(result.text).toContain(result.path!);
    // 落盘内容必须完整无损
    expect(await readFile(result.path!, 'utf8')).toBe(text);
  });

  it('同一任务重复落盘会覆盖而不是追加', async () => {
    const dir = await makeTmpDir();
    const first = await boundText('a'.repeat(200), { maxChars: 50, spillDir: dir, taskId: 't1' });
    const second = await boundText('b'.repeat(200), { maxChars: 50, spillDir: dir, taskId: 't1' });
    expect(first.path).toBe(second.path);
    expect(await readFile(second.path!, 'utf8')).toBe('b'.repeat(200));
  });
});
