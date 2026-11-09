import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/audit.js';
import { BatchManager } from '../src/batch-manager.js';
import { createWorkerServer } from '../src/server.js';
import { TaskManager } from '../src/task-manager.js';
import { MemoryStore, makeFakeRunner, makeTestConfig, waitFor } from './helpers.js';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await Promise.resolve(fn()).catch(() => undefined);
});

async function setup(options: { finalText?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'server-m4-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const config = makeTestConfig({
    tasksDir: join(dir, 'tasks'),
    auditDir: join(dir, 'audit'),
    batchDir: join(dir, 'batches'),
    cleanupIntervalMs: 0,
  });
  const audit = new AuditLog(config.auditDir);
  await audit.init();
  const fake = makeFakeRunner({ delayMs: 5, finalText: options.finalText ?? 'needle-xyz done' });
  const manager = new TaskManager({
    runner: fake.runner,
    store: new MemoryStore(),
    config,
    audit: (entry) => {
      void audit.append(entry).catch(() => undefined);
    },
  });
  await manager.init();
  cleanups.push(() => manager.stop());
  cleanups.push(() => manager.abortAll());
  const batches = new BatchManager(manager, config.batchDir, config.maxBatchTasks);
  await batches.init();

  const server = createWorkerServer({
    manager,
    config,
    audit,
    batches,
    runtimeInfo: () => ({ backend: 'test', uptime_s: 1 }),
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'server-m4', version: '1.0.0' });
  await client.connect(clientTransport);
  cleanups.push(() => client.close());
  cleanups.push(() => server.close());
  return { client, manager };
}

function parsePayload(result: unknown): Record<string, unknown> {
  const toolResult = result as { structuredContent?: Record<string, unknown> };
  return (toolResult.structuredContent ?? {}) as Record<string, unknown>;
}

describe('M4 新增工具', () => {
  it('dsh_batch_run → dsh_batch_status → dsh_batch_result', async () => {
    const { client, manager } = await setup({ finalText: 'batch-ok' });
    const run = parsePayload(
      await client.callTool({
        name: 'dsh_batch_run',
        arguments: {
          tasks: [
            { task: 'a', cwd: process.cwd() },
            { task: 'b', cwd: process.cwd() },
          ],
        },
      }),
    );
    expect(run.count).toBe(2);
    const batchId = String(run.batch_id);
    const taskIds = run.task_ids as string[];

    await waitFor(() => taskIds.every((id) => manager.get(id)?.status === 'succeeded'));
    const status = parsePayload(
      await client.callTool({ name: 'dsh_batch_status', arguments: { batch_id: batchId, wait_s: 5 } }),
    );
    expect(status.status).toBe('completed');
    expect((status.counts as Record<string, number>).succeeded).toBe(2);

    const result = parsePayload(await client.callTool({ name: 'dsh_batch_result', arguments: { batch_id: batchId } }));
    const items = result.results as Array<Record<string, unknown>>;
    expect(items.map((item) => item.output)).toEqual(['batch-ok', 'batch-ok']);
  });

  it('dsh_search 命中任务输出', async () => {
    const { client, manager } = await setup({ finalText: 'unique-needle-in-output' });
    const run = parsePayload(
      await client.callTool({ name: 'dsh_run', arguments: { task: 'search me', cwd: process.cwd() } }),
    );
    const taskId = String(run.task_id);
    await waitFor(() => manager.get(taskId)?.status === 'succeeded');
    const payload = parsePayload(await client.callTool({ name: 'dsh_search', arguments: { query: 'unique-needle' } }));
    expect(payload.count).toBe(1);
    const matches = payload.matches as Array<Record<string, unknown>>;
    expect(matches[0]?.task_id).toBe(taskId);
    expect(String(matches[0]?.snippet)).toContain('unique-needle');
  });

  it('dsh_metrics 返回计数/分位/运行时', async () => {
    const { client, manager } = await setup();
    const run = parsePayload(
      await client.callTool({ name: 'dsh_run', arguments: { task: 'metrics', cwd: process.cwd() } }),
    );
    await waitFor(() => manager.get(String(run.task_id))?.status === 'succeeded');
    const payload = parsePayload(await client.callTool({ name: 'dsh_metrics', arguments: {} }));
    const counts = payload.counts as Record<string, number>;
    expect(counts.succeeded).toBe(1);
    expect(payload.total).toBe(1);
    const latency = payload.latency_ms as Record<string, number | null>;
    expect(latency.samples).toBe(1);
    expect(latency.p50).toBeGreaterThanOrEqual(0);
    expect(payload.runtime).toMatchObject({ backend: 'test' });
  });
});
