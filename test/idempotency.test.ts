import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IdempotencyStore } from '../src/idempotency.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn().catch(() => undefined);
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'idem-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return dir;
}

describe('IdempotencyStore', () => {
  it('remember 后命中，且跨实例可读（落盘）', async () => {
    const dir = await tempDir();
    const first = new IdempotencyStore(dir, 60_000);
    await first.init();
    await first.remember('key-a', 'task-1');
    expect(await first.lookup('key-a')).toBe('task-1');

    const second = new IdempotencyStore(dir, 60_000);
    expect(await second.lookup('key-a')).toBe('task-1');
  });

  it('不同 key 互不影响', async () => {
    const dir = await tempDir();
    const store = new IdempotencyStore(dir, 60_000);
    await store.remember('a', 'task-a');
    await store.remember('b', 'task-b');
    expect(await store.lookup('a')).toBe('task-a');
    expect(await store.lookup('b')).toBe('task-b');
    expect(await store.lookup('c')).toBeNull();
  });

  it('超过 TTL 后失效并清理文件', async () => {
    const dir = await tempDir();
    let now = 1_000;
    const store = new IdempotencyStore(dir, 100, () => now);
    await store.remember('k', 'task-k');
    now = 1_050;
    expect(await store.lookup('k')).toBe('task-k');
    now = 1_101;
    expect(await store.lookup('k')).toBeNull();
  });

  it('forget 删除索引', async () => {
    const dir = await tempDir();
    const store = new IdempotencyStore(dir, 60_000);
    await store.remember('k', 'task-k');
    await store.forget('k');
    expect(await store.lookup('k')).toBeNull();
  });

  it('目录不存在时 lookup 返回 null（不抛错）', async () => {
    const dir = await tempDir();
    const store = new IdempotencyStore(join(dir, 'missing', 'nested'), 60_000);
    expect(await store.lookup('x')).toBeNull();
  });

  it('ttl=0 表示永不过期，prune 不做清理', async () => {
    const dir = await tempDir();
    const store = new IdempotencyStore(dir, 0);
    await store.remember('k', 'task-k');
    expect(await store.prune()).toBe(0);
    expect(await store.lookup('k')).toBe('task-k');
  });
});
