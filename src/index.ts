#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AuditLog } from './audit.js';
import { BatchManager } from './batch-manager.js';
import { loadConfig } from './config.js';
import { ensureDshCompatPatches } from './dsh-patch.js';
import { startDshRun } from './dsh-runner.js';
import { createFallbackRunner } from './fallback-runner.js';
import { startHttpServer, type RunningHttpServer } from './http-server.js';
import { IdempotencyStore } from './idempotency.js';
import { OtelSpanExporter } from './otel.js';
import { Notifier } from './notifier.js';
import { createWorkerServer } from './server.js';
import { SdkBackendPool } from './sdk-pool.js';
import { createSdkRunner } from './sdk-runner.js';
import { JsonlTaskStore } from './store.js';
import { TaskManager, type TaskRunner } from './task-manager.js';

const config = loadConfig(process.env);
const log = (message: string): void => {
  process.stderr.write(`[dsh-mcp-worker] ${message}\n`);
};

// DSH 兼容检查：read-only 沙箱下 pwsh 编码前缀会报错、无控制台时中文输出按 GBK 写出；启动时自动检测/修复
const dshPatches = await ensureDshCompatPatches(config.dsh, config.dshPatch);
for (const patch of dshPatches) {
  log(`DSH 兼容检查（${patch.name}）：${patch.message}${patch.file ? `；文件=${patch.file}` : ''}`);
}

const headlessRunner: TaskRunner = (input) =>
  startDshRun({
    task: input.task,
    cwd: input.cwd,
    sessionId: input.sessionId,
    permissionMode: input.permissionMode,
    timeoutMs: input.timeoutMs,
    profile: config.profile,
    spawn: config.dsh,
    onEvent: input.onEvent,
  });

let sdkPool: SdkBackendPool | undefined;
const runner: TaskRunner =
  config.backend === 'sdk'
    ? (() => {
        sdkPool = new SdkBackendPool({
          spawn: config.dsh,
          profile: config.sdk.profile,
          provider: config.sdk.provider,
          model: config.sdk.model,
          ...(config.sdk.reasoningEffort ? { reasoningEffort: config.sdk.reasoningEffort } : {}),
          ...(config.sdk.maxTokens ? { maxTokens: config.sdk.maxTokens } : {}),
          idleMs: config.sdk.idleMs,
          initTimeoutMs: config.sdk.initTimeoutMs,
        });
        const sdkRunner = createSdkRunner(sdkPool);
        // sdk 长驻后端起不来（initialize 超时/进程退出）时自动降级 headless，避免 leader 直接看到失败
        return createFallbackRunner({ primary: sdkRunner, fallback: headlessRunner });
      })()
    : headlessRunner;

const store = new JsonlTaskStore(config.tasksDir);
const audit = new AuditLog(config.auditDir);
await audit.init();
const otel = new OtelSpanExporter({
  endpoint: config.otelEndpoint ?? '',
  serviceName: config.otelServiceName,
});
const notifier = new Notifier({ webhook: config.notifyWebhook, cmd: config.notifyCmd });

const TERMINAL_AUDIT_EVENTS = new Set(['task_succeeded', 'task_failed', 'task_cancelled']);
let managerRef!: TaskManager;
const manager = new TaskManager({
  runner,
  store,
  config,
  audit: (entry) => {
    void audit.append(entry).catch(() => undefined);
    if (TERMINAL_AUDIT_EVENTS.has(entry.event) && entry.task_id) {
      const record = managerRef.get(entry.task_id);
      if (record) otel.exportTask(record);
      void notifier.notify({
        event: entry.event,
        task_id: entry.task_id,
        status: entry.event.replace('task_', ''),
        cwd: entry.cwd,
        session_id: entry.session_id,
        detail: entry.detail,
      });
    }
  },
});
managerRef = manager;

