import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CwdCapabilityStore } from '../src/capability-store.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn().catch(() => undefined);
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cap-store-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

describe('CwdCapabilityStore', () => {
  it('set/get 并跨实例持久化', async () => {
    const dir = await tempDir();
    const file = join(dir, 'capabilities.json');
    const first = new CwdCapabilityStore(file, 60_000);
    await first.init();
    await first.set('D:\\work\\repo\\', 'danger-full-access', 'ACL deny');
    expect(first.get('D:\\work\\repo')?.mode).toBe('danger-full-access');
    await first.dispose();

    const second = new CwdCapabilityStore(file, 60_000);
    await second.init();
    expect(second.get('d:\\WORK\\repo')?.mode).toBe('danger-full-access');
    await second.dispose();
  });

  it('超过 TTL 的条目失效', async () => {
    const dir = await tempDir();
    let now = 1_000;
    const store = new CwdCapabilityStore(join(dir, 'capabilities.json'), 100, () => now);
    await store.init();
    await store.set('C:\\proj', 'workspace-write');
    now = 1_050;
    expect(store.get('C:\\proj')?.mode).toBe('workspace-write');
    now = 1_101;
    expect(store.get('C:\\proj')).toBeNull();
  });
});
