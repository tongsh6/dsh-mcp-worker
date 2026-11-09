import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SdkBackendPool } from '../src/sdk-pool.js';
import { createSdkRunner } from '../src/sdk-runner.js';
import { TaskManager } from '../src/task-manager.js';
import type { TaskRecord } from '../src/types.js';
import { MemoryStore, makeTestConfig, waitFor } from './helpers.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-sdk.js', import.meta.url));
const cleanup: Array<() => Promise<void>> = [];

function isTerminal(record: TaskRecord | undefined): boolean {
  return !!record && ['succeeded', 'failed', 'cancelled'].includes(record.status);
}

async function initializeCount(logPath: string): Promise<number> {
  const raw = await readFile(logPath, 'utf8').catch(() => '');
  return raw.split('\n').filter((line) => line === 'initialize').length;
}

async function setup(extraEnv: Record<string, string> = {}, poolOverrides: { idleMs?: number; sweepIntervalMs?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'sdk-runner-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const logPath = join(dir, 'sdk.log');
  const pool = new SdkBackendPool({
    spawn: { command: process.execPath, args: [FIXTURE] },
    profile: 'sdk',
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    idleMs: poolOverrides.idleMs ?? 60_000,
    ...(poolOverrides.sweepIntervalMs !== undefined ? { sweepIntervalMs: poolOverrides.sweepIntervalMs } : {}),
    initTimeoutMs: 30_000,
    env: { ...process.env, FAKE_SDK_LOG: logPath, ...extraEnv },
  });
  cleanup.push(() => pool.shutdown());
  const config = makeTestConfig({ backend: 'sdk', defaultTimeoutMs: 5_000, maxConcurrent: 2 });
  const manager = new TaskManager({ runner: createSdkRunner(pool), store: new MemoryStore(), config });
  await manager.init();
  return { dir, logPath, pool, manager };
}

afterEach(async () => {
  // 先释放池（关子进程），再删目录
  const fns = cleanup.splice(0).reverse();
  for (const fn of fns) await fn().catch(() => undefined);
});

describe('composedSdkRunner（M1 长驻后端）', () => {
  it('任务成功且返回最终文本，只 initialize 一次', async () => {
    const { dir, logPath, manager } = await setup();
    const record = await manager.create({ task: 'hello', cwd: dir });
    await waitFor(() => isTerminal(manager.get(record.id)));
    const result = await manager.result(record.id);
    expect(result.status).toBe('succeeded');
    expect(result.output).toBe('fake:hello');
    expect(result.usage.tokens).toMatchObject({ inputTokens: 12, outputTokens: 8, totalTokens: 20 });
    expect(await initializeCount(logPath)).toBe(1);
  });

  it('第二个任务复用同一后端（不再 initialize）', async () => {
    const { dir, logPath, manager } = await setup();
    const first = await manager.create({ task: 'a', cwd: dir });
    await waitFor(() => isTerminal(manager.get(first.id)));
    const second = await manager.create({ task: 'b', cwd: dir });
    await waitFor(() => isTerminal(manager.get(second.id)));
    expect((await manager.result(first.id)).output).toBe('fake:a');
    expect((await manager.result(second.id)).output).toBe('fake:b');
    expect(await initializeCount(logPath)).toBe(1);
  });

  it('取消运行中的任务，随后新任务会重建后端', async () => {
    const { dir, logPath, manager } = await setup();
    const hang = await manager.create({ task: 'HANG', cwd: dir, timeoutMs: 60_000 });
    await waitFor(() => manager.get(hang.id)?.status === 'running');
    const cancelled = await manager.cancel(hang.id);
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.status).toBe('cancelled');

    const next = await manager.create({ task: 'after-cancel', cwd: dir });
    await waitFor(() => isTerminal(manager.get(next.id)));
    expect((await manager.result(next.id)).output).toBe('fake:after-cancel');
    expect(await initializeCount(logPath)).toBe(2);
  });

  it('长时间运行的任务不会被空闲回收杀掉', async () => {
    const { dir, manager } = await setup({}, { idleMs: 150, sweepIntervalMs: 40 });
    const record = await manager.create({ task: 'HANG', cwd: dir, timeoutMs: 60_000 });
    await waitFor(() => manager.get(record.id)?.status === 'running');
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(manager.get(record.id)?.status).toBe('running');
    await manager.cancel(record.id);
  });

  it('续聊 session 已存在时自动换新 session id 重试', async () => {
    const { dir, manager } = await setup({ FAKE_SDK_REJECT_SESSION: 'mcp-prev-session' });
    const record = await manager.create({ task: 'continue-work', cwd: dir, sessionId: 'mcp-prev-session' });
    await waitFor(() => isTerminal(manager.get(record.id)));
    const result = await manager.result(record.id);
    expect(result.status).toBe('succeeded');
    expect(result.error).toBeNull();
    expect(result.output).toBe('fake:continue-work');
    const events = manager.get(record.id)?.events ?? [];
    expect(events.some((event) => event.type === 'status' && event.phase === 'session_resume_fallback')).toBe(true);
    expect(
      events.some((event) => event.type === 'session' && String(event.sessionId ?? '').includes('resume')),
    ).toBe(true);
  });
});
