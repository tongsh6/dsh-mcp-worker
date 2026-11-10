import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { WorkerConfig } from './config.js';
import { CwdCapabilityStore } from './capability-store.js';
import { createDetachedWorktree } from './worktree.js';
import { cleanupStaleWorktrees } from './worktree-cleanup.js';
import { resolveRepoRoot } from './repo-root.js';
import { WorkerError } from './errors.js';
import type { TaskStore } from './store.js';
import type {
  AuditEntry,
  QueuedReason,
  RunEvent,
  RunOutcome,
  TaskAttempt,
  TaskEvidence,
  TaskMergeHint,
  TaskOutcome,
  TaskRecord,
  TaskResultPayload,
  TaskStatus,
  TaskStatusPayload,
  TaskSummary,
} from './types.js';
import { isTerminalStatus } from './types.js';
import { extractEvidence } from './evidence.js';
import { collectGitBaseline, collectGitEvidence } from './git-evidence.js';
import { detectDecisionRequest } from './report-protocol.js';
import {
  isSandboxAclFailure,
  sandboxAclFailureDetail,
  sandboxAclHint,
  textLooksLikeSandboxAclFailure,
} from './sandbox-errors.js';
import { addTokenUsage, emptyTokenUsage, extractTokenUsage } from './usage.js';
import { estimateCost } from './pricing.js';
import { EVENT_SUMMARY_MAX_BYTES, sliceJsonString, summarizeEvent, utf8ByteLength } from './event-summary.js';

export interface TaskRunInput {
  id: string;
  task: string;
  cwd: string;
  sessionId?: string;
  permissionMode: string;
  timeoutMs: number;
  /** 第几次尝试（1=首次；沙箱 ACL 降级重试为 2，用于生成新 session id）。 */
  attempt?: number;
  /** 续聊恢复上下文：新 session 无法自动恢复时作为前缀带上（来自 worker 本地任务记录）。 */
  resumeContext?: string;
  onEvent: (event: RunEvent) => void;
}

export interface RunHandle {
  pid: number | null;
  cancel: () => void;
  outcome: Promise<RunOutcome>;
}

export type TaskRunner = (input: TaskRunInput) => RunHandle;

export interface TaskCreateInput {
  task: string;
  cwd: string;
  sessionId?: string;
  permissionMode?: string;
  timeoutMs?: number;
  /** 幂等键（可选）：由 server 层去重后透传，落进任务记录便于追溯。 */
  idempotencyKey?: string;
}

export interface TaskCreateHooks {
  onProgress?: (progress: number, message?: string) => void;
}

export interface TaskManagerOptions {
  runner: TaskRunner;
  store: TaskStore;
  config: WorkerConfig;
  now?: () => number;
  idFactory?: () => string;
  /** 审计回调（append-only 日志），由 index 接到 AuditLog。 */
  audit?: (entry: AuditEntry) => void;
}

/**
 * 异步任务管理器：
 * - create 立即返回（queued），任务在后台跑；
 * - 全局并发 + 每 cwd 并发 + 同一 DSH session 串行；
 * - 事件流落盘、status 支持 cursor 增量与长轮询；
 * - cancel 杀进程/出队；重启后把未完成任务标记为 interrupted；
 * - TTL / 数量上限自动清理；审计事件外发。
 */