const runtimeInfo = (): Record<string, unknown> => ({
  backend: config.backend,
  sdk_pool: sdkPool?.stats() ?? null,
  uptime_s: Math.round(process.uptime()),
  rss_mb: Math.round(process.memoryUsage().rss / 1_000_000),
  transport: config.transport,
  otel: { enabled: otel.enabled, endpoint: config.otelEndpoint ?? null, service: config.otelServiceName },
  dsh_patch: {
    mode: config.dshPatch,
    items: dshPatches.map((patch) => ({ name: patch.name, status: patch.status, message: patch.message })),
  },
});

await manager.init();

const batches = new BatchManager(manager, config.batchDir, config.maxBatchTasks);
await batches.init();

// 幂等键索引：跨重启保留 24h（DSH_MCP_IDEM_TTL_H），leader 重试不会重复派活。
const idem = new IdempotencyStore(config.idemDir, config.idemTtlMs);
await idem.init();
const prunedIdem = await idem.prune().catch(() => 0);
if (prunedIdem > 0) log(`清理过期幂等索引 ${prunedIdem} 个`);

let mcpServer: ReturnType<typeof createWorkerServer> | undefined;
let httpServer: RunningHttpServer | undefined;

if (config.transport === 'http') {
  httpServer = await startHttpServer({ manager, config, audit, batches, runtimeInfo, idem });
  log(`传输=HTTP（无状态 Streamable HTTP）：${httpServer.url}`);
  log(
    `鉴权=${config.http.token ? 'Bearer（已启用）' : '无（仅回环地址可用）'}；健康检查=${httpServer.url.replace(/\/mcp$/, '')}/healthz`,
  );
} else {
  mcpServer = createWorkerServer({ manager, config, audit, batches, runtimeInfo, idem });
  await mcpServer.connect(new StdioServerTransport());
  log('传输=stdio');
}

log(`已启动：dsh 入口=${config.dsh.source}`);
if (config.backend === 'sdk') {
  log(
    `后端=sdk 长驻（profile=${config.sdk.profile}，provider/model=${config.sdk.provider}/${config.sdk.model}，空闲回收=${Math.round(
      config.sdk.idleMs / 60_000,
    )}min）`,
  );
} else {
  log(`后端=headless（每任务一个进程，profile=${config.profile}）`);
}
log(`默认 cwd=${config.defaultCwd ?? '(缺省用调用方 cwd)'}；任务目录=${config.tasksDir}`);
log(
  `默认权限=${config.defaultPermissionMode}；并发=${config.maxConcurrent}（每 cwd ${config.maxConcurrentPerCwd}）；超时=${Math.round(
    config.defaultTimeoutMs / 1000,
  )}s`,
);
log(
  `任务保留=${Math.round(config.taskTtlMs / 60_000)}min / 上限 ${config.maxTasks} 个；审计日志=${audit.filePath}`,
);
log(
  `幂等索引=${config.idemDir}（TTL ${Math.round(config.idemTtlMs / 3_600_000)}h）；费用单价 in/cacheRead/out=` +
    `$${config.pricing.inputPerMTok}/$${config.pricing.cacheReadPerMTok}/$${config.pricing.outputPerMTok} per Mtok，汇率=${config.pricing.usdCny}`,
);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`收到 ${signal}，正在退出…`);
  manager.abortAll();
  manager.stop();
  // 给结果回写留一点时间，避免 meta 停在 running
  await new Promise((resolve) => setTimeout(resolve, 200));
  if (sdkPool) await sdkPool.shutdown().catch(() => undefined);
  if (httpServer) await httpServer.close().catch(() => undefined);
  try {
    await mcpServer?.close();
  } catch {
    // 忽略关闭期错误
  }
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
// stdio 传输：父进程（leader）退出时 stdin 会关闭，此时终止运行中的 worker，避免留下孤儿进程。
// 合并自本机 Codex 在用的 dsh-mcp bridge v2.2.0（stdin end/close → kill 进程组）。
if (config.transport !== 'http') {
  process.stdin.on('end', () => void shutdown('stdin 已关闭'));
  process.stdin.on('close', () => void shutdown('stdin 已关闭'));
}
process.on('unhandledRejection', (reason) => {
  log(`unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});
