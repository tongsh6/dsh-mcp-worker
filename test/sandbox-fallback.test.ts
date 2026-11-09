import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskManager } from '../src/task-manager.js';
import { CwdCapabilityStore } from '../src/capability-store.js';
import type { RunOutcome } from '../src/types.js';
import { MemoryStore, makeRunOutcome, makeTestConfig, waitFor } from './helpers.js';

const ACL_ERROR =
  'SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\\work\\repo)：拒绝访问。（沙箱初始化失败，pwsh 未启动）';

/** 第一次按 workspace-write 返回 ACL 失败，第二次（read-only）成功。 */
function makeAclFallbackRunner(modes: string[], firstOutcome: () => RunOutcome, attempts: number[] = []) {
  return (input: Parameters<Parameters<typeof TaskManager>[0]['runner']>[0]) => {
    modes.push(input.permissionMode);
    attempts.push(input.attempt ?? 1);
    let resolve!: (outcome: RunOutcome) => void;
    const outcome = new Promise<RunOutcome>((r) => {
      resolve = r;
    });
    setTimeout(() => {
      if (modes.length === 1) {
        const outcome = firstOutcome();
        for (const event of outcome.events) input.onEvent(event);
        resolve(outcome);
        return;
      }
      input.onEvent({ type: 'final', text: 'read-only-ok' });
      resolve(makeRunOutcome({ finalText: 'read-only-ok' }));
    }, 5);
    return { pid: 1, cancel: () => resolve(makeRunOutcome({ cancelled: true })), outcome };
  };
}

