import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { detectApprovalRequired } from './approval.js';
import { readTaskArtifact } from './artifacts.js';
import type { AuditLog } from './audit.js';
import type { BatchManager } from './batch-manager.js';
import { PERMISSION_MODES, validateCwd, type WorkerConfig } from './config.js';
import { WorkerError } from './errors.js';
import { EVENT_SUMMARY_MAX_BYTES, summarizeEvent, utf8ByteLength } from './event-summary.js';
import { boundText } from './output.js';
import { injectReportProtocol } from './report-protocol.js';
import { searchTasks } from './search.js';
import type { TaskManager } from './task-manager.js';
import type { RunEvent, TaskRecord, TaskStatus } from './types.js';

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const RUN_PERMISSION_MODES = [...PERMISSION_MODES, 'auto'] as unknown as [string, ...string[]];

const INSTRUCTIONS = [
  'DSH（DeepSeek Harness）worker：把可验收的完整工作单元交给本机 DSH 执行，并返回结果。',
  '粒度原则（最重要）：一个 dsh_run = 一个可独立验收的工作单元，默认包含「定位 → 实现/修改 → 自测 → 证据汇总」。典型粒度：一个功能点、一个 bug、一个测试修复批次、一次跨文件重构。禁止把同一工作拆成逐文件/逐命令/逐步骤的微任务——那会让 leader 付出更多思考与往返 token，反而更慢。',
  '分工原则：leader 负责决策与验收，DSH 负责执行与迭代；执行密集（读代码/改文件/跑测试/机械重构/批量核对）交给 DSH，需要业务语义/方案权衡/根因判断时 leader 先决策再外包。任务建议写 [已定决策] 与 [待你判断]，DSH 遇到需决策的分支应停下汇报，不要猜。',
  '任务文本四要素：目标（做什么、为什么）、范围（可改/不可改、入口文件可选——不知道就不写）、验收（要跑的命令与期望结果，失败附输出）、证据（变更文件清单 + 测试结果 + 风险点）。给目标与约束，不要让 DSH 逐步等你确认；DSH 会自己规划多步工具调用。',
  '使用顺序：1) dsh_run 提交（可带 wait_s=60–120 在本次调用里直接等结果）；2) dsh_status(task_id, wait_s=长轮询，建议 60–120s) 等到终态；3) dsh_result 取结果；中断用 dsh_cancel。不要 5–25 秒高频轮询，也不要在 DSH 执行期间重复做同一件事。',
  'cwd 必须是具体项目目录绝对路径（不要用用户主目录；Windows 沙箱下 shell 可能不可用）。',
  'permission_mode：默认 auto（worker 按 cwd 能力自动选 workspace-write / worktree / read-only / danger-full-access，调用方不需要手选）；也可显式传 read-only / workspace-write / danger-full-access。',
  '并行：彼此独立的工作流用一次 dsh_batch_run 派发（每个任务仍各自包含完整验收），不要拆成串行小任务。',
  '续聊：同一工作单元后续修正把首次返回的 session_id 传回 dsh_run，不要新建多个孤立任务。',
  '验收：leader 只审阅结构化事实并决定是否返工——优先看 dsh_result 的 evidence（命令退出码/变更文件/git diff 摘要）与 outcome；outcome=needs_decision 时用原 session_id 回答；output 是 DSH 的叙述，不作为唯一依据。不要逐步重做 DSH 已完成的工作；DSH 失败时把 error 原样反馈用户。',
  '历史任务用 dsh_tasks 回顾；审计事件用 dsh_audit；dsh_result 输出过长落盘时用 dsh_read_result 分页读取（source=result/events/diff/evidence）；运行指标用 dsh_metrics。',
  '长任务依赖异步任务模型：不要在一次工具调用里反复短轮询等待。',
].join('\n');

export interface WorkerServerDeps {
  manager: TaskManager;
  config: WorkerConfig;
  /** 可选：审计日志（HTTP 模式由 index 注入；未注入时 dsh_audit 返回错误）。 */
  audit?: AuditLog;
  /** 可选：批量任务管理器（未注入时批量工具返回错误）。 */
  batches?: BatchManager;
  /** 可选：运行时信息（进程/后端池/OTel 状态），供 dsh_metrics 使用。 */
  runtimeInfo?: () => Record<string, unknown>;
}

