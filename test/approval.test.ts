import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { detectApprovalRequired } from '../src/approval.js';
import { createWorkerServer } from '../src/server.js';
import { TaskManager, type TaskRunInput } from '../src/task-manager.js';
import type { RunOutcome } from '../src/types.js';
import { MemoryStore, makeRunOutcome, makeTestConfig, waitFor } from './helpers.js';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  const fns = cleanups.splice(0).reverse();
  for (const fn of fns) await Promise.resolve(fn()).catch(() => undefined);
});

/** 第一次（workspace-write）因缺少审批失败；被授权后（danger-full-access）成功。 */
function makeApprovalRunner() {
  const calls: Array<{ permissionMode: string; task: string }> = [];
  const run = (input: TaskRunInput) => {
    calls.push({ permissionMode: input.permissionMode, task: input.task });
    let resolve!: (outcome: RunOutcome) => void;
    const outcome = new Promise<RunOutcome>((r) => {
      resolve = r;
    });
    setTimeout(() => {
      if (input.permissionMode === 'danger-full-access') {
        input.onEvent({ type: 'final', text: 'ok-after-approval' });
        resolve(makeRunOutcome({ finalText: 'ok-after-approval' }));
        return;
      }
      input.onEvent({
        type: 'tool_result',
        callId: 'c1',
        status: 'error',
        result:
          'Error: sandbox escalation to "danger-full-access" requires approval, but no approval channel is available',
      });
      input.onEvent({ type: 'error', message: 'requires approval, but no approval channel is available' });
      resolve(
        makeRunOutcome({
          exitCode: 1,
          finalText: null,
          errorMessage: 'requires approval, but no approval channel is available',
        }),
      );
    }, 5);
    return { pid: 1, cancel: () => resolve(makeRunOutcome({ cancelled: true })), outcome };
  };
  return { run, calls };
}

async function setup(options: { elicitation: boolean; elicitAction?: 'accept' | 'decline' }) {
  const config = makeTestConfig();
  const fake = makeApprovalRunner();
  const manager = new TaskManager({ runner: fake.run, store: new MemoryStore(), config });
  await manager.init();
  const server = createWorkerServer({ manager, config });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: 'approval-test', version: '1.0.0' },
    options.elicitation ? { capabilities: { elicitation: {} } } : undefined,
  );
  const elicitations: unknown[] = [];
  if (options.elicitation) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      elicitations.push(request.params);
      if (options.elicitAction === 'decline') {
        return { action: 'decline' as const };
      }
      return { action: 'accept' as const, content: { approve: true } };
    });
  }
  await client.connect(clientTransport);
  cleanups.push(() => client.close());
  cleanups.push(() => server.close());
  cleanups.push(() => manager.abortAll());
  return { client, manager, fake, elicitations };
}

function parsePayload(result: unknown): Record<string, unknown> {
  const toolResult = result as { structuredContent?: Record<string, unknown> };
  return (toolResult.structuredContent ?? {}) as Record<string, unknown>;
}

async function waitTerminal(manager: TaskManager, taskId: string): Promise<void> {
  await waitFor(() => {
    const status = manager.get(taskId)?.status;
    return status === 'succeeded' || status === 'failed' || status === 'cancelled';
  });
}

describe('detectApprovalRequired', () => {
  it('识别审批阻断文案', () => {
    const record = {
      id: 't',
      status: 'failed' as const,
      task: 'x',
      cwd: 'C:\\p',
      permissionMode: 'workspace-write',
      createdAt: 0,
      events: [{ type: 'tool_result', result: 'requires approval, but no approval channel is available' }],
      timedOut: false,
      error: null,
    };
    expect(detectApprovalRequired(record)).toBe(true);
  });

  it('普通失败不误报', () => {
    const record = {
      id: 't',
      status: 'failed' as const,
      task: 'x',
      cwd: 'C:\\p',
      permissionMode: 'workspace-write',
      createdAt: 0,
      events: [{ type: 'tool_result', result: 'typescript error TS2345' }],
      timedOut: false,
      error: '编译失败',
    };
    expect(detectApprovalRequired(record)).toBe(false);
  });
});

describe('审批桥（dsh_result）', () => {
  it('客户端支持 elicitation：授权后用 danger-full-access 重试', async () => {
    const { client, manager, fake, elicitations } = await setup({ elicitation: true });
    const run = parsePayload(
      await client.callTool({ name: 'dsh_run', arguments: { task: '需要审批的任务', cwd: process.cwd() } }),
    );
    const taskId = String(run.task_id);
    await waitTerminal(manager, taskId);

    const first = parsePayload(await client.callTool({ name: 'dsh_result', arguments: { task_id: taskId } }));
    expect(first.status).toBe('failed');
    expect(first.approval).toMatchObject({ required: true, status: 'approved' });
    expect(elicitations).toHaveLength(1);
    const retriedTaskId = String((first.approval as Record<string, unknown>).retried_task_id);
    expect(retriedTaskId).toBeTruthy();

    await waitTerminal(manager, retriedTaskId);
    const second = parsePayload(await client.callTool({ name: 'dsh_result', arguments: { task_id: retriedTaskId } }));
    expect(second.status).toBe('succeeded');
    expect(second.output).toBe('ok-after-approval');
    expect(fake.calls.map((call) => call.permissionMode)).toEqual(['workspace-write', 'danger-full-access']);
  });

  it('客户端不支持 elicitation：返回 unsupported + retry_args，不重试', async () => {
    const { client, manager } = await setup({ elicitation: false });
    const run = parsePayload(
      await client.callTool({ name: 'dsh_run', arguments: { task: '需要审批的任务', cwd: process.cwd() } }),
    );
    const taskId = String(run.task_id);
    await waitTerminal(manager, taskId);
    const result = parsePayload(await client.callTool({ name: 'dsh_result', arguments: { task_id: taskId } }));
    const approval = result.approval as Record<string, unknown>;
    expect(approval.status).toBe('unsupported');
    // leader 无法走交互审批时，可直接用 retry_args 原样重提 dsh_run，不必自行猜测参数
    expect(approval.retry_args).toEqual({
      permission_mode: 'danger-full-access',
      cwd: process.cwd(),
      timeout_s: 5,
    });
    expect(manager.list()).toHaveLength(1);
  });

  it('用户拒绝授权：返回 declined + retry_args，不自动重试', async () => {
    const { client, manager, elicitations } = await setup({ elicitation: true, elicitAction: 'decline' });
    const run = parsePayload(
      await client.callTool({ name: 'dsh_run', arguments: { task: '需要审批的任务', cwd: process.cwd() } }),
    );
    const taskId = String(run.task_id);
    await waitTerminal(manager, taskId);
    const result = parsePayload(await client.callTool({ name: 'dsh_result', arguments: { task_id: taskId } }));
    const approval = result.approval as Record<string, unknown>;
    expect(approval.status).toBe('declined');
    // 拒绝后 leader 仍拿到完整重提参数，可自行决定是否重提
    expect(approval.retry_args).toMatchObject({
      permission_mode: 'danger-full-access',
      cwd: process.cwd(),
      timeout_s: 5,
    });
    expect(elicitations).toHaveLength(1);
    expect(manager.list()).toHaveLength(1);
  });
});
