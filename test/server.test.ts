import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkerConfig } from '../src/config.js';
import { createWorkerServer } from '../src/server.js';
import { TaskManager } from '../src/task-manager.js';
import { MemoryStore, makeFakeRunner, makeTestConfig } from './helpers.js';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  closers.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return dir;
}

async function connectClient(
  options: { fake?: ReturnType<typeof makeFakeRunner>; config?: Partial<WorkerConfig> } = {},
) {
  const config = makeTestConfig(options.config ?? {});
  const store = new MemoryStore();
  const fake = options.fake ?? makeFakeRunner({ delayMs: 5, finalText: 'mcp-done' });
  const manager = new TaskManager({ runner: fake.runner, store, config });
  await manager.init();
  const server = createWorkerServer({ manager, config });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientTransport);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, manager, fake, config };
}

function parsePayload(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  return (result.structuredContent ?? JSON.parse((result.content[0] as { text: string }).text)) as Record<string, unknown>;
}

describe('MCP server（内存传输）', () => {
  it('注册了 14 个 worker 工具', async () => {
    const { client } = await connectClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'dsh_audit',
        'dsh_batch_result',
        'dsh_batch_run',
        'dsh_batch_status',
        'dsh_cancel',
        'dsh_describe',
        'dsh_metrics',
        'dsh_read_result',
        'dsh_result',
        'dsh_run',
        'dsh_search',
        'dsh_status',
        'dsh_tasks',
        'dsh_usage',
      ].sort(),
    );
    const runTool = tools.find((t) => t.name === 'dsh_run');
    expect(runTool?.inputSchema.required).toContain('task');
    expect(Object.keys(runTool?.inputSchema.properties ?? {})).toContain('idempotency_key');
  });

  it('run → status → result 全链路', async () => {
    const { client } = await connectClient();
    const run = parsePayload(
      await client.callTool({ name: 'dsh_run', arguments: { task: 'do work', cwd: process.cwd() } }),
    );
    expect(typeof run.task_id).toBe('string');
    expect(['queued', 'running']).toContain(run.status);

    let status = parsePayload(
      await client.callTool({ name: 'dsh_status', arguments: { task_id: run.task_id, wait_s: 5 } }),
    );
    const deadline = Date.now() + 10_000;
    while (!['succeeded', 'failed', 'cancelled'].includes(String(status.status)) && Date.now() < deadline) {
      status = parsePayload(
        await client.callTool({ name: 'dsh_status', arguments: { task_id: run.task_id, wait_s: 5 } }),
      );
    }
    expect(status.status).toBe('succeeded');

    const result = parsePayload(await client.callTool({ name: 'dsh_result', arguments: { task_id: run.task_id } }));
    expect(result.status).toBe('succeeded');
    expect(result.output).toBe('mcp-done');
  });

  it('未知任务返回结构化错误', async () => {
    const { client } = await connectClient();
    const status = await client.callTool({ name: 'dsh_status', arguments: { task_id: 'nope' } });
    expect(status.isError).toBe(true);
  });

  it('dsh_describe 返回配置与能力信息', async () => {
    const { client } = await connectClient();
    const payload = parsePayload(await client.callTool({ name: 'dsh_describe', arguments: {} }));
    expect(payload.name).toBe('dsh-mcp-worker');
    expect(payload.tools).toBeTruthy();
    expect(payload.limits).toBeTruthy();
    expect(payload.defaults).toMatchObject({ pricing: expect.any(Object) });
  });

  it('dsh_usage 聚合任务用量与费用口径', async () => {
    const { client } = await connectClient();
    const run = parsePayload(
      await client.callTool({ name: 'dsh_run', arguments: { task: 'usage work', cwd: process.cwd(), wait_s: 5 } }),
    );
    expect(run.task_id).toBeTruthy();
    const report = parsePayload(await client.callTool({ name: 'dsh_usage', arguments: { days: 1 } }));
    expect(report.window_days).toBe(1);
    expect(Number(report.jobs)).toBeGreaterThanOrEqual(1);
    expect(report.pricing).toMatchObject({ input_per_mtok: expect.any(Number), usd_cny: expect.any(Number) });
    const usage = report.usage as Record<string, number> | null;
    expect(usage).not.toBeNull();
    expect(usage!.jobs_with_usage).toBeGreaterThanOrEqual(1);
    expect(usage!.total_tokens).toBeGreaterThanOrEqual(1);
  });

  it('dsh_metrics 返回估算费用汇总', async () => {
    const { client } = await connectClient();
    await client.callTool({ name: 'dsh_run', arguments: { task: 'metrics work', cwd: process.cwd(), wait_s: 5 } });
    const metrics = parsePayload(await client.callTool({ name: 'dsh_metrics', arguments: {} }));
    expect(metrics.tokens).toBeTruthy();
    expect(metrics.cost).toMatchObject({ usd: expect.any(Number), cny: expect.any(Number) });
  });

  it('dsh_run 幂等键：重复提交复用同一 task', async () => {
    const idemDir = await tempDir('idem-server-');
    const { client } = await connectClient({ config: { idemDir } });
    const args = { task: 'idem work', cwd: process.cwd(), idempotency_key: 'same-key', wait_s: 5 };
    const first = parsePayload(await client.callTool({ name: 'dsh_run', arguments: args }));
    const second = parsePayload(await client.callTool({ name: 'dsh_run', arguments: args }));
    expect(String(second.task_id)).toBe(String(first.task_id));
    expect(second.idempotent_reuse).toBe(true);
    expect(first.idempotent_reuse).toBe(false);
  });

  it('dsh_result 支持 offset/max_chars 分页续读', async () => {
    const longText = 'x'.repeat(2_500);
    const { client } = await connectClient({
      fake: makeFakeRunner({ delayMs: 5, finalText: longText }),
      config: { maxResultChars: 400 },
    });
    const run = parsePayload(
      await client.callTool({ name: 'dsh_run', arguments: { task: 'long output', cwd: process.cwd(), wait_s: 5 } }),
    );
    const page1 = parsePayload(
      await client.callTool({ name: 'dsh_result', arguments: { task_id: run.task_id, offset: 0, max_chars: 1_000 } }),
    );
    expect(String(page1.output)).toHaveLength(1_000);
    const pagination = page1.output_pagination as Record<string, unknown>;
    expect(pagination.total_chars).toBe(2_500);
    expect(pagination.next_offset).toBe(1_000);
    expect(pagination.truncated).toBe(true);

    const page2 = parsePayload(
      await client.callTool({
        name: 'dsh_result',
        arguments: { task_id: run.task_id, offset: pagination.next_offset, max_chars: 1_000 },
      }),
    );
    expect(String(page2.output)).toHaveLength(1_000);
    expect((page2.output_pagination as Record<string, unknown>).next_offset).toBe(2_000);
  });
});
