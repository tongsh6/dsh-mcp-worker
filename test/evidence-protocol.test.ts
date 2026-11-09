import { describe, expect, it } from 'vitest';
import { TaskManager } from '../src/task-manager.js';
import type { RunEvent, RunOutcome } from '../src/types.js';
import { MemoryStore, makeRunOutcome, makeTestConfig, waitFor } from './helpers.js';

function makeEventRunner(finalText: string, events: RunEvent[], failed = false) {
  const runner = (input: Parameters<Parameters<typeof TaskManager>[0]['runner']>[0]) => {
    let resolve!: (outcome: RunOutcome) => void;
    const outcome = new Promise<RunOutcome>((resolvePromise) => {
      resolve = resolvePromise;
    });
    setTimeout(() => {
      for (const event of events) input.onEvent(event);
      resolve(makeRunOutcome(failed ? { exitCode: 1, finalText, errorMessage: 'boom' } : { exitCode: 0, finalText }));
    }, 5);
    return { pid: 1, cancel: () => resolve(makeRunOutcome({ cancelled: true })), outcome };
  };
  return runner;
}

const toolEvents: RunEvent[] = [
  { type: 'tool_call', tool: 'pwsh', call_id: 'c1', arguments: { command: 'pwsh -c "exit 3"' } },
  {
    type: 'tool_result',
    call_id: 'c1',
    message: { role: 'tool', toolCallId: 'c1', isError: false, content: [{ type: 'text', text: '[exit code: 3]' }] },
  },
  { type: 'tool_call', tool: 'str_replace_editor', call_id: 'c2', arguments: { command: 'create', path: 'a.txt' } },
  {
    type: 'tool_result',
    call_id: 'c2',
    message: { role: 'tool', toolCallId: 'c2', isError: false, content: [{ type: 'text', text: 'created' }] },
  },
  { type: 'text', text: '正在处理' },
];

describe('结构化证据 + 决策协议（TaskManager 集成）', () => {
  it('dsh_result.evidence 提取命令退出码/编辑；outcome=completed', async () => {
    const manager = new TaskManager({
      runner: makeEventRunner('完成', toolEvents),
      store: new MemoryStore(),
      config: makeTestConfig({ cleanupIntervalMs: 0, evidenceGit: false }),
    });
    await manager.init();
    const record = await manager.create({ task: 'evidence', cwd: 'C:\\proj' });
    await waitFor(() => manager.get(record.id)?.status === 'succeeded');
    const result = await manager.result(record.id);
    expect(result.outcome).toBe('completed');
    expect(result.evidence?.commands[0]).toMatchObject({ tool: 'pwsh', exit_code: 3 });
    expect(result.evidence?.edits[0]).toMatchObject({ path: 'a.txt', ops: { create: 1 } });
    expect(result.evidence?.summary.commands_failed).toBe(1);
    manager.stop();
  });

  it('[DSH:NEEDS_DECISION] → outcome=needs_decision，status 仍 succeeded，审计记录', async () => {
    const audits: Array<{ event: string }> = [];
    const manager = new TaskManager({
      runner: makeEventRunner('请确认\n[DSH:NEEDS_DECISION]\n文件名用 A 还是 B？', []),
      store: new MemoryStore(),
      config: makeTestConfig({ cleanupIntervalMs: 0, evidenceGit: false }),
      audit: (entry) => audits.push(entry),
    });
    await manager.init();
    const record = await manager.create({ task: 'decide', cwd: 'C:\\proj' });
    await waitFor(() => manager.get(record.id)?.status === 'succeeded');
    const result = await manager.result(record.id);
    expect(result.status).toBe('succeeded');
    expect(result.outcome).toBe('needs_decision');
    expect(result.decision_request).toContain('A 还是 B');
    expect(audits.some((entry) => entry.event === 'task_needs_decision')).toBe(true);
    manager.stop();
  });

  it('失败任务 outcome=failed 且仍有 evidence', async () => {
    const manager = new TaskManager({
      runner: makeEventRunner('失败', toolEvents, true),
      store: new MemoryStore(),
      config: makeTestConfig({ cleanupIntervalMs: 0, evidenceGit: false, retryTransient: false }),
    });
    await manager.init();
    const record = await manager.create({ task: 'fail', cwd: 'C:\\proj' });
    await waitFor(() => manager.get(record.id)?.status === 'failed');
    const result = await manager.result(record.id);
    expect(result.outcome).toBe('failed');
    expect(result.evidence?.commands_total).toBe(1);
    manager.stop();
  });

  it('dsh_status 默认 summary 不回 tool 事件，detail=events 恢复', async () => {
    const manager = new TaskManager({
      runner: makeEventRunner('完成', toolEvents),
      store: new MemoryStore(),
      config: makeTestConfig({ cleanupIntervalMs: 0, evidenceGit: false, statusDetail: 'summary' }),
    });
    await manager.init();
    const record = await manager.create({ task: 'status', cwd: 'C:\\proj' });
    await waitFor(() => manager.get(record.id)?.status === 'succeeded');
    const summary = await manager.status(record.id);
    expect(summary.events.some((event) => event.type === 'tool_call')).toBe(false);
    expect(summary.outcome).toBe('completed');
    expect(summary.last_text).toBe('完成');
    const full = await manager.status(record.id, { detail: 'events' });
    expect(full.events.some((event) => event.type === 'tool_call')).toBe(true);
    expect(full.next_cursor).toBe(summary.next_cursor);
    manager.stop();
  });
});
