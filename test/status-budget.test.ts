import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createWorkerServer } from '../src/server.js';
import { JsonlTaskStore } from '../src/store.js';
import { TaskManager } from '../src/task-manager.js';
import type { RunHandle, TaskRunner, TaskRunInput } from '../src/task-manager.js';
import type { RunEvent } from '../src/types.js';
import { makeRunOutcome, makeTestConfig, MemoryStore, waitFor } from './helpers.js';

const STATUS_BUDGET = 16 * 1024;
const EVENT_BUDGET = 2 * 1024;
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await Promise.resolve(fn()).catch(() => undefined);
});

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function makeBigRunner(events: RunEvent[]): TaskRunner {
  return (input: TaskRunInput): RunHandle => {
    for (const event of events) input.onEvent(event);
    return {
      pid: 1,
      cancel: () => undefined,
      outcome: Promise.resolve(makeRunOutcome({ finalText: 'done-big', sessionId: 'sess-big' })),
    };
  };
}

function parsePayload(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  return (result.structuredContent ?? JSON.parse((result.content[0] as { text: string }).text)) as Record<string, unknown>;
}

describe('status 事件摘要与载荷上限', () => {
  it('50 万字符工具结果/中文输出下响应受限，原始日志完整，游标与 run(wait_s) 正确', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'status-budget-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
    const tasksDir = join(dir, 'tasks');
    const config = makeTestConfig({ tasksDir, cleanupIntervalMs: 0 });
    const store = new JsonlTaskStore(tasksDir);

    const bigChinese = '汉'.repeat(500_000);
    const medium = '工具输出'.repeat(2_500);
    const chineseText = `中文最终输出：${'结果'.repeat(100_000)}`;
    const longError = `错误：${'失败原因'.repeat(100_000)}`;
    const generated: RunEvent[] = [
      { type: 'session', sessionId: 'sess-big' },
      {
        type: 'tool_result',
        callId: 'big',
        message: { role: 'tool', isError: false, content: [{ type: 'text', text: bigChinese }] },
      },
      ...Array.from({ length: 12 }, (_, index) => ({
        type: 'tool_result',
        callId: `m-${index}`,
        message: { role: 'tool', isError: false, content: [{ type: 'text', text: medium }] },
      })),
      { type: 'text', text: chineseText },
      { type: 'error', message: longError },
      { type: 'final', text: 'done-big' },
    ];

    const manager = new TaskManager({ runner: makeBigRunner(generated), store, config });
    await manager.init();
    cleanups.push(() => manager.stop());
    const server = createWorkerServer({ manager, config });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'status-budget', version: '1.0.0' });
    await client.connect(clientTransport);
    cleanups.push(() => client.close());
    cleanups.push(() => server.close());

    const runResult = await client.callTool({
      name: 'dsh_run',
      arguments: { task: 'big-output', cwd: process.cwd(), wait_s: 10 },
    });
    const run = parsePayload(runResult);
    const runText = (runResult.content[0] as { text: string }).text;
    const runEvents = (run.events ?? []) as RunEvent[];
    const runStructuredBytes = utf8Bytes(JSON.stringify(run));
    const runTextBytes = utf8Bytes(runText);
    console.log(
      `[status-budget] run structured=${runStructuredBytes}B text=${runTextBytes}B events=${utf8Bytes(
        JSON.stringify(runEvents),
      )}B`,
    );

    expect(run.status).toBe('succeeded');
    expect(run.session_id).toBe('sess-big');
    expect(runEvents.length).toBeGreaterThan(0);
    expect(runEvents.every((event) => typeof event.seq === 'number')).toBe(true);
    expect(run.next_cursor).toBe(Number(runEvents.at(-1)?.seq) + 1);
    expect(run.events_truncated).toBe(true);
    expect(utf8Bytes(JSON.stringify(runEvents))).toBeLessThanOrEqual(STATUS_BUDGET);
    expect(runStructuredBytes).toBeLessThanOrEqual(STATUS_BUDGET);
    expect(runTextBytes).toBeLessThanOrEqual(STATUS_BUDGET * 2);

    const taskId = String(run.task_id);
    await waitFor(async () => {
      const raw = await readFile(join(tasksDir, taskId, 'events.jsonl'), 'utf8').catch(() => '');
      return raw.includes(bigChinese) && raw.includes(chineseText) && raw.includes(longError);
    });
    const status = await manager.status(taskId);
    const statusBytes = utf8Bytes(JSON.stringify(status));
    console.log(
      `[status-budget] status payload=${statusBytes}B events=${status.events.length} next=${status.next_cursor}`,
    );
    const rawEvents = manager.get(taskId)?.events ?? [];
    const oldShape = { ...status, events: rawEvents, next_cursor: rawEvents.length } as Record<string, unknown>;
    delete oldShape.events_truncated;
    console.log(
      `[status-budget] old-shape status=${utf8Bytes(JSON.stringify(oldShape))}B raw-events=${utf8Bytes(
        JSON.stringify(rawEvents),
      )}B`,
    );
    const statusTool = await client.callTool({ name: 'dsh_status', arguments: { task_id: taskId } });
    const statusToolStructuredBytes = utf8Bytes(JSON.stringify(statusTool.structuredContent));
    const statusToolTextBytes = utf8Bytes((statusTool.content[0] as { text: string }).text);
    console.log(
      `[status-budget] status tool structured=${statusToolStructuredBytes}B text=${statusToolTextBytes}B`,
    );
    expect(statusToolStructuredBytes).toBeLessThanOrEqual(STATUS_BUDGET);
    expect(statusToolTextBytes).toBeLessThanOrEqual(STATUS_BUDGET * 2);
    expect(statusBytes).toBeLessThanOrEqual(STATUS_BUDGET);
    expect(status.events_truncated).toBe(true);
    expect(status.events.length).toBeGreaterThan(0);
    expect(status.events.length).toBeLessThan(generated.length);
    for (const digest of status.events) {
      expect(typeof digest.seq).toBe('number');
      expect(utf8Bytes(JSON.stringify(digest))).toBeLessThanOrEqual(EVENT_BUDGET);
    }
    const bigDigest = status.events.find((event) => Number(event.original_bytes) > 1_000_000);
    expect(bigDigest?.truncated).toBe(true);
    expect(String(bigDigest?.message ?? bigDigest?.summary)).toContain('汉');
    expect(JSON.stringify(status.events)).not.toContain('\uFFFD');

    const result = await manager.result(taskId);
    const totalEvents = result.events_count;
    expect(totalEvents).toBe(generated.length);

    const seqs: number[] = [];
    let cursor = 0;
    let pages = 0;
    while (cursor < totalEvents) {
      const page = await manager.status(taskId, { cursor });
      expect(utf8Bytes(JSON.stringify(page))).toBeLessThanOrEqual(STATUS_BUDGET);
      expect(page.events.length).toBeGreaterThan(0);
      const pageSeqs = page.events.map((event) => Number(event.seq));
      expect(pageSeqs).toEqual(Array.from({ length: page.events.length }, (_, index) => cursor + index));
      seqs.push(...pageSeqs);
      expect(page.next_cursor).toBeGreaterThan(cursor);
      cursor = page.next_cursor;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(totalEvents + 1);
    }
    expect(seqs).toEqual(Array.from({ length: totalEvents }, (_, index) => index));

    const raw = await readFile(join(tasksDir, taskId, 'events.jsonl'), 'utf8');
    expect(raw.includes(bigChinese)).toBe(true);
    expect(raw.includes(chineseText)).toBe(true);
    expect(raw.includes(longError)).toBe(true);
    expect(utf8Bytes(raw)).toBeGreaterThan(1_500_000);

    const read = parsePayload(
      await client.callTool({
        name: 'dsh_read_result',
        arguments: { task_id: taskId, source: 'events', offset: 0, max_chars: 100_000 },
      }),
    );
    expect(String(read.content)).toContain('汉');
    expect(read.total_chars as number).toBeGreaterThan(500_000);
  }, 60_000);

  it('status.error 长错误也受字节预算约束，且完整错误仍可从 result 读取', async () => {
    const longError = `失败：${'错误原因'.repeat(50_000)}`;
    const runner: TaskRunner = (input: TaskRunInput): RunHandle => {
      const sessionId = input.sessionId ?? null;
      input.onEvent({ type: 'session', sessionId, cwd: input.cwd });
      return {
        pid: 1,
        cancel: () => undefined,
        outcome: Promise.resolve(
          makeRunOutcome({ exitCode: 1, finalText: null, errorMessage: longError, sessionId }),
        ),
      };
    };
    const manager = new TaskManager({ runner, store: new MemoryStore(), config: makeTestConfig() });
    await manager.init();
    cleanups.push(() => manager.stop());

    const record = await manager.create({ task: 'long-error', cwd: 'C:\\proj' });
    await waitFor(() => manager.get(record.id)?.status === 'failed');
    const status = await manager.status(record.id);
    const result = await manager.result(record.id);

    expect(utf8Bytes(JSON.stringify(status))).toBeLessThanOrEqual(STATUS_BUDGET);
    expect(status.error_truncated).toBe(true);
    expect(String(status.error)).toContain('失败');
    expect(String(status.error).length).toBeLessThan(longError.length);
    expect(result.error).toBe(longError);
  }, 20_000);

  it('4096 预算下带引号/反斜杠/换行的长错误不会撑破 status/run 整包', async () => {
    const budget = 4096;
    const dir = await mkdtemp(join(tmpdir(), 'status-escape-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
    const tasksDir = join(dir, 'tasks');
    const config = makeTestConfig({ tasksDir, cleanupIntervalMs: 0, maxStatusPayloadBytes: budget });
    const longError = '"\\\n'.repeat(10_000);
    const toolText = '汉"\\\n'.repeat(100_000);
    const generated: RunEvent[] = [
      { type: 'session', sessionId: 'sess-escape' },
      {
        type: 'tool_result',
        callId: 'huge',
        message: { role: 'tool', isError: false, content: [{ type: 'text', text: toolText }] },
      },
      ...Array.from({ length: 20 }, (_, index) => ({
        type: 'tool_result',
        callId: `d-${index}`,
        message: { role: 'tool', isError: false, content: [{ type: 'text', text: `小结果-${index}` }] },
      })),
    ];
    const runner: TaskRunner = (input: TaskRunInput): RunHandle => {
      for (const event of generated) input.onEvent(event);
      return {
        pid: 1,
        cancel: () => undefined,
        outcome: Promise.resolve(
          makeRunOutcome({ exitCode: 1, finalText: null, errorMessage: longError, sessionId: 'sess-escape' }),
        ),
      };
    };
    const manager = new TaskManager({ runner, store: new JsonlTaskStore(tasksDir), config });
    await manager.init();
    cleanups.push(() => manager.stop());
    const server = createWorkerServer({ manager, config });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'status-escape', version: '1.0.0' });
    await client.connect(clientTransport);
    cleanups.push(() => client.close());
    cleanups.push(() => server.close());

    const runResult = await client.callTool({
      name: 'dsh_run',
      arguments: { task: 'escape', cwd: process.cwd(), wait_s: 10 },
    });
    const run = parsePayload(runResult);
    const runBytes = utf8Bytes(JSON.stringify(run));
    const runEvents = (run.events ?? []) as RunEvent[];
    console.log(`[status-budget] 4096 escape run=${runBytes}B events=${runEvents.length}`);
    expect(run.status).toBe('failed');
    expect(runBytes).toBeLessThanOrEqual(budget);
    expect(runEvents.length).toBeGreaterThan(0);
    expect(run.next_cursor).toBe(Number(runEvents.at(-1)?.seq) + 1);

    const taskId = String(run.task_id);
    const status = await manager.status(taskId);
    const statusBytes = utf8Bytes(JSON.stringify(status));
    console.log(
      `[status-budget] 4096 escape status=${statusBytes}B events=${status.events.length} next=${status.next_cursor}`,
    );
    expect(statusBytes).toBeLessThanOrEqual(budget);
    expect(status.events.length).toBeGreaterThan(0);
    expect(status.error_truncated).toBe(true);
    expect(typeof status.error).toBe('string');
    expect(JSON.stringify(status)).not.toContain('\uFFFD');

    const result = await manager.result(taskId);
    expect(result.error).toBe(longError);
    const total = result.events_count;
    const seqs: number[] = [];
    let cursor = 0;
    let pages = 0;
    while (cursor < total) {
      const page = await manager.status(taskId, { cursor });
      expect(utf8Bytes(JSON.stringify(page))).toBeLessThanOrEqual(budget);
      expect(page.events.length).toBeGreaterThan(0);
      seqs.push(...page.events.map((event) => Number(event.seq)));
      expect(page.next_cursor).toBeGreaterThan(cursor);
      cursor = page.next_cursor;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(total + 1);
    }
    expect(seqs).toEqual(Array.from({ length: total }, (_, index) => index));

    await waitFor(async () => {
      const raw = await readFile(join(tasksDir, taskId, 'events.jsonl'), 'utf8').catch(() => '');
      return raw.includes('"callId":"huge"') && raw.includes('小结果-19');
    });
    const raw = await readFile(join(tasksDir, taskId, 'events.jsonl'), 'utf8');
    const hugePersisted = raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as RunEvent)
      .find((event) => event.callId === 'huge');
    expect(hugePersisted?.message).toMatchObject({ content: [{ type: 'text', text: toolText }] });
    expect(raw.includes('小结果-19')).toBe(true);
  }, 60_000);

  it('4096 预算下 dsh_run 的 created/hint 等元数据也计入整包', async () => {
    const budget = 4096;
    const config = makeTestConfig({ cleanupIntervalMs: 0, maxStatusPayloadBytes: budget });
    const huge = '汉'.repeat(100_000);
    const generated: RunEvent[] = [
      { type: 'session', sessionId: 'sess-run-budget' },
      {
        type: 'tool_result',
        callId: 'huge',
        message: { role: 'tool', isError: false, content: [{ type: 'text', text: huge }] },
      },
      ...Array.from({ length: 30 }, (_, index) => ({
        type: 'tool_result',
        callId: `s-${index}`,
        message: { role: 'tool', isError: false, content: [{ type: 'text', text: `密集事件-${index}` }] },
      })),
    ];
    const runner: TaskRunner = (input: TaskRunInput): RunHandle => {
      for (const event of generated) input.onEvent(event);
      return {
        pid: 1,
        cancel: () => undefined,
        outcome: Promise.resolve(makeRunOutcome({ finalText: 'ok', sessionId: 'sess-run-budget' })),
      };
    };
    const manager = new TaskManager({ runner, store: new MemoryStore(), config });
    await manager.init();
    cleanups.push(() => manager.stop());
    const server = createWorkerServer({ manager, config });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'status-run-budget', version: '1.0.0' });
    await client.connect(clientTransport);
    cleanups.push(() => client.close());
    cleanups.push(() => server.close());

    const run = parsePayload(
      await client.callTool({
        name: 'dsh_run',
        arguments: { task: 'run-budget', cwd: process.cwd(), wait_s: 10 },
      }),
    );
    const runBytes = utf8Bytes(JSON.stringify(run));
    const runEvents = (run.events ?? []) as RunEvent[];
    console.log(`[status-budget] 4096 run metadata run=${runBytes}B events=${runEvents.length}`);
    expect(run.status).toBe('succeeded');
    expect(runBytes).toBeLessThanOrEqual(budget);
    expect(runEvents.length).toBeGreaterThan(0);
    expect(run.next_cursor).toBe(Number(runEvents.at(-1)?.seq) + 1);
    expect(run.events_truncated).toBe(true);

    const status = await manager.status(String(run.task_id));
    expect(utf8Bytes(JSON.stringify(status))).toBeLessThanOrEqual(budget);
    expect(status.events.length).toBeGreaterThan(0);
  }, 30_000);
});