export function createWorkerServer(deps: WorkerServerDeps): McpServer {
  const { manager, config } = deps;
  const server = new McpServer(
    { name: config.name, version: config.version },
    { instructions: INSTRUCTIONS, capabilities: { tools: {} } },
  );
  const mcpMetrics = createMcpMetrics();
  (server as unknown as { __mcpMetrics?: McpMetrics }).__mcpMetrics = mcpMetrics;

  const ok = (payload: Record<string, unknown>) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  });

  const fail = (error: unknown) => {
    const code = error instanceof WorkerError ? error.code : 'internal';
    const message = error instanceof Error ? error.message : String(error);
    return {
      isError: true,
      content: [{ type: 'text' as const, text: `DSH worker 错误 [${code}]：${message}` }],
      structuredContent: { error: { code, message } },
    };
  };

  registerTool(server, 'dsh_run', {
    title: '提交 DSH 任务',
    description:
      '把一个可验收的完整工作单元（功能点/bug/测试修复批次/跨文件重构）交给本机 DSH 异步执行，立即返回 task_id。DSH 自己规划并执行多步工具调用（读代码、改文件、跑测试），一次任务应覆盖「实现 + 自测 + 证据」；不要提交单步/逐文件微任务。之后用 dsh_status 长轮询（wait_s 60–120）到终态，dsh_result 取结果；中断用 dsh_cancel。cwd 传当前项目绝对路径。',
    inputSchema: {
      task: z
        .string()
        .min(1)
        .describe(
          '完整工作单元描述，建议包含：目标、[已定决策]、[待你判断]、[入口]（可选）、范围（可改/不可改）、验收命令与期望、证据要求；给目标与约束，不要写逐步操作清单',
        ),
      cwd: z.string().optional().describe('任务执行目录（绝对路径）；缺省依次用 DSH_MCP_DEFAULT_CWD、worker 进程 cwd'),
      session_id: z.string().optional().describe('续聊已有 DSH 会话时传入；同一 session 的任务串行执行'),
      permission_mode: z
        .enum(RUN_PERMISSION_MODES)
        .optional()
        .describe('权限模式，默认 auto（worker 按 cwd 能力自动选 workspace-write / danger-full-access）'),
      timeout_s: z.number().int().min(5).max(86_400).optional().describe('任务超时秒数，默认 900；大任务可设 1800–3600'),
      wait_s: z
        .number()
        .min(0)
        .max(600)
        .optional()
        .describe('可选：提交后在本次调用里等待最多 N 秒（建议 60–120），减少 dsh_status 往返；任务未结束时返回中间状态'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    handler: async (args, extra) => {
      try {
        // cwd 优先级：显式参数 > DSH_MCP_DEFAULT_CWD > worker 进程 cwd（stdio 启动时通常是 leader 的项目目录）
        const rawCwd = args.cwd ?? config.defaultCwd ?? process.cwd();
        const cwd = validateCwd(rawCwd, config);
        const progressToken = extra._meta?.progressToken;
        const record = await manager.create(
          {
            task: config.reportProtocol ? injectReportProtocol(args.task) : args.task,
            cwd,
            sessionId: args.session_id,
            permissionMode: args.permission_mode,
            timeoutMs: args.timeout_s ? args.timeout_s * 1_000 : undefined,
          },
          {
            onProgress:
              progressToken !== undefined
                ? (progress, message) => {
                    void sendProgress(extra, progressToken, progress, message);
                  }
                : undefined,
          },
        );
        const created = {
          task_id: record.id,
          status: record.status,
          session_id: record.sessionId ?? null,
          cwd: record.cwd,
          permission_mode: record.permissionMode,
          created_at: record.createdAt,
          hint: '任务已受理：用 dsh_status 轮询（wait_s 可长轮询取增量事件），结束后用 dsh_result 取结果；需要中断用 dsh_cancel。',
        };
        if (!args.wait_s || args.wait_s <= 0) return ok(created);
        const deadline = Date.now() + args.wait_s * 1_000;
        let status = await manager.status(record.id, { waitMs: args.wait_s * 1_000 });
        let firstPage: typeof status | null = status.events.length > 0 ? status : null;
        while (!isTerminal(status.status) && Date.now() < deadline) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          const next = await manager.status(record.id, { cursor: status.next_cursor, waitMs: remaining });
          if (!firstPage && next.events.length > 0) firstPage = next;
          const noProgress = next.next_cursor === status.next_cursor && !isTerminal(next.status);
          status = next;
          if (noProgress) break; // 已等满，避免空转
        }
        // 终态那次轮询可能是空增量：run 返回等待期间第一页非空摘要，保持 events 与 next_cursor 对应。
        const visible = firstPage ?? status;
        const hint = isTerminal(status.status)
          ? '任务已结束：用 dsh_result 取结果；完整原始事件用 dsh_read_result(source=events) 读取。'
          : '仍在运行：用 dsh_status(cursor=next_cursor, wait_s=60~120) 继续等待。';
        const runBase: Record<string, unknown> = {
          ...created,
          session_id: status.session_id ?? created.session_id ?? null,
          status: status.status,
          outcome: status.outcome ?? null,
          waited_s: args.wait_s,
          finished: isTerminal(status.status),
          phase: status.phase,
          progress: status.progress,
          tokens: status.tokens ?? null,
          steps: status.steps,
          tool_calls: status.tool_calls,
          events: [] as RunEvent[],
          events_truncated: visible.events_truncated ?? false,
          next_cursor: Number(visible.events[0]?.seq ?? 0),
          hint,
        };
        return ok(fitRunPayload(runBase, visible.events, config.maxStatusPayloadBytes));
      } catch (error) {
        return fail(error);
      }
    },
  });

  registerTool(server, 'dsh_status', {
    title: '查询 DSH 任务状态',
    description:
      `查询任务状态与增量事件摘要（单条事件 ≤ ${EVENT_SUMMARY_MAX_BYTES / 1024}KiB，单次载荷 ≤ ${Math.round(
        config.maxStatusPayloadBytes / 1024,
      )}KiB）；完整原始事件仍会落盘，用 dsh_read_result(source=events) 分页读取。默认 detail=summary 只返回状态/异常事件与 last_text（省 leader 上下文）；排查 worker 行为时用 detail=events。status 为 succeeded/failed/cancelled 表示结束，outcome 给出 completed/needs_decision/failed/cancelled。用 wait_s 长轮询（建议 60–120s）一次等更久，减少 leader 往返；不要用 5–25s 高频轮询。`,
    inputSchema: {
      task_id: z.string().min(1).describe('dsh_run 返回的任务 id'),
      cursor: z.number().int().min(0).optional().describe('上次返回的 next_cursor，用于只取增量事件'),
      wait_s: z
        .number()
        .min(0)
        .max(600)
        .optional()
        .describe(
          `长轮询等待秒数（默认 0）；实际上限由 worker 配置 DSH_MCP_STATUS_WAIT_MAX_S 决定（当前 ${Math.round(config.statusWaitMaxMs / 1_000)}s）`,
        ),
      detail: z
        .enum(['summary', 'events'])
        .optional()
        .describe('summary=仅状态与异常事件（默认，省 leader 上下文）；events=返回全部工具/文本事件（排查用）'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (args) => {
      try {
        const payload = await manager.status(args.task_id, {
          cursor: args.cursor,
          waitMs: (args.wait_s ?? 0) * 1_000,
          detail: args.detail,
        });
        return ok({ ...payload });
      } catch (error) {
        return fail(error);
      }
    },
  });

  registerTool(server, 'dsh_result', {
    title: '获取 DSH 任务结果',
    description:
      '任务结束后获取最终结果。验收优先看 `evidence`（命令退出码、变更文件、git diff 摘要）与 `outcome`（completed/needs_decision/failed/cancelled）；失败/取消时看 `failure_kind`（如 sandbox_acl）、`sandbox_blocked`/`sandbox_blocked_detail` 与 `attempts`（逐次尝试 + 首次决策文本，避免归因丢失）；`output` 是 DSH 的叙述。输出过大时会自动落盘并返回文件路径。任务未结束时返回错误。',
    inputSchema: {
      task_id: z.string().min(1).describe('dsh_run 返回的任务 id'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (args) => {
      try {
        const payload = await manager.result(args.task_id);
        let output = payload.output;
        const artifacts: Array<{ kind: string; path: string }> = [];
        if (output && output.length > config.maxResultChars) {
          const bounded = await boundText(output, {
            maxChars: config.maxResultChars,
            spillDir: config.tasksDir,
            taskId: payload.task_id,
          });
          output = bounded.text;
          if (bounded.path) artifacts.push({ kind: 'result', path: bounded.path });
        }
        const record = manager.get(args.task_id);
        let approval: ApprovalBridgeResult = { required: false };
        if (record && payload.status === 'failed' && detectApprovalRequired(record)) {
          approval = await bridgeApproval(server, manager, record, config);
        }
        return ok({
          ...payload,
          output,
          artifacts,
          approval,
          ...(artifacts.length > 0
            ? { read_hint: '完整产物可用 dsh_read_result（source=result/events，offset 分页）读取' }
            : {}),
        });
      } catch (error) {
        return fail(error);
      }
    },
  });

  registerTool(server, 'dsh_cancel', {
    title: '取消 DSH 任务',
    description: '取消排队中或运行中的任务：运行中的任务会杀掉整个进程树。',
    inputSchema: {
      task_id: z.string().min(1).describe('dsh_run 返回的任务 id'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    handler: async (args) => {
      try {
        return ok({ ...(await manager.cancel(args.task_id)) });
      } catch (error) {
        return fail(error);
      }
    },
  });

  registerTool(server, 'dsh_describe', {
    title: '描述 DSH worker 能力',
    description: '返回 worker 版本、DSH 入口、默认参数与限制，便于 leader 自适应调用方式。',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async () => {
      try {
        return ok({
          name: config.name,
          version: config.version,
          tools: [
            'dsh_run',
            'dsh_status',
            'dsh_result',
            'dsh_cancel',
            'dsh_tasks',
            'dsh_audit',
            'dsh_read_result',
            'dsh_batch_run',
            'dsh_batch_status',
            'dsh_batch_result',
            'dsh_search',
            'dsh_metrics',
            'dsh_describe',
          ],
          dsh: {
            source: config.dsh.source,
            profile: config.backend === 'sdk' ? config.sdk.profile : config.profile,
            home: config.dshHome,
          },
          backend: config.backend,
          ...(config.backend === 'sdk'
            ? {
                sdk: {
                  profile: config.sdk.profile,
                  provider: config.sdk.provider,
                  model: config.sdk.model,
                  idle_min: Math.round(config.sdk.idleMs / 60_000),
                  init_timeout_s: Math.round(config.sdk.initTimeoutMs / 1_000),
                },
              }
            : {}),
          defaults: {
            permission_mode: config.defaultPermissionMode,
            permission_modes: PERMISSION_MODES,
            timeout_s: Math.round(config.defaultTimeoutMs / 1_000),
            cwd: config.defaultCwd ?? null,
            allowed_cwds: config.allowedCwds,
          },
          limits: {
            max_concurrent: config.maxConcurrent,
            max_concurrent_per_cwd: config.maxConcurrentPerCwd,
            max_result_chars: config.maxResultChars,
            max_status_events: config.maxStatusEvents,
            max_status_payload_bytes: config.maxStatusPayloadBytes,
            max_event_summary_bytes: EVENT_SUMMARY_MAX_BYTES,
            evidence_git: config.evidenceGit,
            report_protocol: config.reportProtocol,
            status_detail: config.statusDetail,
            task_ttl_min: Math.round(config.taskTtlMs / 60_000),
            max_tasks: config.maxTasks,
            cleanup_interval_min: Math.round(config.cleanupIntervalMs / 60_000),
            max_batch_tasks: config.maxBatchTasks,
          },
          otel: {
            enabled: Boolean(config.otelEndpoint),
            endpoint: config.otelEndpoint ?? null,
            service: config.otelServiceName,
          },
          dsh_patch: (deps.runtimeInfo?.() ?? {})['dsh_patch'] ?? {
            status: 'unknown',
            mode: config.dshPatch,
          },
          audit_file: deps.audit?.filePath ?? null,
          tasks_dir: config.tasksDir,
          instructions: INSTRUCTIONS,
        });
      } catch (error) {
        return fail(error);
      }
    },
  });

  registerTool(server, 'dsh_tasks', {
    title: '列出 DSH 任务',
    description:
      '列出最近的任务摘要（task_id / 状态 / 任务预览 / cwd / 时间 / 错误），用于回顾历史与继续轮询。',
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional().describe('返回条数，默认 20'),
      status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']).optional().describe('按状态过滤'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (args) => {
      try {
        const tasks = manager.summaries(args.limit ?? 20, args.status as TaskStatus | undefined);
        return ok({ count: tasks.length, tasks });
      } catch (error) {
        return fail(error);
      }
    },
  });

  registerTool(server, 'dsh_audit', {
    title: '查询审计日志',
    description: '读取最近的审计事件（任务创建/开始/结束/取消、审批决定等），用于追溯与排障。',
    inputSchema: {
      limit: z.number().int().min(1).max(200).optional().describe('返回最近多少条，默认 50'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (args) => {
      try {
        if (!deps.audit) {
          throw new WorkerError('bad_request', '审计日志未启用（服务未注入 AuditLog）');
        }
        const entries = await deps.audit.read(args.limit ?? 50);
        return ok({ count: entries.length, file: deps.audit.filePath, entries });
      } catch (error) {
        return fail(error);
      }
    },
  });

  registerTool(server, 'dsh_read_result', {
    title: '读取任务完整产物',
    description:
      '分页读取任务落盘产物：result=最终结果（超长落盘时）、events=完整事件流、diff=git.patch、evidence=结构化证据 JSON。仅限任务目录内。',
    inputSchema: {
      task_id: z.string().min(1).describe('任务 id'),
      source: z
        .enum(['result', 'events', 'diff', 'evidence'])
        .optional()
        .describe('result=最终结果；events=事件流 JSONL；diff=完整 diff.patch；evidence=结构化证据 JSON；默认 result'),
      offset: z.number().int().min(0).optional().describe('字符偏移，默认 0'),
      max_chars: z.number().int().min(100).max(100_000).optional().describe('本次最多返回字符数，默认 20000'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (args) => {
      try {
        const payload = await readTaskArtifact(
          config.tasksDir,
          args.task_id,
          args.source ?? 'result',
          args.offset ?? 0,
          args.max_chars ?? 20_000,
        );
        return ok({ ...payload });
      } catch (error) {
        return fail(error);
      }
    },
  });

  registerTool(server, 'dsh_batch_run', {
    title: '批量提交 DSH 任务',
    description:
      '一次并行派发多个彼此独立、各自可验收的工作单元（每个任务仍应覆盖「实现+自测+证据」），立即返回 batch_id；用 dsh_batch_status / dsh_batch_result 聚合查询。不要用它串行拆解同一工作流。',
    inputSchema: {
      tasks: z
        .array(
          z.object({
            task: z.string().min(1).describe('完整工作单元描述（目标/范围/验收/证据），不是单步指令'),
            cwd: z.string().optional().describe('该任务的执行目录；缺省用默认 cwd'),
            session_id: z.string().optional().describe('该任务续用的 session'),
            permission_mode: z.enum(PERMISSION_MODES as [string, ...string[]]).optional(),
            timeout_s: z.number().int().min(5).max(86_400).optional(),
          }),
        )
        .min(1)
        .describe(`任务数组（1–${config.maxBatchTasks} 个）`),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    handler: async (args) => {
      try {
        if (!deps.batches) throw new WorkerError('bad_request', '批量任务未启用（服务未注入 BatchManager）');
        const taskInputs = args.tasks as Array<{
          task: string;
          cwd?: string;
          session_id?: string;
          permission_mode?: string;
          timeout_s?: number;
        }>;
        const inputs = taskInputs.map((item) => ({
          task: config.reportProtocol ? injectReportProtocol(item.task) : item.task,
          cwd: validateCwd(item.cwd ?? config.defaultCwd ?? process.cwd(), config),
          sessionId: item.session_id,
          permissionMode: item.permission_mode,
          ...(item.timeout_s ? { timeoutMs: item.timeout_s * 1_000 } : {}),
        }));
        const batch = await deps.batches.create(inputs);
        return ok({
          batch_id: batch.id,
          task_ids: batch.taskIds,
          count: batch.taskIds.length,
          hint: '用 dsh_batch_status 轮询（wait_s 长轮询），结束后 dsh_batch_result 取聚合结果；单个任务仍可用 dsh_status/dsh_result。',
        });
      } catch (error) {
        return fail(error);
      }
    },
  });

  registerTool(server, 'dsh_batch_status', {
    title: '查询批量任务状态',
    description: '返回批量任务的整体状态、各子任务状态与计数；wait_s>0 时轮询到批量结束或超时。',
    inputSchema: {
      batch_id: z.string().min(1).describe('dsh_batch_run 返回的 batch_id'),
      wait_s: z.number().min(0).max(25).optional().describe('长轮询等待秒数（默认 0）'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (args) => {
      try {
        if (!deps.batches) throw new WorkerError('bad_request', '批量任务未启用（服务未注入 BatchManager）');
        let payload = await deps.batches.status(args.batch_id);
        const waitMs = (args.wait_s ?? 0) * 1_000;
        const deadline = Date.now() + waitMs;
        while (waitMs > 0 && Date.now() < deadline && (payload.status === 'queued' || payload.status === 'running')) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          payload = await deps.batches.status(args.batch_id);
        }
        return ok({ ...payload });
      } catch (error) {
        return fail(error);
      }
    },
  });

  registerTool(server, 'dsh_batch_result', {
    title: '获取批量任务结果',
    description: '返回批量中每个任务的最终输出/错误/耗时；单条输出超过 max_output_chars 会截断（完整内容用 dsh_read_result）。',
    inputSchema: {
      batch_id: z.string().min(1).describe('dsh_batch_run 返回的 batch_id'),
      max_output_chars: z.number().int().min(100).max(100_000).optional().describe('单条输出最大字符数，默认 4000'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (args) => {
      try {
        if (!deps.batches) throw new WorkerError('bad_request', '批量任务未启用（服务未注入 BatchManager）');
        const payload = await deps.batches.result(args.batch_id);
        const maxChars = args.max_output_chars ?? 4_000;
        const results = payload.results.map((item) => ({
          ...item,
          output:
            typeof item.output === 'string' && item.output.length > maxChars
              ? `${item.output.slice(0, maxChars)}…[截断，共 ${item.output.length} 字符]`
              : item.output,
        }));
        return ok({ ...payload, results });
      } catch (error) {
        return fail(error);
      }
    },
  });

  registerTool(server, 'dsh_search', {
    title: '检索历史任务内容',
    description: '在已记录任务的最终输出与工具结果里做子串检索，返回匹配任务与上下文片段。',
    inputSchema: {
      query: z.string().min(1).describe('检索词（大小写不敏感）'),
      limit: z.number().int().min(1).max(50).optional().describe('最多返回多少条，默认 20'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (args) => {
      try {
        const tasks = manager.list();
        const matches = searchTasks(tasks, args.query, args.limit ?? 20);
        return ok({ query: args.query, count: matches.length, scanned_tasks: tasks.length, matches });
      } catch (error) {
        return fail(error);
      }
    },
  });

  registerTool(server, 'dsh_metrics', {
    title: '查看运行指标',
    description:
      '返回任务计数、耗时分位（avg/p50/p95/max）、DSH 侧 token 汇总、并发限制、排队情况、后端与 OTel 状态；用于 leader 自适应与「省 token/提速」核对。',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async () => {
      try {
        const tasks = manager.list();
        const counts: Record<TaskStatus, number> = { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 };
        const durations: number[] = [];
        const tokens = {
          input: 0,
          output: 0,
          cache_read: 0,
          cache_write: 0,
          reasoning: 0,
          total: 0,
          tasks_with_usage: 0,
        };
        for (const task of tasks) {
          counts[task.status] += 1;
          if (isTerminal(task.status) && task.startedAt !== undefined && task.endedAt !== undefined) {
            durations.push(task.endedAt - task.startedAt);
          }
          if (task.usageTokens) {
            tokens.input += task.usageTokens.inputTokens;
            tokens.output += task.usageTokens.outputTokens;
            tokens.cache_read += task.usageTokens.cacheReadTokens;
            tokens.cache_write += task.usageTokens.cacheWriteTokens;
            tokens.reasoning += task.usageTokens.reasoningTokens;
            tokens.total += task.usageTokens.totalTokens;
            tokens.tasks_with_usage += 1;
          }
        }
        const sorted = durations.sort((a, b) => a - b);
        const avg = sorted.length > 0 ? Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length) : null;
        const outcomes = { completed: 0, needs_decision: 0, failed: 0, cancelled: 0 };
        const sessionCounts = new Map<string, number>();
        let tasksWithGit = 0;
        let commandsFailedTotal = 0;
        for (const task of tasks) {
          if (task.sessionId) sessionCounts.set(task.sessionId, (sessionCounts.get(task.sessionId) ?? 0) + 1);
          if (task.evidenceStats) {
            commandsFailedTotal += task.evidenceStats.commands_failed;
            if (task.evidenceStats.has_git) tasksWithGit += 1;
          }
          if (!isTerminal(task.status)) continue;
          const outcome =
            task.outcome ??
            (task.status === 'failed' ? 'failed' : task.status === 'cancelled' ? 'cancelled' : 'completed');
          outcomes[outcome] += 1;
        }
        const reworkSessions = [...sessionCounts.values()].filter((count) => count > 1).length;
        return ok({
          counts,
          total: tasks.length,
          tokens,
          outcomes,
          rework: { sessions_reentered: reworkSessions, tasks_total: tasks.length },
          evidence: { tasks_with_git: tasksWithGit, commands_failed_total: commandsFailedTotal },
          mcp: snapshotMcpMetrics(mcpMetrics),
          latency_ms: {
            avg,
            p50: percentile(sorted, 50),
            p95: percentile(sorted, 95),
            max: sorted.length > 0 ? sorted[sorted.length - 1] : null,
            samples: sorted.length,
          },
          limits: {
            max_concurrent: config.maxConcurrent,
            max_concurrent_per_cwd: config.maxConcurrentPerCwd,
            max_tasks: config.maxTasks,
            max_batch_tasks: config.maxBatchTasks,
          },
          runtime: deps.runtimeInfo?.() ?? null,
        });
      } catch (error) {
        return fail(error);
      }
    },
  });

  return server;
}

interface ToolSpec {
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  handler: (args: Record<string, any>, extra: Extra) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  }>;
}

/**
 * 用统一的宽松类型注册工具：
 * MCP SDK 1.30 的 registerTool 泛型对动态 schema 推导过于严格，
 * 这里集中做一次类型收敛，各工具实现保持强校验（zod 仍会校验入参）。
 */
interface McpMetrics {
  since: number;
  totalCalls: number;
  totalBytes: number;
  tools: Map<string, { calls: number; bytes: number }>;
}

function createMcpMetrics(): McpMetrics {
  return { since: Date.now(), totalCalls: 0, totalBytes: 0, tools: new Map() };
}

function snapshotMcpMetrics(metrics: McpMetrics): Record<string, unknown> {
  return {
    since: metrics.since,
    total_calls: metrics.totalCalls,
    total_bytes: metrics.totalBytes,
    tools: Object.fromEntries(
      [...metrics.tools.entries()].map(([name, item]) => [
        name,
        { calls: item.calls, bytes: item.bytes, avg_bytes: item.calls > 0 ? Math.round(item.bytes / item.calls) : 0 },
      ]),
    ),
  };
}

function registerTool(server: McpServer, name: string, spec: ToolSpec): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 泛型推导与动态 schema 冲突，集中在此处收敛
  const anyServer = server as any;
  const wrappedHandler = async (args: Record<string, any>, extra: Extra) => {
    const result = await spec.handler(args, extra);
    const metrics = (server as unknown as { __mcpMetrics?: McpMetrics }).__mcpMetrics;
    if (metrics) {
      try {
        const bytes = Buffer.byteLength(JSON.stringify(result ?? null), 'utf8');
        metrics.totalCalls += 1;
        metrics.totalBytes += bytes;
        const item = metrics.tools.get(name) ?? { calls: 0, bytes: 0 };
        item.calls += 1;
        item.bytes += bytes;
        metrics.tools.set(name, item);
      } catch {
        // 指标失败不影响工具调用
      }
    }
    return result;
  };
  anyServer.registerTool(
    name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.inputSchema,
      annotations: spec.annotations,
    },
    wrappedHandler,
  );
}

async function sendProgress(extra: Extra, progressToken: string | number, progress: number, message?: string): Promise<void> {
  try {
    await extra.sendNotification({
      method: 'notifications/progress',
      params: {
        progressToken,
        progress,
        ...(message ? { message } : {}),
      },
    });
  } catch {
    // 进度通知失败不影响任务本身
  }
}

function isTerminal(status: TaskStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

/**
 * dsh_run(wait_s) 的整包 JSON 预算：created/hint/status 元数据与事件摘要一起计数，
 * 超出时从尾部少放摘要；至少要保证首条摘要能放下，游标可继续。
 */
function fitRunPayload(
  base: Record<string, unknown>,
  events: RunEvent[],
  budget: number,
): Record<string, unknown> {
  const included: RunEvent[] = [];
  let payload: Record<string, unknown> = { ...base, events: included };
  for (const event of events) {
    const candidate = {
      ...base,
      events: [...included, event],
      next_cursor: Number(event.seq ?? 0) + 1,
    };
    if (utf8ByteLength(JSON.stringify(candidate)) > budget) break;
    included.push(event);
    payload = candidate;
  }
  if (included.length === 0 && events.length > 0) {
    const first = events[0]!;
    const limit = Math.max(64, budget - utf8ByteLength(JSON.stringify(base)) - 64);
    const small = { ...summarizeEvent(first, limit), seq: first.seq };
    const candidate = { ...base, events: [small], next_cursor: Number(first.seq ?? 0) + 1 };
    if (utf8ByteLength(JSON.stringify(candidate)) <= budget) {
      included.push(small);
      payload = candidate;
    }
  }
  return {
    ...payload,
    events: included,
    events_truncated: included.length < events.length || Boolean(base.events_truncated),
  };
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}

interface ApprovalBridgeResult {
  required: boolean;
  status?: 'approved' | 'declined' | 'unsupported';
  retried_task_id?: string;
  /** leader 可原样重提 dsh_run 的参数（declined / unsupported 分支提供，免去自行猜测 cwd/timeout） */
  retry_args?: {
    permission_mode: 'danger-full-access';
    cwd: string;
    task?: string;
    timeout_s?: number;
  };
  message?: string;
}

/**
 * 审批桥 v0：任务因缺少审批通道失败时，若客户端支持 elicitation，就询问用户是否授权重试。
 * 授权后以 danger-full-access 重新提交同一任务（仅本次生效）。
 */
async function bridgeApproval(
  server: McpServer,
  manager: TaskManager,
  record: TaskRecord,
  config: WorkerConfig,
): Promise<ApprovalBridgeResult> {
  const preview = record.task.length > 80 ? `${record.task.slice(0, 80)}…` : record.task;
  // 同一份重提参数供 declined / unsupported 分支复用；approved 分支已有 retried_task_id，无需再来一份
  // cwd 优先用 originalCwd：任务可能已切到 worktree，重提应回到原仓库而不是临时 worktree。
  const retryArgs: ApprovalBridgeResult['retry_args'] = {
    permission_mode: 'danger-full-access',
    cwd: record.originalCwd ?? record.cwd,
    ...(record.timeoutMs ? { timeout_s: Math.round(record.timeoutMs / 1000) } : {}),
  };
  manager.audit({ event: 'approval_required', task_id: record.id, cwd: record.cwd, detail: preview });
  try {
    const result = await server.server.elicitInput({
      message: `DSH 任务「${preview}」因缺少审批通道而失败。是否授权以 danger-full-access 权限重试？`,
      requestedSchema: {
        type: 'object',
        properties: {
          approve: { type: 'boolean', title: '授权重试', description: '仅对本次重试生效' },
        },
        required: ['approve'],
      },
    });
    if (result.action !== 'accept' || result.content?.approve !== true) {
      manager.audit({ event: 'approval_declined', task_id: record.id, cwd: record.cwd });
      return {
        required: true,
        status: 'declined',
        retry_args: retryArgs,
        message:
          '用户未授权重试，任务保持失败状态；如需继续，可直接用返回的 retry_args 重新调用 dsh_run。',
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    manager.audit({ event: 'approval_unsupported', task_id: record.id, cwd: record.cwd, detail: message.slice(0, 300) });
    return {
      required: true,
      status: 'unsupported',
      retry_args: retryArgs,
      message: `当前客户端不支持 elicitation（${message}）。请让用户手动以 permission_mode=danger-full-access 重新提交任务，或直接用返回的 retry_args 重新调用 dsh_run。`,
    };
  }

  const retried = await manager.create({
    task: record.task,
    cwd: record.cwd,
    sessionId: record.sessionId,
    permissionMode: 'danger-full-access',
    timeoutMs: record.timeoutMs,
  });
  manager.audit({
    event: 'approval_granted',
    task_id: record.id,
    cwd: record.cwd,
    detail: `retried as ${retried.id}`,
  });
  return {
    required: true,
    status: 'approved',
    retried_task_id: retried.id,
    message: '已授权并以 danger-full-access 重新提交；请用 dsh_status 轮询新任务，再用 dsh_result 取结果。',
  };
}

