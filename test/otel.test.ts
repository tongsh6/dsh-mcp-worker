import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { OtelSpanExporter, buildPayload } from '../src/otel.js';
import type { TaskRecord } from '../src/types.js';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await Promise.resolve(fn()).catch(() => undefined);
});

interface CapturedRequest {
  url: string;
  body: any;
}

async function startCollector(): Promise<{ endpoint: string; captured: CapturedRequest[]; server: Server }> {
  const captured: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      raw += chunk;
    });
    req.on('end', () => {
      captured.push({ url: req.url ?? '', body: JSON.parse(raw || '{}') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { endpoint: `http://127.0.0.1:${port}/v1/traces`, captured, server };
}

function makeRecord(partial: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1234',
    status: 'succeeded',
    task: 'do work',
    cwd: 'C:\\proj',
    permissionMode: 'workspace-write',
    createdAt: 1_700_000_000_000,
    startedAt: 1_700_000_000_100,
    endedAt: 1_700_000_002_100,
    events: [{ type: 'final', text: 'ok' }],
    timedOut: false,
    ...partial,
  };
}

describe('OtelSpanExporter', () => {
  it('未配置 endpoint 时完全关闭', async () => {
    const { endpoint, captured } = await startCollector();
    const exporter = new OtelSpanExporter({ endpoint: '', serviceName: 'svc' });
    expect(exporter.enabled).toBe(false);
    exporter.exportTask(makeRecord());
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(captured).toHaveLength(0);
    void endpoint;
  });

  it('导出 OTLP/HTTP JSON span', async () => {
    const { endpoint, captured } = await startCollector();
    const exporter = new OtelSpanExporter({ endpoint, serviceName: 'svc-test', timeoutMs: 2_000 });
    exporter.exportTask(makeRecord());
    const deadline = Date.now() + 3_000;
    while (captured.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(captured).toHaveLength(1);
    const payload = captured[0]!.body;
    const resourceSpan = payload.resourceSpans[0];
    expect(resourceSpan.resource.attributes).toContainEqual({ key: 'service.name', value: { stringValue: 'svc-test' } });
    const span = resourceSpan.scopeSpans[0].spans[0];
    expect(span.name).toBe('dsh.task');
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.attributes).toContainEqual({ key: 'dsh.task_id', value: { stringValue: 'task-1234' } });
    expect(span.status.code).toBe(1);
  });

  it('buildPayload 对失败任务标记 error 状态', () => {
    const payload = buildPayload(
      makeRecord({ status: 'failed', error: 'boom', timedOut: true }),
      'svc-test',
    );
    const span = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(span.status.code).toBe(2);
    expect(span.status.message).toBe('boom');
    expect(span.attributes).toContainEqual({ key: 'dsh.timed_out', value: { intValue: '1' } });
  });
});
