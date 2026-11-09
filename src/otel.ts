import { createHash } from 'node:crypto';
import type { TaskRecord } from './types.js';

export interface OtelSpanExporterOptions {
  /** OTLP/HTTP traces 端点，例如 http://127.0.0.1:4318/v1/traces；空串表示关闭。 */
  endpoint: string;
  serviceName: string;
  timeoutMs?: number;
}

interface SpanAttribute {
  key: string;
  value: { stringValue: string } | { intValue: string };
}

export interface OtlpTracePayload {
  resourceSpans: Array<{
    resource: { attributes: SpanAttribute[] };
    scopeSpans: Array<{
      scope: { name: string };
      spans: Array<{
        traceId: string;
        spanId: string;
        name: string;
        kind: number;
        startTimeUnixNano: string;
        endTimeUnixNano: string;
        attributes: SpanAttribute[];
        status: { code: number; message?: string };
      }>;
    }>;
  }>;
}

/**
 * 轻量 OTel 导出：不引入 OTel SDK，直接把每个任务的 span 以 OTLP/HTTP JSON 推给 collector。
 * 失败只记 stderr，绝不影响任务本身；未配置 endpoint 时完全关闭。
 */
export class OtelSpanExporter {
  private readonly timeoutMs: number;

  constructor(private readonly options: OtelSpanExporterOptions) {
    this.timeoutMs = options.timeoutMs ?? 3_000;
  }

  get enabled(): boolean {
    return this.options.endpoint.trim().length > 0;
  }

  exportTask(record: TaskRecord): void {
    if (!this.enabled) return;
    const payload = buildPayload(record, this.options.serviceName);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    void fetch(this.options.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) {
          process.stderr.write(`[dsh-mcp-worker] OTel 导出失败：HTTP ${response.status}\n`);
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[dsh-mcp-worker] OTel 导出失败：${message}\n`);
      })
      .finally(() => clearTimeout(timer));
  }
}

export function buildPayload(record: TaskRecord, serviceName: string): OtlpTracePayload {
  const seed = createHash('sha256').update(record.id).digest('hex');
  const traceId = seed.slice(0, 32);
  const spanId = seed.slice(0, 16);
  const startMs = record.startedAt ?? record.createdAt;
  const endMs = record.endedAt ?? startMs;
  const attributes: SpanAttribute[] = [
    { key: 'dsh.task_id', value: { stringValue: record.id } },
    { key: 'dsh.status', value: { stringValue: record.status } },
    { key: 'dsh.cwd', value: { stringValue: record.cwd } },
    { key: 'dsh.permission_mode', value: { stringValue: record.permissionMode } },
    { key: 'dsh.timed_out', value: { intValue: record.timedOut ? '1' : '0' } },
    { key: 'dsh.events', value: { intValue: String(record.events.length) } },
  ];
  if (record.sessionId) attributes.push({ key: 'dsh.session_id', value: { stringValue: record.sessionId } });
  if (record.error) attributes.push({ key: 'dsh.error', value: { stringValue: record.error.slice(0, 500) } });

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: 'service.name', value: { stringValue: serviceName } }],
        },
        scopeSpans: [
          {
            scope: { name: 'dsh-mcp-worker' },
            spans: [
              {
                traceId,
                spanId,
                name: 'dsh.task',
                kind: 1,
                startTimeUnixNano: `${startMs}000000`,
                endTimeUnixNano: `${endMs}000000`,
                attributes,
                status: {
                  code: record.status === 'succeeded' ? 1 : record.status === 'cancelled' ? 0 : 2,
                  ...(record.error ? { message: record.error.slice(0, 200) } : {}),
                },
              },
            ],
          },
        ],
      },
    ],
  };
}
