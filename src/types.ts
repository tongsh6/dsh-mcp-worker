/** DSH `--json` 事件流里的一条事件。 */
export interface RunEvent {
  type: string;
  [key: string]: unknown;
}

/** 一次 `dsh headless --json` 子进程运行的最终结果。 */
export interface RunOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  finalText: string | null;
  sessionId: string | null;
  errorMessage: string | null;
  timedOut: boolean;
  cancelled: boolean;
  stderrTail: string;
  events: RunEvent[];
  startedAt: number;
  endedAt: number;
}

export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** 任务排队原因：并发额度耗尽 / 同 session 已有任务在跑。 */
export type QueuedReason = 'concurrency' | 'session';

/** 一次模型调用（或 DSH 任务内多次调用之和）的 token 用量。 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

/** workspace-write 沙箱 ACL 授权失败后自动降级 read-only 的记录。 */
export interface SandboxFallback {
  from: string;
  to: 'read-only' | 'danger-full-access';
  reason: string;
}

/** 任务结果的正交维度（不改变 TaskStatus）。 */
export type TaskOutcome = 'completed' | 'needs_decision' | 'failed' | 'cancelled';

export interface CommandEvidence {
  seq: number;
  tool: string;
  command: string;
  command_truncated?: boolean;
  workdir?: string;
  exit_code: number | null;
  is_error: boolean;
  markers: string[];
  output_tail?: string;
}

export interface EditEvidence {
  path: string;
  ops: {
    create?: number;
    write?: number;
    edit?: number;
    str_replace?: number;
    insert?: number;
    apply_patch?: number;
    other?: number;
  };
  errors: number;
}

export interface GitEvidence {
  dir: string;
  head: string | null;
  branch: string | null;
  files: Array<{ path: string; status: string; pre_existing: boolean }>;
  files_truncated?: boolean;
  diff_stat: string;
  summary: { files_changed: number; insertions: number; deletions: number; untracked: number } | null;
  pre_existing_dirty: boolean;
  patch_path: string | null;
  patch_truncated?: boolean;
  error?: string;
}

export interface TaskEvidence {
  commands: CommandEvidence[];
  commands_truncated?: boolean;
  commands_total: number;
  edits: EditEvidence[];
  git: GitEvidence | null;
  summary: {
    commands_failed: number;
    last_command_exit_code: number | null;
    edits_failed: number;
  };
}

/** 任务记录：内存态与落盘 meta 的共同结构（落盘时不含 events）。 */
export interface TaskRecord {
  id: string;
  status: TaskStatus;
  task: string;
  cwd: string;
  sessionId?: string;
  permissionMode: string;
  /** 用户请求的权限模式（auto 或显式）；用于区分 cwd 能力缓存与执行策略。 */
  requestedPermissionMode?: string;
  /** 本次任务允许的最长运行时间（毫秒）；缺省用配置默认值。 */
  timeoutMs?: number;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  exitCode?: number | null;
  finalText?: string | null;
  error?: string | null;
  timedOut: boolean;
  /** 任务内 DSH 模型调用的 token 用量（来自 session 事件 usage）。 */
  usageTokens?: TokenUsage;
  /** 沙箱 ACL 授权失败后自动降级的记录（缺省 = 未降级）。 */
  sandboxFallback?: SandboxFallback;
  /** 本次尝试是否观察到沙箱 ACL 失败（工具结果里出现 grantWrite Win32 5）。 */
  sandboxBlocked?: boolean;
  /** 观察到的 ACL 失败原文片段（用于降级原因/报错）。 */
  sandboxBlockedDetail?: string;
  /** 是否因超出 token 预算被强制取消。 */
  tokenBudgetExceeded?: boolean;
  /** 瞬态失败自动重试次数。 */
  transientRetries?: number;
  /** 因 ACL 受限自动切换到的可写 worktree。 */
  worktree?: { path: string; branch: string };
  /** 切换 worktree 前的原始 cwd。 */
  originalCwd?: string;
  /** 创建该任务的 worker 进程 PID；多 worker 共享任务目录时用于判断任务是否仍被其他活进程执行。 */
  workerPid?: number;
  /** 任务开始前 git 工作树的脏文件基线（porcelain 行）。 */
  gitBaseline?: string[];
  /** 结果维度（completed / needs_decision / failed / cancelled）。 */
  outcome?: TaskOutcome;
  /** outcome=needs_decision 时 DSH 给出的问题清单。 */
  decisionRequest?: string;
  /** 是否已采集并落盘 evidence.json。 */
  evidenceCollected?: boolean;
  /** 证据摘要统计（用于 dsh_metrics，避免每次读文件）。 */
  evidenceStats?: { commands_failed: number; has_git: boolean };
  events: RunEvent[];
}

