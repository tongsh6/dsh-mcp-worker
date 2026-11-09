import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkerServer } from '../src/server.js';
import { TaskManager } from '../src/task-manager.js';
import { MemoryStore, makeFakeRunner, makeTestConfig } from './helpers.js';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function connectClient(options: { fake?: ReturnType<typeof makeFakeRunner> } = {}) {
  const config = makeTestConfig();
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
  it('注册了 13 个 worker 工具', async () => {
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
      ].sort(),
    );
    const runTool = tools.find((t) => t.name === 'dsh_run');
    expect(runTool?.inputSchema.required).toContain('task');
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
  });
});
