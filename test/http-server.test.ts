import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { startHttpServer, validateHttpConfig, type RunningHttpServer } from '../src/http-server.js';
import { TaskManager } from '../src/task-manager.js';
import { MemoryStore, makeFakeRunner, makeTestConfig, waitFor } from './helpers.js';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  const fns = cleanups.splice(0).reverse();
  for (const fn of fns) await Promise.resolve(fn()).catch(() => undefined);
});

async function setup(options: { token?: string } = {}) {
  const token = options.token ?? 'test-token-0123456789';
  const config = makeTestConfig({ transport: 'http', http: { host: '127.0.0.1', port: 0, token } });
  const fake = makeFakeRunner({ delayMs: 5, finalText: 'http-done' });
  const manager = new TaskManager({ runner: fake.runner, store: new MemoryStore(), config });
  await manager.init();
  const httpServer = await startHttpServer({ manager, config });
  cleanups.push(() => httpServer.close());
  cleanups.push(() => manager.abortAll());
  const client = new Client({ name: 'http-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(httpServer.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  cleanups.push(() => client.close());
  return { httpServer, client, manager, fake, token };
}

function parsePayload(result: unknown): Record<string, unknown> {
  const toolResult = result as { structuredContent?: Record<string, unknown>; content?: Array<{ text?: string }> };
  if (toolResult.structuredContent) return toolResult.structuredContent;
  return JSON.parse(toolResult.content?.[0]?.text ?? '{}') as Record<string, unknown>;
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, init);
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as unknown) : null };
}

describe('Streamable HTTP 传输', () => {
  it('/healthz 无需鉴权', async () => {
    const { httpServer } = await setup();
    const base = httpServer.url.replace(/\/mcp$/, '');
    const { status, body } = await fetchJson(`${base}/healthz`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, name: 'dsh-mcp-worker' });
  });

  it('缺少/错误 token 返回 401', async () => {
    const { httpServer } = await setup();
    const unauthorized = await fetchJson(httpServer.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(unauthorized.status).toBe(401);

    const wrong = await fetchJson(httpServer.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(wrong.status).toBe(401);
  });

  it('带 token 的 MCP 客户端可以完成 run → status → result', async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain('dsh_run');

    const run = parsePayload(
      await client.callTool({ name: 'dsh_run', arguments: { task: 'over-http', cwd: process.cwd() } }),
    );
    const taskId = String(run.task_id);
    let status = parsePayload(
      await client.callTool({ name: 'dsh_status', arguments: { task_id: taskId, wait_s: 5 } }),
    );
    const deadline = Date.now() + 10_000;
    while (!['succeeded', 'failed', 'cancelled'].includes(String(status.status)) && Date.now() < deadline) {
      status = parsePayload(
        await client.callTool({ name: 'dsh_status', arguments: { task_id: taskId, wait_s: 5 } }),
      );
    }
    expect(status.status).toBe('succeeded');
    const result = parsePayload(await client.callTool({ name: 'dsh_result', arguments: { task_id: taskId } }));
    expect(result.output).toBe('http-done');
  });

  it('GET /mcp 在无状态模式下返回 405', async () => {
    const { httpServer, token } = await setup();
    const response = await fetch(httpServer.url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(405);
    await response.text();
  });

  it('非回环地址无 token 时拒绝启动', () => {
    const config = makeTestConfig({ http: { host: '0.0.0.0', port: 0, token: '' } });
    expect(() => validateHttpConfig(config)).toThrow(/DSH_MCP_HTTP_TOKEN/);
  });
});