/** `dsh_status` 的返回结构。 */
export interface TaskStatusPayload {
  task_id: string;
  status: TaskStatus;
  phase: string;
  progress: number;
  events: RunEvent[];
  /** 本次 events 是否因条数/字节预算未返回全部增量；原始事件仍在 events.jsonl。 */
  events_truncated?: boolean;
  next_cursor: number;
  created_at: number;
  started_at?: number;
  ended_at?: number;
  error?: string | null;
  /** status.error 是否因 UTF-8 字节上限被截断（完整错误仍可通过 result/events 查看）。 */
  error_truncated?: boolean;
  timed_out: boolean;
  session_id?: string;
  /** 仅 queued 状态给出：为什么还在排队。 */
  queued_reason?: QueuedReason | null;
  /** 当前累计的 DSH token 用量（运行中即可见，便于 leader 及早止损）。 */
  tokens?: TokenUsage | null;
  /** 已完成 step 数。 */
  steps?: number;
  /** 已发起的工具调用数。 */
  tool_calls?: number;
  /** 终态时的结果维度；运行中为 null。 */
  outcome?: TaskOutcome | null;
  /** detail=summary 时附带的最后一条 assistant 文本摘要（≤ 300 字节）。 */
  last_text?: string | null;
}

/** `dsh_result` 的返回结构。 */
export interface TaskResultPayload {
  task_id: string;
  status: TaskStatus;
  output: string | null;
  error: string | null;
  exit_code?: number | null;
  session_id?: string;
  timed_out: boolean;
  events_count: number;
  /** 是否发生沙箱 ACL 降级（workspace-write → read-only / danger-full-access）。 */
  sandbox_fallback?: SandboxFallback | null;
  /** 实际执行使用的权限模式（发生降级时与请求值不同）。 */
  effective_permission_mode?: string | null;
  /** 失败/取消时的部分成果（最后一条 assistant 文本），成功时为 null 或最后文本。 */
  partial_output?: string | null;
  /** 失败分类：sandbox_acl / session_conflict / backend_init / backend_crash / timeout / approval / cancelled / task_error。 */
  failure_kind?: string | null;
  /** 失败诊断（停在哪一步、最后错误、建议动作）。 */
  diagnosis?: {
    kind: string;
    stage: string;
    last_error: string | null;
    suggestion: string;
  } | null;
  /** 结果维度：completed / needs_decision / failed / cancelled（与 status 正交）。 */
  outcome: TaskOutcome;
  /** outcome=needs_decision 时 DSH 给出的问题清单（≤ 4 KiB）。 */
  decision_request: string | null;
  /** 从事件提取的结构化证据（命令退出码/编辑/git 变更）；未采集时为 null。 */
  evidence: TaskEvidence | null;
  /** 因 ACL 受限自动切换到的可写 worktree（leader 可去该路径审查/合入）。 */
  worktree?: { path: string; branch: string } | null;
  /** 瞬态失败自动重试次数。 */
  retries?: number;
  usage: {
    steps: number;
    tool_calls?: number;
    wall_ms: number | null;
    /** DSH 侧 token 用量；缺失表示后端事件未带 usage。 */
    tokens: TokenUsage | null;
  };
}

/** `dsh_tasks` 的列表项（任务摘要）。 */
export interface TaskSummary {
  task_id: string;
  status: TaskStatus;
  task: string;
  cwd: string;
  session_id?: string;
  permission_mode: string;
  created_at: number;
  started_at?: number;
  ended_at?: number;
  error?: string | null;
  /** 结果维度（终态时给出）。 */
  outcome?: TaskOutcome | null;
}

/** 审计日志条目（append-only JSONL）。 */
export interface AuditEntry {
  ts: number;
  event: string;
  task_id?: string;
  cwd?: string;
  session_id?: string;
  permission_mode?: string;
  detail?: string;
}

export function isTerminalStatus(status: TaskStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}
