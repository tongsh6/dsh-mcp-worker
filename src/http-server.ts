import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AuditLog } from './audit.js';
import type { BatchManager } from './batch-manager.js';
import type { WorkerConfig } from './config.js';
import type { IdempotencyStore } from './idempotency.js';
import { createWorkerServer } from './server.js';
import type { TaskManager } from './task-manager.js';

export interface HttpServerDeps {
  manager: TaskManager;
  config: WorkerConfig;
  audit?: AuditLog;
  batches?: BatchManager;
  runtimeInfo?: () => Record<string, unknown>;
  /** 幂等键索引（HTTP 模式各请求共享同一份落盘索引）。 */
  idem?: IdempotencyStore;
}

export interface RunningHttpServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** 非回环地址必须带 Bearer token，避免把 worker 裸奔到局域网。 */
export function validateHttpConfig(config: WorkerConfig): void {
  if (!LOOPBACK_HOSTS.has(config.http.host.toLowerCase()) && config.http.token.length === 0) {
    throw new Error(`拒绝在非回环地址 ${config.http.host} 上无鉴权启动：请设置 DSH_MCP_HTTP_TOKEN`);
  }
}

/**
 * Streamable HTTP 传输（无状态模式）：
 * - `POST /mcp` 处理 MCP JSON-RPC；
 * - `GET /healthz` 探活；
 * - `Authorization: Bearer <DSH_MCP_HTTP_TOKEN>` 鉴权（回环地址可空 token）。
 * 每个请求创建独立的 McpServer + transport（无状态），任务状态由 TaskManager 共享。
 */
export async function startHttpServer(deps: HttpServerDeps): Promise<RunningHttpServer> {
  validateHttpConfig(deps.config);

  const httpServer = createServer((req, res) => {
    void handleRequest(deps, req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[dsh-mcp-worker] HTTP 请求处理失败：${message}\n`);
      if (!res.headersSent) {
        writeJsonRpc(res, 500, { code: -32603, message: `internal error: ${message}` });
        return;
      }
      res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(deps.config.http.port, deps.config.http.host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const address = httpServer.address();
  const port = typeof address === 'object' && address !== null ? address.port : deps.config.http.port;
  const displayHost = LOOPBACK_HOSTS.has(deps.config.http.host.toLowerCase())
    ? deps.config.http.host
    : '127.0.0.1';

  return {
    url: `http://${displayHost}:${port}/mcp`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.closeAllConnections?.();
        httpServer.close(() => resolve());
      }),
  };
}

async function handleRequest(deps: HttpServerDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/healthz') {
    writeJson(res, 200, {
      ok: true,
      name: deps.config.name,
      version: deps.config.version,
      backend: deps.config.backend,
    });
    return;
  }

  if (url.pathname !== '/mcp') {
    writeJson(res, 404, { error: 'not_found' });
    return;
  }

  if (!isAuthorized(req, deps.config.http.token)) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="dsh-mcp-worker"');
    writeJsonRpc(res, 401, { code: -32001, message: 'unauthorized: 缺少或错误的 Bearer token' });
    return;
  }

  if (req.method !== 'POST') {
    // 无状态模式不提供独立 SSE 流 / 会话删除
    res.setHeader('Allow', 'POST');
    writeJsonRpc(res, 405, { code: -32000, message: 'method not allowed（本服务为无状态模式，仅支持 POST /mcp）' });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    writeJsonRpc(res, 400, {
      code: -32700,
      message: `parse error: ${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }

  const server = createWorkerServer({
    manager: deps.manager,
    config: deps.config,
    ...(deps.audit ? { audit: deps.audit } : {}),
    ...(deps.batches ? { batches: deps.batches } : {}),
    ...(deps.runtimeInfo ? { runtimeInfo: deps.runtimeInfo } : {}),
    ...(deps.idem ? { idem: deps.idem } : {}),
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

function isAuthorized(req: IncomingMessage, expectedToken: string): boolean {
  if (expectedToken.length === 0) return true; // 仅允许回环地址（已在启动时校验）
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  const provided = match[1]?.trim() ?? '';
  // 先哈希再定长比较，避免长度/时序侧信道
  const providedHash = createHash('sha256').update(provided).digest();
  const expectedHash = createHash('sha256').update(expectedToken).digest();
  return providedHash.length === expectedHash.length && timingSafeEqual(providedHash, expectedHash);
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error(`请求体超过 ${MAX_BODY_BYTES} 字节`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim().length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function writeJsonRpc(res: ServerResponse, status: number, error: { code: number; message: string }): void {
  writeJson(res, status, { jsonrpc: '2.0', error, id: null });
}