export class TaskManager {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly active = new Map<string, RunHandle>();
  private readonly queue: string[] = [];
  private readonly busySessions = new Set<string>();
  /** 每个运行中任务实际占用过的 session id 集合；任务结束前不释放任何别名。 */
  private readonly sessionLocks = new Map<string, Set<string>>();  /** 运行期实际换号：旧 id → 最新 id，供已排队任务接续。 */
  private readonly sessionAliases = new Map<string, string>();
  /** 终态后的证据采集/落盘 Promise；status/result 会等待它完成，避免读到未写完的 evidence。 */
  private readonly finalizing = new Map<string, Promise<void>>();
  private readonly activeByRepo = new Map<string, number>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly progressSinks = new Map<string, (progress: number, message?: string) => void>();
  /** 记录曾经 workspace-write ACL 失败的 cwd：后续同 cwd 直接以 read-only 启动，避免重复失败尝试。 */
  private readonly aclBlockedCwds = new Map<string, { reason: string; at: number }>();
  /** 当前运行中的 attempt（用于把 ACL 事件记到对应 attempt 上，并触发 fail-fast 中止）。 */
  private readonly activeAttempts = new Map<string, TaskAttempt>();
  /** cwd 能力缓存（落盘，跨 worker 进程）；null = 测试/关闭。 */
  private readonly capabilities: CwdCapabilityStore | null;
  private readonly now: () => number;
  private cleanupTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: TaskManagerOptions) {
    this.now = options.now ?? (() => Date.now());
    this.capabilities = options.config.capabilityStore
      ? new CwdCapabilityStore(
          join(options.config.dshHome, 'mcp-cwd-capabilities.json'),
          options.config.capabilityTtlMs,
          this.now,
        )
      : null;
  }

  /** auto 模式：按 cwd 能力缓存选具体权限模式，未知则先试 workspace-write。 */
  resolveAutoMode(cwd: string): 'read-only' | 'workspace-write' | 'danger-full-access' {
    return this.capabilities?.get(cwd)?.mode ?? 'workspace-write';
  }

  async init(): Promise<void> {
    if (this.capabilities) await this.capabilities.init();
    await this.options.store.init();
    for (const record of await this.options.store.loadAll()) {
      if (!isTerminalStatus(record.status)) {
        // 多 worker 共享任务目录：别的活 worker 拥有的任务不能由本进程判定为 interrupted
        const ownedByLiveWorker =
          record.workerPid !== undefined && record.workerPid !== process.pid && isProcessAlive(record.workerPid);
        if (ownedByLiveWorker) continue;
        record.status = 'failed';
        record.error = 'interrupted: worker restarted before the task finished';
        record.endedAt = this.now();
        await this.saveQuietly(record);
      }
      this.tasks.set(record.id, record);
    }
    this.sweep();
    void this.cleanupWorktrees().catch(() => undefined);
    this.startCleanup();
  }

  stop(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
    void this.capabilities?.dispose();
  }

  async create(input: TaskCreateInput, hooks: TaskCreateHooks = {}): Promise<TaskRecord> {
    const config = this.options.config;
    if (config.maxTasks > 0 && this.tasks.size >= config.maxTasks) {
      this.sweep();
      if (this.tasks.size >= config.maxTasks) {
        // 容量已满：优先腾出最老的已结束任务，仍不够才拒绝
        this.evictOldestTerminal(this.tasks.size - config.maxTasks + 1);
      }
      if (this.tasks.size >= config.maxTasks) {
        throw new WorkerError(
          'quota_exceeded',
          `任务数已达上限 ${config.maxTasks}（全部为未结束任务），请等待或清理后再提交`,
        );
      }
    }

    const id = this.options.idFactory?.() ?? randomUUID();
    const requestedMode = input.permissionMode ?? config.defaultPermissionMode;
    const permissionMode = requestedMode === 'auto' ? this.resolveAutoMode(input.cwd) : requestedMode;
    const sessionId = this.resolveSessionId(input.sessionId ?? `mcp-${id}`);
    // per-repo 并发锁：解析 git 仓库根，子目录/worktree 任务也锁同一仓库；非 git 回退 cwd。
    const repoRoot = (await resolveRepoRoot(input.cwd).catch(() => null)) ?? undefined;
    // 快速失败：关闭 ACL 自动升级时，已知不可写的目录不再让模型进去空转
    if (
      config.aclFallback === 'off' &&
      permissionMode === 'workspace-write' &&
      this.capabilities?.get(input.cwd)?.mode === 'danger-full-access'
    ) {
      throw new WorkerError(
        'cwd_not_writable',
        `目录不可写（DSH ACL 沙箱无法授权）：${input.cwd}；请改用可写目录、或显式传 permission_mode=read-only/danger-full-access`,
      );
    }
    const record: TaskRecord = {
      id,
      status: 'queued',
      task: input.task,
      cwd: input.cwd,
      // 首次 run 就确定一个可用 ID（与 runner 的默认 ID 生成一致）；SDK 实际 ID 变化时由事件回填。
      sessionId,
      requestedPermissionMode: requestedMode,
      permissionMode,
      timeoutMs: input.timeoutMs ?? config.defaultTimeoutMs,
      createdAt: this.now(),
      workerPid: process.pid,
      ...(repoRoot ? { repoRoot } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      events: [],
      timedOut: false,
    };
    this.tasks.set(id, record);
    if (hooks.onProgress) this.progressSinks.set(id, hooks.onProgress);
    await this.options.store.saveMeta(record);
    this.audit({
      event: 'task_created',
      task_id: id,
      cwd: record.cwd,
      session_id: record.sessionId,
      permission_mode: record.permissionMode,
    });
    // 返回受理快照（此时尚未开始执行，保证调用方看到 queued）
    const accepted: TaskRecord = { ...record, events: [] };
    this.queue.push(id);
    this.pump();
    return accepted;
  }

  get(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  list(): TaskRecord[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  summaries(limit = 20, status?: TaskStatus): TaskSummary[] {
    const size = Math.max(1, Math.min(100, Math.trunc(limit)));
    return this.list()
      .filter((record) => (status ? record.status === status : true))
      .slice(0, size)
      .map((record) => ({
        task_id: record.id,
        status: record.status,
        task: record.task.length > 200 ? `${record.task.slice(0, 200)}…` : record.task,
        cwd: record.cwd,
        session_id: record.sessionId,
        permission_mode: record.permissionMode,
        created_at: record.createdAt,
        started_at: record.startedAt,
        ended_at: record.endedAt,
        error: record.error ?? null,
        outcome: isTerminalStatus(record.status) ? this.resolveOutcome(record) : null,
      }));
  }

  /** 记录一条审计事件（任务生命周期以外的动作，如审批决定）。 */
  audit(entry: Omit<AuditEntry, 'ts'>): void {
    try {
      this.options.audit?.({ ts: this.now(), ...entry });
    } catch {
      // 审计失败不影响主流程
    }
  }

  /** 清理过期/超额任务（返回被移除的 task_id）。 */
  sweep(nowMs = this.now()): { removed: string[] } {
    const removed: string[] = [];
    const removeTask = (taskId: string): void => {
      const record = this.tasks.get(taskId);
      if (!record || !isTerminalStatus(record.status)) return;
      this.tasks.delete(taskId);
      this.progressSinks.delete(taskId);
      this.waiters.delete(taskId);
      removed.push(taskId);
      void this.options.store.remove(taskId).catch(() => undefined);
    };

    const { taskTtlMs, maxTasks } = this.options.config;
    for (const [taskId, record] of [...this.tasks]) {
      if (!isTerminalStatus(record.status)) continue;
      const endedAt = record.endedAt ?? record.createdAt;
      if (taskTtlMs > 0 && nowMs - endedAt > taskTtlMs) removeTask(taskId);
    }

    if (maxTasks > 0 && this.tasks.size > maxTasks) {
      this.evictOldestTerminal(this.tasks.size - maxTasks);
    }

    return { removed };
  }

  /** 淘汰最老的已结束任务，腾出指定数量。 */
  private evictOldestTerminal(count: number): string[] {
    const terminal = [...this.tasks.values()]
      .filter((record) => isTerminalStatus(record.status))
      .sort((a, b) => a.createdAt - b.createdAt);
    const removed: string[] = [];
    for (const record of terminal) {
      if (removed.length >= count) break;
      this.tasks.delete(record.id);
      this.progressSinks.delete(record.id);
      this.waiters.delete(record.id);
      removed.push(record.id);
      void this.options.store.remove(record.id).catch(() => undefined);
    }
    return removed;
  }

  async status(
    taskId: string,
    options: { cursor?: number; waitMs?: number; detail?: 'summary' | 'events' } = {},
  ): Promise<TaskStatusPayload> {
    await this.awaitFinalization(taskId);
    const record = this.mustGet(taskId);
    const cursor = Math.max(0, Math.trunc(options.cursor ?? 0));
    const waitMs = Math.max(0, Math.min(Math.trunc(options.waitMs ?? 0), this.options.config.statusWaitMaxMs));
    if (record.events.length <= cursor && !isTerminalStatus(record.status) && waitMs > 0) {
      await this.waitForChange(taskId, waitMs);
    }
    const latest = this.mustGet(taskId);
    const start = Math.min(cursor, latest.events.length);
    const maxCount = this.options.config.maxStatusEvents;
    const budget = this.options.config.maxStatusPayloadBytes;
    const minEventBytes = 512;
    const build = (selected: RunEvent[], errorText: string | null): TaskStatusPayload => {
      const nextCursor = start + selected.length;
      return {
        task_id: latest.id,
        status: latest.status,
        phase: derivePhase(latest),
        progress: countSteps(latest.events),
        events: selected,
        events_truncated: nextCursor < latest.events.length,
        next_cursor: nextCursor,
        created_at: latest.createdAt,
        started_at: latest.startedAt,
        ended_at: latest.endedAt,
        error: errorText,
        error_truncated: errorText !== null && latest.error !== null && errorText !== latest.error,
        timed_out: latest.timedOut,
        session_id: latest.sessionId,
        queued_reason: latest.status === 'queued' ? this.deriveQueuedReason(latest) : null,
        tokens: latest.usageTokens ?? null,
        steps: countSteps(latest.events),
        tool_calls: latest.events.filter((event) => event.type === 'tool_call').length,
      };
    };

    // error 先按「JSON 序列化后的字节」缩到预算内，并给至少一条事件摘要留出空间。
    const baseNoErrorBytes = utf8ByteLength(JSON.stringify(build([], null)));
    let errorText: string | null = null;
    if (latest.error) {
      const errorJsonLimit = Math.max(0, budget - minEventBytes - baseNoErrorBytes - 64);
      errorText = sliceJsonString(latest.error, errorJsonLimit).text;
    }
    let payload = build([], errorText);
    while (utf8ByteLength(JSON.stringify(payload)) > budget - minEventBytes && errorText) {
      const smaller = Math.max(0, Math.floor(utf8ByteLength(JSON.stringify(errorText)) / 2) - 1);
      errorText = sliceJsonString(errorText, smaller).text;
      payload = build([], errorText);
    }

    // 逐条加入摘要，并按整包 JSON 字节严格卡上限；空间不足时缩小摘要，保证游标至少前进一条。
    const selected: RunEvent[] = [];
    for (let index = start; index < latest.events.length && selected.length < maxCount; index += 1) {
      const room = budget - utf8ByteLength(JSON.stringify(payload)) - 2;
      if (room < minEventBytes && selected.length > 0) break;
      const digestLimit = Math.max(128, Math.min(EVENT_SUMMARY_MAX_BYTES - 16, room - 16));
      let digest = { ...summarizeEvent(latest.events[index]!, digestLimit), seq: index };
      let candidate = build([...selected, digest], errorText);
      if (utf8ByteLength(JSON.stringify(candidate)) > budget) {
        if (selected.length > 0) break;
        digest = { ...summarizeEvent(latest.events[index]!, Math.max(64, Math.floor(digestLimit / 2))), seq: index };
        candidate = build([digest], errorText);
        if (utf8ByteLength(JSON.stringify(candidate)) > budget) break;
      }
      selected.push(digest);
      payload = candidate;
    }
    const detail = options.detail ?? this.options.config.statusDetail;
    const visible =
      detail === 'events'
        ? payload.events
        : payload.events.filter(
            (event) => event.type === 'status' && event.phase !== 'step_start' && event.phase !== 'step_end',
          );
    return {
      ...payload,
      events: visible,
      outcome: isTerminalStatus(latest.status) ? this.resolveOutcome(latest) : null,
      ...(detail === 'summary'
        ? { last_text: (latest.finalText ?? lastAssistantText(latest))?.slice(0, 300) ?? null }
        : {}),
    };
  }

  async result(taskId: string): Promise<TaskResultPayload> {
    const record = this.mustGet(taskId);
    await this.awaitFinalization(taskId);
    if (!isTerminalStatus(record.status)) {
      throw new WorkerError('task_not_finished', `任务尚未结束（当前 ${record.status}），请先用 dsh_status 轮询`);
    }
    const evidence = await this.readEvidence(record.id);
    const cost = estimateCost(record.usageTokens, this.options.config.pricing);
    return {
      task_id: record.id,
      status: record.status,
      outcome: this.resolveOutcome(record),
      decision_request: record.decisionRequest ?? null,
      evidence,
      output: record.finalText ?? null,
      error: record.error ?? null,
      exit_code: record.exitCode,
      session_id: record.sessionId,
      timed_out: record.timedOut,
      events_count: record.events.length,
      sandbox_fallback: record.sandboxFallback ?? null,
      effective_permission_mode: record.permissionMode,
      partial_output: lastAssistantText(record),
      failure_kind: classifyFailure(record),
      diagnosis: buildDiagnosis(record),
      worktree: record.worktree ?? null,
      merge_hint: record.worktree ? buildMergeHint(record, evidence) : null,
      sandbox_blocked: record.sandboxBlocked === true,
      sandbox_blocked_detail: record.sandboxBlockedDetail ?? null,
      attempts: (record.attempts ?? []).slice(-4),
      retries: record.transientRetries ?? 0,
      usage: {
        steps: countSteps(record.events),
        tool_calls: record.events.filter((event) => event.type === 'tool_call').length,
        wall_ms: record.startedAt !== undefined && record.endedAt !== undefined ? record.endedAt - record.startedAt : null,
        tokens: record.usageTokens ?? null,
        cost_usd: cost?.usd ?? null,
        cost_cny: cost?.cny ?? null,
      },
    };
  }

  async cancel(taskId: string): Promise<{ task_id: string; cancelled: boolean; status: TaskStatus }> {
    const record = this.mustGet(taskId);
    if (isTerminalStatus(record.status)) {
      return { task_id: taskId, cancelled: false, status: record.status };
    }
    record.cancelRequested = true;

    const queuedIndex = this.queue.indexOf(taskId);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      record.status = 'cancelled';
      record.error = 'cancelled before start';
      record.endedAt = this.now();
      await this.saveQuietly(record);
      this.progressSinks.delete(taskId);
      this.audit({ event: 'task_cancelled', task_id: taskId, cwd: record.cwd, detail: 'queued' });
      this.notify(taskId);
      return { task_id: taskId, cancelled: true, status: record.status };
    }

    const handle = this.active.get(taskId);
    if (!handle) {
      throw new WorkerError('internal', `任务状态异常：${taskId} 既不在队列也没有运行句柄`);
    }
    handle.cancel();
    this.audit({ event: 'task_cancel_requested', task_id: taskId, cwd: record.cwd });
    await this.waitUntilTerminal(taskId, 10_000);
    return { task_id: taskId, cancelled: record.status === 'cancelled', status: record.status };
  }

  /** 进程退出前中止所有运行中的任务（不等待结果）。 */
  abortAll(): void {
    for (const handle of this.active.values()) {
      try {
        handle.cancel();
      } catch {
        // 忽略：退出路径上尽力而为
      }
    }
    this.queue.length = 0;
  }

  private mustGet(taskId: string): TaskRecord {
    const record = this.tasks.get(taskId);
    if (!record) throw new WorkerError('task_not_found', `任务不存在（可能已过期清理）：${taskId}`);
    return record;
  }

  /** 等待终态证据采集完成（若正在进行）；失败不影响查询。 */
  private async awaitFinalization(taskId: string): Promise<void> {
    const pending = this.finalizing.get(taskId);
    if (pending) await pending.catch(() => undefined);
  }

  /** 并发锁 key：同一 git 仓库（含子目录/worktree 任务）共享一个 key；非 git 目录按 cwd。 */
  private repoKeyOf(record: TaskRecord): string {
    return normalizeCwd(record.repoRoot ?? record.cwd);
  }

  private deriveQueuedReason(record: TaskRecord): QueuedReason | null {
    const sessionId = record.sessionId ? this.resolveSessionId(record.sessionId) : undefined;
    if (sessionId && this.busySessions.has(sessionId)) return 'session';
    const repoKey = this.repoKeyOf(record);
    if ((this.activeByRepo.get(repoKey) ?? 0) >= this.options.config.maxConcurrentPerCwd) return 'concurrency';
    if (this.active.size >= this.options.config.maxConcurrent) return 'concurrency';
    return null;
  }

  private pump(): void {
    const { maxConcurrent, maxConcurrentPerCwd } = this.options.config;
    while (this.active.size < maxConcurrent && this.queue.length > 0) {
      const index = this.queue.findIndex((taskId) => {
        const record = this.tasks.get(taskId);
        if (!record) return true;
        const sessionId = record.sessionId ? this.resolveSessionId(record.sessionId) : undefined;
        if (sessionId && this.busySessions.has(sessionId)) return false;
        return (this.activeByRepo.get(this.repoKeyOf(record)) ?? 0) < maxConcurrentPerCwd;
      });
      if (index < 0) return; // 队列里剩下的都在等 session 或 cwd 额度
      const [taskId] = this.queue.splice(index, 1);
      if (!taskId) return;
      const record = this.tasks.get(taskId);
      if (!record) continue;
      void this.execute(taskId);
    }
  }

  private async execute(taskId: string): Promise<void> {
    const record = this.mustGet(taskId);
    const timeoutMs = record.timeoutMs ?? this.options.config.defaultTimeoutMs;
    const repoKey = this.repoKeyOf(record);
    record.status = 'running';
    record.startedAt = this.now();
    // 任务启动时把「请求 ID + 最新实际 ID」都计入占用；运行期换号只增不减，直到任务结束。
    const requestedSessionId = record.sessionId;
    const resolvedSessionId = requestedSessionId ? this.resolveSessionId(requestedSessionId) : undefined;
    const sessionLocks = new Set<string>();
    if (requestedSessionId) sessionLocks.add(requestedSessionId);
    if (resolvedSessionId) sessionLocks.add(resolvedSessionId);
    for (const sessionId of sessionLocks) this.busySessions.add(sessionId);
    this.sessionLocks.set(taskId, sessionLocks);
    if (resolvedSessionId) record.sessionId = resolvedSessionId;
    this.activeByRepo.set(repoKey, (this.activeByRepo.get(repoKey) ?? 0) + 1);
    await this.saveQuietly(record);
    this.audit({
      event: 'task_started',
      task_id: taskId,
      cwd: record.cwd,
      session_id: record.sessionId,
      permission_mode: record.permissionMode,
    });
    this.notify(taskId);

    // A1/C2：cwd 能力缓存（落盘）决定启动模式；D2：已知只能 full 时优先换可写 worktree
    const config = this.options.config;
    const fallbackTarget = config.aclFallback === 'off' ? null : config.aclFallback;
    const cached = this.capabilities?.get(record.cwd) ?? null;
    const worktreeRootBlocked = this.isWorktreeRootBlocked();
    let initialPermission = record.permissionMode;
    let preFallback = false;
    // cwd 能力缓存记录的是「该目录能否 workspace-write」；auto 的执行策略仍是优先 worktree。
    const autoCachedDanger =
      record.requestedPermissionMode === 'auto' &&
      record.permissionMode === 'danger-full-access' &&
      cached?.mode === 'danger-full-access' &&
      config.autoWorktree &&
      !worktreeRootBlocked;
    if (
      record.permissionMode === 'workspace-write' &&
      cached?.mode === 'danger-full-access' &&
      config.autoWorktree &&
      !worktreeRootBlocked
    ) {
      await this.attachWorktree(record);
      if (record.worktree) initialPermission = 'workspace-write';
    } else if (autoCachedDanger) {
      if (await this.attachWorktree(record)) {
        record.permissionMode = 'workspace-write';
        initialPermission = 'workspace-write';
      }
    }
    if (record.permissionMode === 'workspace-write' && cached && cached.mode !== 'workspace-write' && !record.worktree) {
      preFallback = true;
      initialPermission = cached.mode;
      const reason = `cached-capability(${cached.mode}): ${cached.reason ?? ''}`.slice(0, 500);
      record.sandboxFallback = { from: record.permissionMode, to: cached.mode, reason };
      record.permissionMode = cached.mode;
      this.handleEvent(taskId, {
        type: 'status',
        phase: 'sandbox_fallback',
        reason: 'cached-capability',
        detail: reason,
      });
      this.audit({
        event: 'task_sandbox_fallback',
        task_id: taskId,
        cwd: record.originalCwd ?? record.cwd,
        session_id: record.sessionId,
        permission_mode: cached.mode,
        detail: reason,
      });
      this.notify(taskId);
    }

    if (config.evidenceGit) {
      try {
        record.gitBaseline = (await collectGitBaseline(record.cwd)) ?? undefined;
      } catch {
        // git 基线采集失败不阻塞任务
      }
    }

    try {
      const autoFallbackEligible = record.permissionMode === 'workspace-write';
      let attemptNo = preFallback || record.worktree ? 2 : 1;
      let outcome = await this.runAttempt(record, initialPermission, timeoutMs, attemptNo);
      // 降级链（最多 3 段）：原目录 workspace-write → worktree workspace-write → danger-full-access。
      // 每段结束都重新判定 ACL 失败；worktree 分支不再消耗掉唯一一次兜底机会。
      let chainGuard = 0;
      while (autoFallbackEligible && chainGuard < 3) {
        chainGuard += 1;
        const attempt = record.attempts?.[record.attempts.length - 1];
        if (attempt?.acl_blocked !== true) break;
        // 调用方取消（非 worker 内部 ACL fail-fast）：不再自动降级
        if (outcome.cancelled && !record.aclAbort) break;
        const reason = (record.sandboxBlockedDetail ?? outcome.errorMessage ?? outcome.stderrTail ?? 'sandbox acl grant failed')
          .slice(0, 500)
          .replaceAll('\u0000', '');
        // 本次失败发生在 worktree 里 ⇒ 该 worktree 根在 TTL 内不可用，后续任务跳过 worktree 直接走 full/失败。
        if (record.worktree) this.markWorktreeRootBlocked(reason);
        // D2：先尝试可写 worktree（不改仓库 ACL、不用全权）
        if (
          config.autoWorktree &&
          !record.worktree &&
          !this.isWorktreeRootBlocked() &&
          (await this.attachWorktree(record))
        ) {
          record.aclAbort = false;
          attemptNo += 1;
          outcome = await this.runAttempt(record, 'workspace-write', timeoutMs, attemptNo);
          continue;
        }
        // 第二级：升级全权（可用 DSH_MCP_ALLOW_FULL_ACCESS_FALLBACK=0 关闭；read-only 降级不受该开关限制）
        const fullAccessAllowed = fallbackTarget !== 'danger-full-access' || config.allowFullAccessFallback;
        if (fallbackTarget !== null && fullAccessAllowed) {
          record.sandboxFallback = { from: 'workspace-write', to: fallbackTarget, reason };
          record.permissionMode = fallbackTarget;
          record.aclAbort = false;
          this.handleEvent(taskId, {
            type: 'status',
            phase: 'sandbox_fallback',
            reason: 'acl-grant-failed',
            detail: reason,
          });
          this.audit({
            event: 'task_sandbox_fallback',
            task_id: taskId,
            cwd: record.originalCwd ?? record.cwd,
            session_id: record.sessionId,
            permission_mode: fallbackTarget,
            detail: reason,
          });
          this.notify(taskId);
          void this.capabilities?.set(record.cwd, fallbackTarget, reason);
          attemptNo += 1;
          outcome = await this.runAttempt(record, fallbackTarget, timeoutMs, attemptNo);
          break;
        }
        break;
      }
      this.applyOutcome(record, outcome, timeoutMs);
      // 最近一次 attempt 仍被 ACL 拦住时不能算成功/不能算完成（防「命令全没执行却 succeeded」的静默假成功）
      const lastAttempt = record.attempts?.[record.attempts.length - 1];
      const lastAclBlocked = lastAttempt?.acl_blocked === true;
      const aclHint = `[worker] ${sandboxAclHint()}`;
      if ((record.status as TaskStatus) === 'succeeded' && lastAclBlocked) {
        record.status = 'failed';
        record.error = `${record.sandboxBlockedDetail ?? '沙箱 ACL 授权失败（命令未实际执行）'}\n\n${aclHint}`;
      } else if ((record.status as TaskStatus) === 'cancelled' && record.aclAbort && !record.cancelRequested) {
        // worker 因 ACL fail-fast 主动中止，不是调用方取消：按环境失败上报，避免误报 cancelled
        record.status = 'failed';
        record.error = `${record.sandboxBlockedDetail ?? '沙箱 ACL 授权失败（命令未实际执行）'}\n\n${aclHint}`;
      } else if ((record.status as TaskStatus) === 'failed' && lastAclBlocked && !String(record.error ?? '').includes('[worker]')) {
        record.error = `${record.error ?? '沙箱 ACL 授权失败'}\n\n${aclHint}`;
      }
      // token 预算超限：取消后统一标为 failed（不能标成用户取消），并给出明确原因
      if (record.tokenBudgetExceeded) {
        record.status = 'failed';
        record.error = `token_budget_exceeded: 已用 ${record.usageTokens?.totalTokens ?? 0} tokens，超过预算 ${config.maxTaskTokens}`;
        record.endedAt = record.endedAt ?? this.now();
      }
      // C3：后端崩溃/初始化失败等瞬态错误自动重试一次
      if (
        (record.status as TaskStatus) === 'failed' &&
        config.retryTransient &&
        (record.transientRetries ?? 0) < 1 &&
        !record.tokenBudgetExceeded
      ) {
        const kind = classifyFailure(record);
        if (kind === 'backend_crash' || kind === 'backend_init' || kind === 'session_conflict') {
          record.transientRetries = (record.transientRetries ?? 0) + 1;
          this.handleEvent(taskId, { type: 'status', phase: 'transient_retry', reason: kind });
          this.audit({
            event: 'task_transient_retry',
            task_id: taskId,
            cwd: record.cwd,
            session_id: record.sessionId,
            permission_mode: record.permissionMode,
            detail: kind,
          });
          outcome = await this.runAttempt(record, record.permissionMode, timeoutMs, 3);
          this.applyOutcome(record, outcome, timeoutMs);
          if (record.tokenBudgetExceeded) {
            record.status = 'failed';
            record.error = `token_budget_exceeded: 已用 ${record.usageTokens?.totalTokens ?? 0} tokens，超过预算 ${config.maxTaskTokens}`;
          }
        }
      }
      // A1：成功后在缓存里刷新该 cwd 的能力（worktree 场景保留原始 cwd 的 danger 记录）
      if ((record.status as TaskStatus) === 'succeeded' && !record.worktree && record.permissionMode === 'workspace-write') {
        void this.capabilities?.set(record.cwd, 'workspace-write');
      }
    } catch (error) {
      record.status = 'failed';
      record.error = error instanceof Error ? error.message : String(error);
      record.endedAt = this.now();
    } finally {
      this.active.delete(taskId);
      const sessionLocks = this.sessionLocks.get(taskId);
      if (sessionLocks) {
        for (const sessionId of sessionLocks) this.busySessions.delete(sessionId);
        this.sessionLocks.delete(taskId);
      } else if (record.sessionId) {
        this.busySessions.delete(record.sessionId);
      }
      const remaining = (this.activeByRepo.get(repoKey) ?? 1) - 1;
      if (remaining <= 0) this.activeByRepo.delete(repoKey);
      else this.activeByRepo.set(repoKey, remaining);
      this.progressSinks.delete(taskId);
      // 终态审计先于证据采集，保证 status 终态可见时审计已落盘
      this.audit({
        event: `task_${record.status}`,
        task_id: taskId,
        cwd: record.cwd,
        session_id: record.sessionId,
        permission_mode: record.permissionMode,
        ...(record.error ? { detail: record.error.slice(0, 500) } : {}),
      });
      const finalize = (async () => {
        await this.finalizeEvidence(record);
        await this.saveQuietly(record);
      })();
      this.finalizing.set(taskId, finalize);
      try {
        await finalize;
      } finally {
        this.finalizing.delete(taskId);
      }
      this.notify(taskId);
      this.pump();
    }
  }

  /** 结果维度（outcome）：completed / needs_decision / failed / cancelled。 */
  private resolveOutcome(record: TaskRecord): TaskOutcome {
    if (record.outcome) return record.outcome;
    if (record.status === 'cancelled') return 'cancelled';
    if (record.status === 'failed') return 'failed';
    if (record.status === 'succeeded') return detectDecisionRequest(record.finalText ?? null).outcome;
    return 'completed';
  }

  /** 读取 evidence.json（worker 重启后仍可用）；缺失返回 null。 */
  private async readEvidence(taskId: string): Promise<TaskEvidence | null> {
    try {
      const raw = await readFile(join(this.options.config.tasksDir, taskId, 'evidence.json'), 'utf8');
      return JSON.parse(raw) as TaskEvidence;
    } catch {
      return null;
    }
  }

  /**
   * 任务终态证据采集：outcome/decision_request + 命令/编辑/git 证据。
   * 任何失败都不影响任务状态（证据是可选的验收辅助）。
   */
  private async finalizeEvidence(record: TaskRecord): Promise<void> {
    if (record.status === 'cancelled') record.outcome = 'cancelled';
    else if (record.status === 'failed') record.outcome = 'failed';
    else if (record.status === 'succeeded') {
      const detection = detectDecisionRequest(record.finalText ?? null);
      record.outcome = detection.outcome;
      record.decisionRequest = detection.decisionRequest ?? undefined;
      if (detection.outcome === 'needs_decision') {
        this.audit({
          event: 'task_needs_decision',
          task_id: record.id,
          cwd: record.originalCwd ?? record.cwd,
          session_id: record.sessionId,
          detail: (detection.decisionRequest ?? '').slice(0, 500),
        });
      }
    }

    if (!this.options.config.evidenceGit && record.events.length === 0) return;
    try {
      const extracted = extractEvidence(record.events);
      const dir = record.worktree?.path ?? record.cwd;
      const taskDir = join(this.options.config.tasksDir, record.id);
      const git = this.options.config.evidenceGit
        ? await collectGitEvidence(dir, record.gitBaseline ?? null, taskDir)
        : null;
      const evidence: TaskEvidence = { ...extracted, git };
      await mkdir(taskDir, { recursive: true });
      await writeFile(join(taskDir, 'evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
      record.evidenceCollected = true;
      record.evidenceStats = { commands_failed: evidence.summary.commands_failed, has_git: Boolean(git) };
    } catch {
      // 证据采集失败不影响任务结果
    }
  }

  /** worktree 根能力缓存 key：与 cwd 缓存共用存储，用前缀区分避免与目录路径冲突。 */
  private worktreeRootCacheKey(): string {
    return `worktree-root::${this.options.config.worktreeRoot}`;
  }

  /** worktree 根是否已被记录为 ACL 不可用（TTL 内跳过 worktree 尝试，避免每个任务都重复创建+失败）。 */
  private isWorktreeRootBlocked(): boolean {
    return this.capabilities?.get(this.worktreeRootCacheKey())?.mode === 'danger-full-access';
  }

  /** 记录 worktree 根 ACL 不可用（复用 cwd 能力缓存的 TTL，默认 24h 后自动重试）。 */
  private markWorktreeRootBlocked(reason: string): void {
    void this.capabilities?.set(this.worktreeRootCacheKey(), 'danger-full-access', reason);
  }

  /** 在 ACL 受限仓库自动切到可写 worktree（D2）；成功返回 true。 */
  private async attachWorktree(record: TaskRecord): Promise<boolean> {
    if (record.worktree) return true;
    try {
      const worktree = await createDetachedWorktree(record.cwd, this.options.config.worktreeRoot, this.now());
      if (!worktree) return false;
      record.originalCwd = record.originalCwd ?? record.cwd;
      record.worktree = {
        path: worktree.path,
        branch: worktree.branch,
        ...(worktree.baseCommit ? { base_commit: worktree.baseCommit } : {}),
      };
      record.cwd = worktree.path;
      this.handleEvent(record.id, {
        type: 'status',
        phase: 'worktree_created',
        path: worktree.path,
        branch: worktree.branch,
      });
      this.audit({
        event: 'task_worktree_created',
        task_id: record.id,
        cwd: record.originalCwd,
        session_id: record.sessionId,
        detail: worktree.path,
      });
      this.notify(record.id);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 清理超过保留期的 worktree：只处理已结束任务且目录位于 worktreeRoot 内的路径，
   * 通过 `git worktree remove/prune` 回收，不删除任务证据（diff.patch 仍在任务目录）。
   */
  private async cleanupWorktrees(): Promise<void> {
    const config = this.options.config;
    if (!config.worktreeCleanup || config.worktreeTtlMs <= 0) return;
    try {
      const result = await cleanupStaleWorktrees({
        tasksDir: config.tasksDir,
        worktreeRoot: config.worktreeRoot,
        ttlMs: config.worktreeTtlMs,
        now: this.now(),
      });
      if (result.removed.length > 0 || result.pruned.length > 0 || result.failed.length > 0) {
        this.audit({
          event: 'task_worktree_cleanup',
          detail: `removed=${result.removed.length} pruned=${result.pruned.length} failed=${result.failed.length}`,
        });
      }
    } catch {
      // worktree 清理失败不影响任务执行/服务可用性
    }
  }

  /** 找同一 session id 的上一轮已结束任务，生成续聊摘要（用于新 session 恢复时补上下文）。 */
  private buildResumeContext(record: TaskRecord): string | undefined {
    if (!record.sessionId) return undefined;
    const sid = record.sessionId;
    const candidates = [...this.tasks.values()].filter(
      (candidate) =>
        candidate.id !== record.id &&
        isTerminalStatus(candidate.status) &&
        (candidate.sessionId === sid ||
          candidate.events.some((event) => event.type === 'session' && event.sessionId === sid)),
    );
    const previous = candidates[candidates.length - 1];
    if (!previous) return undefined;
    const result = (previous.finalText ?? previous.error ?? '').replaceAll('\u0000', '').slice(0, 3_000);
    return [
      '[续聊上下文] 上一轮 worker 任务（DSH session 已不在当前后端，无法自动恢复，以下为本地记录摘要）：',
      `任务：${previous.task.slice(0, 1_200)}`,
      `结果：${result}`,
    ].join('\n');
  }

  private async runAttempt(
    record: TaskRecord,
    permissionMode: string,
    timeoutMs: number,
    attempt = 1,
  ): Promise<RunOutcome> {
    // 先登记 attempt 再启动，保证 ACL 事件能归到本次尝试上；失败/取消也保留摘要。
    const tracked: TaskAttempt = {
      index: (record.attempts?.length ?? 0) + 1,
      permission_mode: permissionMode,
      cwd: record.cwd,
      exit_code: null,
      cancelled: false,
      timed_out: false,
      acl_blocked: false,
      final_text_tail: null,
    };
    (record.attempts ??= []).push(tracked);
    this.activeAttempts.set(record.id, tracked);
    const input: TaskRunInput = {
      id: record.id,
      task: record.task,
      cwd: record.cwd,
      sessionId: record.sessionId,
      permissionMode,
      timeoutMs,
      attempt,
      ...(record.sessionId ? { resumeContext: this.buildResumeContext(record) } : {}),
      onEvent: (event) => this.handleEvent(record.id, event),
    };
    const handle = this.options.runner(input);
    this.active.set(record.id, handle);
    try {
      const outcome = await handle.outcome;
      tracked.exit_code = outcome.exitCode;
      tracked.cancelled = outcome.cancelled;
      tracked.timed_out = outcome.timedOut;
      tracked.acl_blocked = tracked.acl_blocked || (outcome.exitCode !== 0 && isSandboxAclFailure(outcome));
      tracked.final_text_tail = outcome.finalText ? outcome.finalText.slice(0, 500) : null;
      return outcome;
    } finally {
      if (this.activeAttempts.get(record.id) === tracked) this.activeAttempts.delete(record.id);
      this.active.delete(record.id);
    }
  }

  private handleEvent(taskId: string, event: RunEvent): void {
    const record = this.tasks.get(taskId);
    if (!record) return;
    // DSH 实际 session id（首次 / -r 重试 / resume 换新）以事件为准回填，保证跨 run/status/result/tasks 一致。
    if (event.type === 'session' && typeof event.sessionId === 'string') {
      this.setSessionId(record, event.sessionId);
    }
    record.events.push(event);
    // 只有「workspace-write 模式 + 工具真的报错」才认作 ACL 沙箱失败；read-only / danger-full-access / 纯文本引用不算
    if (record.permissionMode === 'workspace-write' && event.type === 'tool_result') {
      const message = (event as { message?: { isError?: boolean } }).message;
      const isError = message?.isError === true || (event as { isError?: boolean }).isError === true;
      if (isError) {
        const eventJson = JSON.stringify(event);
        if (textLooksLikeSandboxAclFailure(eventJson.slice(0, 200_000))) {
          record.sandboxBlocked = true;
          record.sandboxBlockedDetail =
            sandboxAclFailureDetail(eventJson) ?? 'SetNamedSecurityInfoW failed (Win32 5): grantWrite';
          const attempt = this.activeAttempts.get(taskId);
          if (attempt) attempt.acl_blocked = true;
          // fail-fast：已知命令根本执行不了，不再让模型空转/等长超时；立即中止本次 attempt 进入降级决策。
          if (
            this.options.config.aclFailFast &&
            !record.aclAbort &&
            !record.cancelRequested &&
            (record.status as TaskStatus) === 'running'
          ) {
            record.aclAbort = true;
            const abortEvent: RunEvent = {
              type: 'status',
              phase: 'sandbox_acl_abort',
              detail: record.sandboxBlockedDetail,
            };
            record.events.push(abortEvent);
            this.audit({
              event: 'task_acl_abort',
              task_id: taskId,
              cwd: record.cwd,
              session_id: record.sessionId,
              detail: record.sandboxBlockedDetail,
            });
            void this.options.store.appendEvent(taskId, abortEvent).catch(() => undefined);
            this.notify(taskId);
            this.active.get(taskId)?.cancel();
          }
        }
      }
    }
    const usage = extractTokenUsage(event);
    if (usage) {
      record.usageTokens = addTokenUsage(record.usageTokens ?? emptyTokenUsage(), usage);
      const budget = this.options.config.maxTaskTokens;
      if (budget > 0 && record.usageTokens.totalTokens > budget && !record.tokenBudgetExceeded) {
        record.tokenBudgetExceeded = true;
        const detail = `total=${record.usageTokens.totalTokens} > budget=${budget}`;
        const budgetEvent: RunEvent = { type: 'status', phase: 'token_budget_exceeded', detail };
        record.events.push(budgetEvent);
        this.audit({ event: 'task_token_budget_exceeded', task_id: taskId, cwd: record.cwd, detail });
        void this.options.store.appendEvent(taskId, budgetEvent).catch(() => undefined);
        this.notify(taskId);
        this.active.get(taskId)?.cancel();
      }
    }
    const sink = this.progressSinks.get(taskId);
    if (sink) {
      const progress = countSteps(record.events);
      if (event.type === 'status' && event.phase === 'step_end') {
        safeProgress(sink, progress, `step ${progress}`);
      } else if (event.type === 'tool_call') {
        safeProgress(sink, progress, `tool: ${String(event.tool ?? 'unknown')}`);
      }
    }
    void this.options.store.appendEvent(taskId, event).catch(() => undefined);
    this.notify(taskId);
  }

  /** 沿运行期换号链解析到最新实际 session id。 */
  private resolveSessionId(sessionId: string): string {
    let current = sessionId;
    const seen = new Set<string>();
    while (!seen.has(current)) {
      seen.add(current);
      const next = this.sessionAliases.get(current);
      if (!next || next === current) break;
      current = next;
    }
    return current;
  }

  /** 回填实际 session id：保留旧 id 占用，登记别名链，并持久化到 meta。 */
  private setSessionId(record: TaskRecord, sessionId: string | null | undefined): void {
    if (!sessionId || sessionId === record.sessionId) return;
    const previous = record.sessionId;
    record.sessionId = sessionId;
    if (previous) this.sessionAliases.set(previous, sessionId);
    const locks = this.sessionLocks.get(record.id);
    if (locks) {
      if (previous) locks.add(previous);
      locks.add(sessionId);
    }
    if (record.status === 'running' || this.active.has(record.id)) {
      if (previous) this.busySessions.add(previous);
      this.busySessions.add(sessionId);
    }
    void this.saveQuietly(record);
  }

  private applyOutcome(record: TaskRecord, outcome: RunOutcome, timeoutMs: number): void {
    if (outcome.sessionId) this.setSessionId(record, outcome.sessionId);
    record.exitCode = outcome.exitCode;
    record.finalText = outcome.finalText;
    record.timedOut = outcome.timedOut;
    record.endedAt = this.now();

    if (outcome.cancelled) {
      record.status = 'cancelled';
      record.error = 'cancelled';
      return;
    }
    if (outcome.timedOut) {
      record.status = 'failed';
      record.error = `超时：任务在 ${Math.round(timeoutMs / 1000)}s 内未完成，已终止`;
      return;
    }
    if (outcome.exitCode === 0 && outcome.errorMessage === null) {
      record.status = 'succeeded';
      record.error = null;
      return;
    }
    record.status = 'failed';
    record.error = outcome.errorMessage ?? (outcome.stderrTail.trim() || `DSH 退出码 ${String(outcome.exitCode)}`);
  }

  private startCleanup(): void {
    const interval = this.options.config.cleanupIntervalMs;
    if (!Number.isFinite(interval) || interval <= 0) return;
    this.cleanupTimer = setInterval(() => {
      try {
        this.sweep();
      } catch {
        // 清理失败不影响任务执行
      }
      void this.cleanupWorktrees().catch(() => undefined);
    }, interval);
    this.cleanupTimer.unref?.();
  }

  private waitForChange(taskId: string, waitMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const set = this.waiters.get(taskId);
        set?.delete(finish);
        if (set && set.size === 0) this.waiters.delete(taskId);
        resolve();
      };
      const timer = setTimeout(finish, waitMs);
      const set = this.waiters.get(taskId) ?? new Set<() => void>();
      set.add(finish);
      this.waiters.set(taskId, set);
    });
  }

  private notify(taskId: string): void {
    const set = this.waiters.get(taskId);
    if (!set) return;
    for (const resolve of [...set]) resolve();
  }

  private async waitUntilTerminal(taskId: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const record = this.tasks.get(taskId);
      if (!record || isTerminalStatus(record.status)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  private async saveQuietly(record: TaskRecord): Promise<void> {
    try {
      await this.options.store.saveMeta(record);
    } catch {
      // 落盘失败不影响任务执行；events 里仍有内存记录
    }
  }
}

function countSteps(events: RunEvent[]): number {
  let steps = 0;
  for (const event of events) {
    if (event.type === 'status' && event.phase === 'step_end') steps += 1;
  }
  return steps;
}

/** 生成 worktree 改动的合入指引：只给结构化信息，不自动 apply（保留人工审阅边界）。 */
function buildMergeHint(record: TaskRecord, evidence: TaskEvidence | null): TaskMergeHint {
  // patch_path 在生产是绝对路径；测试/自定义 tasksDir 可能是相对路径，合入命令里统一用绝对路径。
  const patchPath = evidence?.git?.patch_path ? resolve(evidence.git.patch_path) : null;
  const repoDir = record.originalCwd ?? null;
  return {
    base_commit: record.worktree?.base_commit ?? null,
    patch_path: patchPath,
    apply_command: patchPath && repoDir ? `git -C "${repoDir}" apply --3way "${patchPath}"` : null,
    note: 'worktree 改动不会自动合入原仓库；apply 前先用 dsh_read_result(source=diff) 审阅（patch 可能包含 .dsh-* 探针文件与二进制占位）。',
  };
}

/** 最近一条 assistant 文本（失败/取消时作为部分成果返回）。 */
function lastAssistantText(record: TaskRecord): string | null {
  for (let index = record.events.length - 1; index >= 0; index -= 1) {
    const event = record.events[index];
    if (event && event.type === 'text' && typeof event.text === 'string' && event.text.trim().length > 0) {
      return event.text;
    }
  }
  return null;
}

/** 判断进程是否仍存活（用于多 worker 共享任务目录时避免误判 interrupted）。 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 失败分类：便于 leader 决定「重试 / 修环境 / 换粒度」。 */
function classifyFailure(record: TaskRecord): string | null {
  if (record.status === 'succeeded') return null;
  const error = `${record.error ?? ''}\n${record.sandboxFallback ? 'sandbox_fallback' : ''}`;
  if (record.tokenBudgetExceeded || /token_budget_exceeded/i.test(error)) return 'token_budget';
  // ACL 归因优先于 cancelled：任务可能因环境不可用被 leader 取消，但根因是沙箱 ACL。
  const aclBlocked =
    record.sandboxBlocked === true ||
    record.sandboxFallback !== undefined ||
    (record.attempts ?? []).some((attempt) => attempt.acl_blocked) ||
    /SetNamedSecurityInfoW|grantWrite|sandbox_acl/i.test(error);
  if (aclBlocked) return 'sandbox_acl';
  if (record.status === 'cancelled') return 'cancelled';
  if (/already exists|session_resume/i.test(error)) return 'session_conflict';
  if (/initialize|SDK 后端启动失败|JSON-RPC 请求超时/i.test(error)) return 'backend_init';
  if (/SDK 后端|进程退出|已被终止/i.test(error)) return 'backend_crash';
  if (record.timedOut) return 'timeout';
  if (/approval|审批/i.test(error)) return 'approval';
  return 'task_error';
}

const FAILURE_SUGGESTIONS: Record<string, string> = {
  sandbox_acl:
    '该目录或 worktree 根 ACL 不允许 DSH 写沙箱（需要完全控制/WRITE_OWNER）。可执行：icacls "<cwd>" /grant "<用户>:(OI)(CI)F"（先确认合规）；或把 DSH_MCP_WORKTREE_ROOT 指到完全控制目录（如 %USERPROFILE%\\dsh-worktrees）；或显式传 permission_mode=danger-full-access / read-only。',
  session_conflict: 'worker 已自动换新 session 恢复；如需完整历史请在 worker 存活期内续聊。',
  backend_init: 'DSH 后端初始化失败（已自动重试/降级）；若持续复现检查 DSH 安装与网络。',
  backend_crash: 'DSH 后端异常退出（已自动重试一次）；若持续复现检查内存/日志。',
  timeout: '任务超时：缩小范围或提高 timeout_s。',
  token_budget: '超出 token 预算被终止：缩小任务范围或提高 DSH_MCP_MAX_TASK_TOKENS。',
  approval: '任务被审批阻断：缩小操作范围或请用户显式授权。',
  cancelled: '任务被取消：如非预期，检查 leader 侧 dsh_cancel 调用。',
  task_error: '查看 dsh_result.error 与 dsh_read_result 的完整事件。',
};

/** B3：失败诊断摘要（停在哪一步、最后错误、建议动作）。 */
function buildDiagnosis(record: TaskRecord): { kind: string; stage: string; last_error: string | null; suggestion: string } | null {
  const kind = classifyFailure(record);
  if (!kind) return null;
  let stage = 'unknown';
  let lastError: string | null = null;
  for (let index = record.events.length - 1; index >= 0; index -= 1) {
    const event = record.events[index];
    if (!event) continue;
    if (stage === 'unknown' && event.type === 'status' && typeof event.phase === 'string') stage = event.phase;
    if (lastError === null && event.type === 'tool_result') {
      const message = (event as { message?: { isError?: boolean; content?: Array<{ text?: string }> } }).message;
      if (message?.isError === true) {
        lastError = (message.content ?? []).map((block) => block.text ?? '').join(' ').slice(0, 400) || 'tool error';
      }
    }
  }
  const errorText = String(record.error ?? lastError ?? '').slice(0, 500);
  return {
    kind,
    stage,
    last_error: lastError ?? (errorText || null),
    suggestion: FAILURE_SUGGESTIONS[kind] ?? '查看 dsh_result.error 与 events 详情。',
  };
}

function derivePhase(record: TaskRecord): string {
  if (record.status === 'queued') return 'queued';
  if (record.status !== 'running') return record.status;
  for (let index = record.events.length - 1; index >= 0; index -= 1) {
    const event = record.events[index];
    if (event && event.type === 'status' && typeof event.phase === 'string') return event.phase;
  }
  return 'running';
}

function safeProgress(sink: (progress: number, message?: string) => void, progress: number, message: string): void {
  try {
    sink(progress, message);
  } catch {
    // 进度上报失败不应影响任务
  }
}

function normalizeCwd(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

