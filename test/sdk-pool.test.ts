import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SdkBackendPool } from '../src/sdk-pool.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-sdk.js', import.meta.url));
const cleanup: Array<() => Promise<void>> = [];

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'sdk-pool-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const logPath = join(dir, 'sdk.log');
  const pool = new SdkBackendPool({
    spawn: { command: process.execPath, args: [FIXTURE] },
    profile: 'sdk',
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    idleMs: 60_000,
    initTimeoutMs: 30_000,
    env: { ...process.env, FAKE_SDK_LOG: logPath },
  });
  cleanup.push(() => pool.shutdown());
  return { dir, logPath, pool };
}

async function initializeCount(logPath: string): Promise<number> {
  const raw = await readFile(logPath, 'utf8').catch(() => '');
  return raw.split('\n').filter((line) => line === 'initialize').length;
}

afterEach(async () => {
  const fns = cleanup.splice(0).reverse();
  for (const fn of fns) await fn().catch(() => undefined);
});

describe('SdkBackendPool', () => {
  it('同 cwd + 同权限模式复用同一个后端', async () => {
    const { dir, logPath, pool } = await setup();
    const first = await pool.acquire(dir, 'workspace-write');
    const second = await pool.acquire(dir, 'workspace-write');
    expect(second).toBe(first);
    expect(await initializeCount(logPath)).toBe(1);
    expect(pool.stats().active).toBe(1);
  });

  it('同 cwd + 不同权限模式是不同后端（权限随进程）', async () => {
    const { dir, logPath, pool } = await setup();
    const writable = await pool.acquire(dir, 'workspace-write');
    const readonly = await pool.acquire(dir, 'read-only');
    expect(readonly).not.toBe(writable);
    expect(await initializeCount(logPath)).toBe(2);
    expect(pool.stats().active).toBe(2);
  });

  it('shutdown 后池清空', async () => {
    const { dir, pool } = await setup();
    const backend = await pool.acquire(dir);
    expect(pool.stats().active).toBe(1);
    await pool.shutdown();
    expect(backend.isClosed).toBe(true);
    expect(pool.stats().active).toBe(0);
  });
});
