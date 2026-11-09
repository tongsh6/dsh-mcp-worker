/**
 * 真实 HTTP 传输冒烟：
 *   启动 dist/index.js（DSH_MCP_TRANSPORT=http）→ 解析 stderr 里的 URL
 *   → 校验 /healthz、401 鉴权 → MCP HTTP 客户端跑真实 DSH 任务。
 * 运行：pnpm smoke:http
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createInterface } from 'node:readline';

const projectRoot = resolve(import.meta.dirname, '..');
const serverEntry = join(projectRoot, 'dist', 'index.js');
const TOKEN = `smoke-${Date.now()}-token-0123456789`;

function log(message: string): void {
  process.stdout.write(`[http-smoke] ${message}\n`);
}

function parsePayload(result: unknown): Record<string, unknown> {
  const toolResult = result as { structuredContent?: Record<string, unknown>; content?: Array<{ text?: string }> };
  return (toolResult.structuredContent ?? JSON.parse(toolResult.content?.[0]?.text ?? '{}')) as Record<string, unknown>;
}

async function waitForUrl(stderrLines: AsyncIterable<string>, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for await (const line of stderrLines) {
    log(`server: ${line}`);
    const match = /HTTP（无状态 Streamable HTTP）：(http:\/\/[^\s]+)/.exec(line);
    if (match?.[1]) return match[1];
    if (Date.now() > deadline) break;
  }
  throw new Error('超时：未从 worker stderr 解析到 HTTP URL');
}

async function main(): Promise<void> {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-http-smoke-'));
  const projectDir = join(sandbox, 'proj');
  await mkdir(projectDir, { recursive: true });

  const child = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      DSH_MCP_TRANSPORT: 'http',
      DSH_MCP_HTTP_HOST: '127.0.0.1',
      DSH_MCP_HTTP_PORT: '0',
      DSH_MCP_HTTP_TOKEN: TOKEN,
      DSH_MCP_TASKS_DIR: join(sandbox, 'tasks'),
      DSH_MCP_DEFAULT_CWD: projectDir,
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stderrLines = createInterface({ input: child.stderr });
  const url = await waitForUrl(stderrLines, 30_000);
  log(`HTTP 端点：${url}`);
  const base = url.replace(/\/mcp$/, '');

  try {
    const health = await fetch(`${base}/healthz`);
    log(`/healthz -> ${health.status} ${await health.text()}`);

    const unauthorized = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    log(`无 token 请求 -> ${unauthorized.status}（预期 401）`);
    if (unauthorized.status !== 401) throw new Error('鉴权未生效：缺少 token 时未返回 401');
    await unauthorized.text();

    const client = new Client({ name: 'http-smoke', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      }),
    );
    const { tools } = await client.listTools();
    log(`工具：${tools.map((tool) => tool.name).join(', ')}`);

    const started = Date.now();
    const run = parsePayload(
      await client.callTool({
        name: 'dsh_run',
        arguments: { task: '用一句话回答：1+1 等于几？不要使用任何工具。', cwd: projectDir, timeout_s: 240 },
      }),
    );
    const taskId = String(run.task_id);
    log(`任务已受理：${taskId}`);
    let status = parsePayload(await client.callTool({ name: 'dsh_status', arguments: { task_id: taskId, wait_s: 10 } }));
    const deadline = Date.now() + 300_000;
    while (!['succeeded', 'failed', 'cancelled'].includes(String(status.status)) && Date.now() < deadline) {
      status = parsePayload(
        await client.callTool({
          name: 'dsh_status',
          arguments: { task_id: taskId, cursor: status.next_cursor, wait_s: 10 },
        }),
      );
    }
    const result = parsePayload(await client.callTool({ name: 'dsh_result', arguments: { task_id: taskId } }));
    log(`结果：${JSON.stringify({ status: result.status, output: result.output })}`);
    if (result.status !== 'succeeded' || typeof result.output !== 'string' || result.output.trim().length === 0) {
      throw new Error(`HTTP 任务未成功：${JSON.stringify(result)}`);
    }
    log(`✅ HTTP 冒烟通过：MCP HTTP 客户端 → worker → 真实 DSH，耗时 ${Math.round((Date.now() - started) / 1000)}s`);
    await client.close();
  } finally {
    child.kill();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  log(`❌ HTTP 冒烟失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
