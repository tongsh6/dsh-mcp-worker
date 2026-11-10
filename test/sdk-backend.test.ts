import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SdkBackend } from '../src/sdk-backend.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-sdk.js', import.meta.url));
const cleanup: Array<() => Promise<void>> = [];

async function makeEnv(): Promise<{ logPath: string; cwd: string; env: NodeJS.ProcessEnv }> {
  const dir = await mkdtemp(join(tmpdir(), 'fake-sdk-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  return {
    logPath: join(dir, 'sdk.log'),
    cwd: dir,
    // 避免子进程继承外层测试的 DSH 环境变量
    env: { ...process.env, FAKE_SDK_LOG: join(dir, 'sdk.log') },
  };
}

async function initializeCount(logPath: string): Promise<number> {
  const raw = await readFile(logPath, 'utf8').catch(() => '');
  return raw.split('\n').filter((line) => line === 'initialize').length;
}

function backendOptions(env: NodeJS.ProcessEnv, cwd: string) {
  return {
    spawn: { command: process.execPath, args: [FIXTURE] },
    profile: 'sdk',
    cwd,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    env,
  };
}

afterEach(async () => {
  // Windows 下被杀后端进程的文件句柄释放有延迟：先让出事件循环再带重试清理，避免偶发 EBUSY flake。
  await new Promise((resolve) => setTimeout(resolve, 100));
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

describe('SdkBackend（假 SDK 运行时）', () => {
  it('prompt 返回最终 assistant 文本与事件', async () => {
    const { logPath, cwd, env } = await makeEnv();
    const backend = await SdkBackend.start(backendOptions(env, cwd));
    const events: string[] = [];
    const outcome = await backend.prompt('s1', 'hello', (event) => events.push(event.type), 5_000);
    expect(outcome.reason).toBe('completed');
    expect(outcome.text).toBe('fake:hello');
    expect(events).toContain('text');
    expect(events).toContain('status');
    expect(await initializeCount(logPath)).toBe(1);
    await backend.shutdown();
  });

  it('同一后端下多个 session 复用一次 initialize', async () => {
    const { logPath, cwd, env } = await makeEnv();
    const backend = await SdkBackend.start(backendOptions(env, cwd));
    const first = await backend.prompt('s1', 'a', () => undefined, 5_000);
    const second = await backend.prompt('s2', 'b', () => undefined, 5_000);
    expect(first.text).toBe('fake:a');
    expect(second.text).toBe('fake:b');
    expect(await initializeCount(logPath)).toBe(1);
    await backend.shutdown();
  });

  it('多段 assistant 消息取最后一段，并记录多个 step', async () => {
    const { cwd, env } = await makeEnv();
    const backend = await SdkBackend.start(backendOptions(env, cwd));
    const steps: unknown[] = [];
    const outcome = await backend.prompt('s1', 'MULTI', (event) => {
      if (event.type === 'status' && event.phase === 'step_end') steps.push(event.step);
    }, 5_000);
    expect(outcome.text).toBe('part-2');
    expect(steps).toEqual([1, 2]);
    await backend.shutdown();
  });

  it('turn/end=error 时返回失败原因', async () => {
    const { cwd, env } = await makeEnv();
    const backend = await SdkBackend.start(backendOptions(env, cwd));
    const outcome = await backend.prompt('s1', 'FAIL', () => undefined, 5_000);
    expect(outcome.reason).toBe('error');
    expect(outcome.text).toBeNull();
    await backend.shutdown();
  });

  it('取消会杀掉后端并把结果标记 cancelled', async () => {
    const { cwd, env } = await makeEnv();
    const backend = await SdkBackend.start(backendOptions(env, cwd));
    const pending = backend.prompt('s1', 'HANG', () => undefined, 60_000);
    setTimeout(() => backend.cancel(), 50);
    const outcome = await pending;
    expect(outcome.cancelled).toBe(true);
    expect(backend.isClosed).toBe(true);
  });

  it('超时会杀掉后端并标记 timedOut', async () => {
    const { cwd, env } = await makeEnv();
    const backend = await SdkBackend.start(backendOptions(env, cwd));
    const outcome = await backend.prompt('s1', 'HANG', () => undefined, 200);
    expect(outcome.timedOut).toBe(true);
    expect(backend.isClosed).toBe(true);
  });

  it('sdk 工具事件映射：tool/name/arguments/call_id 正确（回归 tool=unknown）', async () => {
    const { cwd, env } = await makeEnv();
    const backend = await SdkBackend.start(backendOptions(env, cwd));
    const events: Array<Record<string, unknown>> = [];
    await backend.prompt('s1', 'TOOLS', (event) => events.push(event as Record<string, unknown>), 5_000);
    const call = events.find((event) => event.type === 'tool_call' && event.tool === 'pwsh');
    expect(call).toBeTruthy();
    expect(call?.call_id).toBe('c1');
    expect((call?.arguments as { command?: string } | undefined)?.command).toContain('exit 3');
    const result = events.find((event) => event.type === 'tool_result' && event.call_id === 'c1');
    expect(result).toBeTruthy();
    expect(events.some((event) => event.type === 'tool_call' && event.tool === 'str_replace_editor')).toBe(true);
    expect(events.some((event) => event.tool === 'unknown')).toBe(false);
    await backend.shutdown();
  });
});