describe('沙箱 ACL 失败自动降级', () => {
  it('workspace-write 遇 ACL 授权失败时，自动用 read-only 重试并记录', async () => {
    const modes: string[] = [];
    const attempts: number[] = [];
    const config = makeTestConfig({ cleanupIntervalMs: 0 });
    const manager = new TaskManager({
      runner: makeAclFallbackRunner(modes, () => makeRunOutcome({ exitCode: 1, errorMessage: ACL_ERROR }), attempts),
      store: new MemoryStore(),
      config,
    });
    await manager.init();
    const record = await manager.create({ task: 'acl', cwd: 'D:\\work\\repo' });
    await waitFor(() => manager.get(record.id)?.status === 'succeeded');
    const result = await manager.result(record.id);
    expect(modes).toEqual(['workspace-write', 'read-only']);
    expect(attempts).toEqual([1, 2]);
    expect(result.status).toBe('succeeded');
    expect(result.output).toBe('read-only-ok');
    expect(result.sandbox_fallback).toMatchObject({ from: 'workspace-write', to: 'read-only' });
    expect(result.events_count).toBeGreaterThan(0);
    manager.stop();
  });

  it('DSH_MCP_ACL_FALLBACK=off 时不降级，并给出可操作提示', async () => {
    const modes: string[] = [];
    const config = makeTestConfig({ cleanupIntervalMs: 0, aclFallback: 'off' });
    const manager = new TaskManager({
      runner: makeAclFallbackRunner(modes, () => makeRunOutcome({ exitCode: 1, errorMessage: ACL_ERROR })),
      store: new MemoryStore(),
      config,
    });
    await manager.init();
    const record = await manager.create({ task: 'acl', cwd: 'D:\\work\\repo' });
    await waitFor(() => manager.get(record.id)?.status === 'failed');
    const result = await manager.result(record.id);
    expect(modes).toEqual(['workspace-write']);
    expect(result.sandbox_fallback).toBeNull();
    expect(result.error).toContain('icacls');
    manager.stop();
  });

  it('普通业务失败不触发降级', async () => {
    const modes: string[] = [];
    const config = makeTestConfig({ cleanupIntervalMs: 0 });
    const manager = new TaskManager({
      runner: makeAclFallbackRunner(modes, () => makeRunOutcome({ exitCode: 1, errorMessage: '3 tests failed' })),
      store: new MemoryStore(),
      config,
    });
    await manager.init();
    const record = await manager.create({ task: 'biz', cwd: 'D:\\work\\repo' });
    await waitFor(() => manager.get(record.id)?.status === 'failed');
    expect(modes).toEqual(['workspace-write']);
    manager.stop();
  });

  it('回合成功但工具结果真实报错（isError）含 ACL 失败时触发降级', async () => {
    const modes: string[] = [];
    const config = makeTestConfig({ cleanupIntervalMs: 0 });
    const aclOutcome = () =>
      makeRunOutcome({
        exitCode: 0,
        finalText: 'pwsh 未能执行（沙箱初始化失败）',
        events: [
          {
            type: 'tool_result',
            message: {
              role: 'tool',
              isError: true,
              content: [{ type: 'text', text: 'SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\\work\\repo)' }],
            },
          },
        ],
      });
    const manager = new TaskManager({
      runner: makeAclFallbackRunner(modes, aclOutcome),
      store: new MemoryStore(),
      config,
    });
    await manager.init();
    const record = await manager.create({ task: 'acl-blocked-but-turn-ok', cwd: 'D:\\work\\repo' });
    await waitFor(() => manager.get(record.id)?.status === 'succeeded');
    const result = await manager.result(record.id);
    expect(modes).toEqual(['workspace-write', 'read-only']);
    expect(result.sandbox_fallback).toMatchObject({ from: 'workspace-write', to: 'read-only' });
    manager.stop();
  });

  it('read-only 任务里引用 ACL 错误文本不会被误判失败', async () => {
    const modes: string[] = [];
    const config = makeTestConfig({ cleanupIntervalMs: 0 });
    const readOnlyOutcome = () =>
      makeRunOutcome({
        exitCode: 0,
        finalText: '完整报告：...历史记录里提到 SetNamedSecurityInfoW failed (Win32 5)...',
        events: [
          {
            type: 'tool_result',
            message: {
              role: 'tool',
              isError: true,
              content: [{ type: 'text', text: 'SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\\work\\repo)' }],
            },
          },
          { type: 'text', text: '分析完成' },
        ],
      });
    const manager = new TaskManager({
      runner: makeAclFallbackRunner(modes, readOnlyOutcome),
      store: new MemoryStore(),
      config,
    });
    await manager.init();
    const record = await manager.create({ task: 'read-only analysis', cwd: 'D:\\work\\repo', permissionMode: 'read-only' });
    await waitFor(() => manager.get(record.id)?.status === 'succeeded');
    const result = await manager.result(record.id);
    expect(modes).toEqual(['read-only']);
    expect(result.status).toBe('succeeded');
    expect(result.sandbox_fallback).toBeNull();
    manager.stop();
  });

  it('ACL 失败自动升级到 danger-full-access（B 方案）', async () => {
    const modes: string[] = [];
    const config = makeTestConfig({ cleanupIntervalMs: 0, aclFallback: 'danger-full-access' });
    const manager = new TaskManager({
      runner: makeAclFallbackRunner(modes, () => makeRunOutcome({ exitCode: 1, errorMessage: ACL_ERROR })),
      store: new MemoryStore(),
      config,
    });
    await manager.init();
    const record = await manager.create({ task: 'upgrade-to-full', cwd: 'D:\\work\\repo' });
    await waitFor(() => manager.get(record.id)?.status === 'succeeded');
    const result = await manager.result(record.id);
    expect(modes).toEqual(['workspace-write', 'danger-full-access']);
    expect(result.sandbox_fallback).toMatchObject({ from: 'workspace-write', to: 'danger-full-access' });
    expect(result.effective_permission_mode).toBe('danger-full-access');
    manager.stop();
  });

  it('danger-full-access 降级后同 cwd 第二次直接使用 full（能力缓存落盘）', async () => {
    const modes: string[] = [];
    const dshHome = await mkdtemp(join(tmpdir(), 'cap-home-'));
    try {
      const config = makeTestConfig({
        cleanupIntervalMs: 0,
        aclFallback: 'danger-full-access',
        capabilityStore: true,
        dshHome,
      });
      const manager = new TaskManager({
        runner: makeAclFallbackRunner(modes, () => makeRunOutcome({ exitCode: 1, errorMessage: ACL_ERROR })),
        store: new MemoryStore(),
        config,
      });
      await manager.init();
      const first = await manager.create({ task: 'first', cwd: 'D:\\work\\repo' });
      await waitFor(() => manager.get(first.id)?.status === 'succeeded');
      const second = await manager.create({ task: 'second', cwd: 'D:\\work\\repo' });
      await waitFor(() => manager.get(second.id)?.status === 'succeeded');
      expect(modes).toEqual(['workspace-write', 'danger-full-access', 'danger-full-access']);
      const secondResult = await manager.result(second.id);
      expect(secondResult.sandbox_fallback?.reason).toContain('cached-capability');
      expect(secondResult.effective_permission_mode).toBe('danger-full-access');
      manager.stop();
    } finally {
      await rm(dshHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
    }
  });

  it('aclFallback=off 且已知 cwd 不可写时快速失败（A5）', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'cap-home-'));
    try {
      const capabilityFile = join(dshHome, 'mcp-cwd-capabilities.json');
      const seed = new CwdCapabilityStore(capabilityFile, 60_000);
      await seed.init();
      await seed.set('D:\\work\\repo', 'danger-full-access', 'ACL denied');
      await seed.dispose();
      const config = makeTestConfig({ cleanupIntervalMs: 0, aclFallback: 'off', capabilityStore: true, dshHome });
      const manager = new TaskManager({
        runner: makeAclFallbackRunner([], () => makeRunOutcome({ finalText: 'never' })),
        store: new MemoryStore(),
        config,
      });
      await manager.init();
      await expect(manager.create({ task: 'write', cwd: 'D:\\work\\repo' })).rejects.toMatchObject({
        code: 'cwd_not_writable',
      });
      manager.stop();
    } finally {
      await rm(dshHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
    }
  });
});
