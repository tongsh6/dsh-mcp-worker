/**
 * 真实集成冒烟测试（不是 vitest 用例）：
 *   MCP Client ──stdio──▶ dsh-mcp-worker ──spawn──▶ 真实 dsh headless --json
 * 运行：pnpm smoke
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const serverEntry = join(projectRoot, 'dist', 'index.js');

function log(message: string): void {
  process.stdout.write(`[smoke] ${message}\n`);
}

function parsePayload(result: unknown): Record<string, unknown> {
  const toolResult = result as { structuredContent?: Record<string, unknown>; content?: Array<{ text?: string }>; isError?: boolean };
  if (toolResult.structuredContent) return toolResult.structuredContent;
  const text = toolResult.content?.[0]?.text ?? '{}';
  return JSON.parse(text) as Record<string, unknown>;
}

async function main(): Promise<void> {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-mcp-smoke-'));
  const projectDir = join(sandbox, 'proj');
  const tasksDir = join(sandbox, 'tasks');
  await mkdir(projectDir, { recursive: true });

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    DSH_MCP_TASKS_DIR: tasksDir,
    DSH_MCP_DEFAULT_CWD: projectDir,
    DSH_MCP_MAX_CONCURRENT: '2',
  };
  delete env.DSH_MCP_DSH_CLI;

  log(`启动 worker：${serverEntry}`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env,
    cwd: projectDir,
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').trim();
    if (text.length > 0) log(`server stderr: ${text}`);
  });

  const client = new Client({ name: 'dsh-mcp-smoke', version: '1.0.0' });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    log(`工具：${tools.tools.map((tool) => tool.name).join(', ')}`);

    const describe = parsePayload(await client.callTool({ name: 'dsh_describe', arguments: {} }));
    log(`dsh 入口：${JSON.stringify(describe.dsh)}`);

    // 安全校验：cwd 指向用户主目录必须被拒绝
    const rejected = parsePayload(
      await client.callTool({ name: 'dsh_run', arguments: { task: 'x', cwd: homedir() } }),
    );
    if (!rejected.error) throw new Error('预期 cwd=用户主目录被拒绝，但调用成功了');
    log(`cwd 安全校验通过：${JSON.stringify(rejected.error)}`);

    // 真实任务
    const started = Date.now();
    const run = parsePayload(
      await client.callTool({
        name: 'dsh_run',
        arguments: { task: '用一句话回答：1+1 等于几？不要使用任何工具。', cwd: projectDir, timeout_s: 240 },
      }),
    );
    const taskId = String(run.task_id ?? '');
    if (!taskId) throw new Error(`dsh_run 未返回 task_id：${JSON.stringify(run)}`);
    log(`任务已受理：${taskId}（status=${String(run.status)}）`);

    let status = parsePayload(
      await client.callTool({ name: 'dsh_status', arguments: { task_id: taskId, wait_s: 10 } }),
    );
    const deadline = Date.now() + 300_000;
    while (!['succeeded', 'failed', 'cancelled'].includes(String(status.status)) && Date.now() < deadline) {
      status = parsePayload(
        await client.callTool({ name: 'dsh_status', arguments: { task_id: taskId, cursor: status.next_cursor, wait_s: 10 } }),
      );
      log(`status=${String(status.status)} phase=${String(status.phase)} progress=${String(status.progress)}`);
    }
    log(`任务结束：status=${String(status.status)}，耗时 ${Math.round((Date.now() - started) / 1000)}s`);

    const result = parsePayload(await client.callTool({ name: 'dsh_result', arguments: { task_id: taskId } }));
    log(`结果：${JSON.stringify(result, null, 2)}`);

    if (result.status !== 'succeeded') {
      throw new Error(`真实任务未成功：${JSON.stringify(result)}`);
    }
    if (typeof result.output !== 'string' || result.output.trim().length === 0) {
      throw new Error('真实任务成功但输出为空');
    }
    // 真实写文件任务：验证 workspace-write 下无人值守可以落盘
    const writeStarted = Date.now();
    const writeTask = parsePayload(
      await client.callTool({
        name: 'dsh_run',
        arguments: {
          task: '请用 write 工具在当前目录创建文件 hello-dsh.txt，内容只有一行 hello-dsh，完成后只回答 done。',
          cwd: projectDir,
          timeout_s: 300,
        },
      }),
    );
    const writeTaskId = String(writeTask.task_id ?? '');
    if (!writeTaskId) throw new Error(`写文件任务未受理：${JSON.stringify(writeTask)}`);
    log(`写文件任务已受理：${writeTaskId}`);

    let writeStatus = parsePayload(
      await client.callTool({ name: 'dsh_status', arguments: { task_id: writeTaskId, wait_s: 15 } }),
    );
    const writeDeadline = Date.now() + 360_000;
    while (!['succeeded', 'failed', 'cancelled'].includes(String(writeStatus.status)) && Date.now() < writeDeadline) {
      writeStatus = parsePayload(
        await client.callTool({
          name: 'dsh_status',
          arguments: { task_id: writeTaskId, cursor: writeStatus.next_cursor, wait_s: 15 },
        }),
      );
      log(`write status=${String(writeStatus.status)} phase=${String(writeStatus.phase)} progress=${String(writeStatus.progress)}`);
    }
    const writeResult = parsePayload(await client.callTool({ name: 'dsh_result', arguments: { task_id: writeTaskId } }));
    log(`写文件任务结果：${JSON.stringify({ status: writeResult.status, error: writeResult.error, output: writeResult.output })}`);
    const written = await readFile(join(projectDir, 'hello-dsh.txt'), 'utf8').catch(() => null);
    if (written === null) {
      throw new Error('写文件任务结束但 hello-dsh.txt 不存在（workspace-write 可能未生效）');
    }
    log(`文件内容：${JSON.stringify(written.slice(0, 100))}`);
    log(`写文件任务耗时：${Math.round((Date.now() - writeStarted) / 1000)}s（对比问答任务可看长驻后端是否省掉冷启动）`);

    log('✅ 烟测通过：MCP Client → dsh-mcp-worker → 真实 DSH（问答 + 写文件）全链路正常');
  } finally {
    await client.close().catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  log(`❌ 烟测失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
