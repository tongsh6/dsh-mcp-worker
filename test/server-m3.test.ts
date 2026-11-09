import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/audit.js';
import { createWorkerServer } from '../src/server.js';
import { TaskManager } from '../src/task-manager.js';
import { MemoryStore, makeFakeRunner, makeTestConfig, waitFor } from './helpers.js';

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await Promise.resolve(fn()).catch(() => undefined);
});

async function setup(options: { finalText?: string; maxResultChars?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'server-m3-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const config = makeTestConfig({
    tasksDir: join(dir, 'tasks'),
    auditDir: join(dir, 'audit'),
    maxResultChars: options.maxResultChars ?? 100,
  });
  const audit = new AuditLog(config.auditDir);
  await audit.init();

  const fake = makeFakeRunner({ delayMs: 5, finalText: options.finalText ?? 'ok' });
  const manager = new TaskManager({
    runner: fake.runner,
    store: new MemoryStore(),
    config,
    audit: (entry) => {
      void audit.append(entry).catch(() => undefined);
    },
  });
  cleanup.push(() => manager.stop());
  await manager.init();
  const server = createWorkerServer({ manager, config, audit });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'server-m3', version: '1.0.0' });
  await client.connect(clientTransport);
  cleanup.push(() => client.close());
  cleanup.push(() => server.close());
  return { client, manager, audit, dir, config };
}

function parsePayload(result: unknown): Record<string, unknown> {
  const toolResult = result as { structuredContent?: Record<string, unknown> };
  return (toolResult.structuredContent ?? {}) as Record<string, unknown>;
}

async function runTask(client: Client, manager: TaskManager, task: string): Promise<string> {
  const run = parsePayload(await client.callTool({ name: 'dsh_run', arguments: { task, cwd: process.cwd() } }));
  const taskId = String(run.task_id);
  await waitFor(() => {
    const status = manager.get(taskId)?.status;
    return status === 'succeeded' || status === 'failed' || status === 'cancelled';
  });
  return taskId;
}

describe('M3 新增工具', () => {
  it('dsh_tasks 返回任务摘要', async () => {
    const { client, manager } = await setup();
    const taskId = await runTask(client, manager, 'task-one');
    const payload = parsePayload(await client.callTool({ name: 'dsh_tasks', arguments: { limit: 5 } }));
    expect(payload.count).toBe(1);
    const tasks = payload.tasks as Array<Record<string, unknown>>;
    expect(tasks[0]?.task_id).toBe(taskId);
    expect(tasks[0]?.status).toBe('succeeded');

    const filtered = parsePayload(await client.callTool({ name: 'dsh_tasks', arguments: { status: 'failed' } }));
    expect(filtered.count).toBe(0);
  });

  it('dsh_audit 返回审计事件', async () => {
    const { client, manager } = await setup();
    const taskId = await runTask(client, manager, 'audited-task');
    const payload = parsePayload(await client.callTool({ name: 'dsh_audit', arguments: { limit: 20 } }));
    const entries = payload.entries as Array<Record<string, unknown>>;
    expect(entries.some((entry) => entry.event === 'task_created' && entry.task_id === taskId)).toBe(true);
    expect(entries.some((entry) => entry.event === 'task_succeeded')).toBe(true);
  });

  it('dsh_read_result 分页读取落盘产物', async () => {
    const longText = 'Z'.repeat(5_000);
    const { client, manager } = await setup({ finalText: longText, maxResultChars: 100 });
    const taskId = await runTask(client, manager, 'long-result');

    const result = parsePayload(await client.callTool({ name: 'dsh_result', arguments: { task_id: taskId } }));
    expect((result.artifacts as unknown[]).length).toBe(1);
    const artifacts = result.artifacts as Array<{ path: string }>;
    expect(artifacts[0]?.path).toBeTruthy();

    const page = parsePayload(
      await client.callTool({
        name: 'dsh_read_result',
        arguments: { task_id: taskId, source: 'result', max_chars: 1000 },
      }),
    );
    expect(page.total_chars).toBe(5_000);
    expect(String(page.content).startsWith('ZZZ')).toBe(true);
    expect(page.eof).toBe(false);

    const tail = parsePayload(
      await client.callTool({
        name: 'dsh_read_result',
        arguments: { task_id: taskId, source: 'result', offset: page.next_offset, max_chars: 100_000 },
      }),
    );
    expect(tail.eof).toBe(true);
    expect((String(page.content) + String(tail.content)).length).toBe(5_000);
  });
});
