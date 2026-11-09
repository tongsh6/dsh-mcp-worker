import type { RunOutcome, TaskRecord } from '../src/types.js';
import type { Store, TaskRunner, TaskRunInput } from '../src/task-manager.js';
import type { WorkerConfig } from '../src/config.js';

export function makeRunOutcome(partial: Partial<RunOutcome> = {}): RunOutcome {
  const now = Date.now();
  return {
    exitCode: 0,
    signal: null,
    finalText: 'done',
    sessionId: 'sess-fake',
    errorMessage: null,
    timedOut: false,
    cancelled: false,
    stderrTail: '',
    events: [],
    startedAt: now,
    endedAt: now,
    ...partial,
  };
}

/**
 * 假 Runner：按固定节奏发事件并给出结果，不依赖真实 DSH 进程。
 * 可用于验证任务管理器 / MCP 工具的排队、状态、取消、会话串行等逻辑。
 */
export function makeFakeRunner(
  opts: {
    delayMs?: number;
    finalText?: string;
    fail?: boolean;
    onStart?: (input: TaskRunInput) => void;
  } = {},
): { runner: TaskRunner; calls: TaskRunInput[]; cancelCount: () => number } {
  const calls: TaskRunInput[] = [];
  let cancels = 0;

  const runner: TaskRunner = (input) => {
    calls.push(input);
    opts.onStart?.(input);
    let settled = false;
    let resolveOutcome!: (outcome: RunOutcome) => void;
    const outcome = new Promise<RunOutcome>((resolve) => {
      resolveOutcome = resolve;
    });
    const finish = (value: RunOutcome) => {
      if (settled) return;
      settled = true;
      resolveOutcome(value);
    };

    const timer = setTimeout(() => {
      input.onEvent({ type: 'status', phase: 'step_start', turn: 1, step: 1 });
      input.onEvent({ type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { totalTokens: 1 } });
      if (opts.fail) {
        input.onEvent({ type: 'error', message: 'fake failure' });
        finish(makeRunOutcome({ exitCode: 1, finalText: null, errorMessage: 'fake failure' }));
        return;
      }
      input.onEvent({ type: 'final', text: opts.finalText ?? 'done' });
      finish(makeRunOutcome({ finalText: opts.finalText ?? 'done' }));
    }, opts.delayMs ?? 5);

    return {
      pid: 4242,
      cancel: () => {
        cancels += 1;
        clearTimeout(timer);
        input.onEvent({ type: 'status', phase: 'turn_end', turn: 1, reason: 'cancelled' });
        finish(makeRunOutcome({ exitCode: null, finalText: null, cancelled: true }));
      },
      outcome,
    };
  };

  return { runner, calls, cancelCount: () => cancels };
}

/** 内存存储：模拟 JSONL 落盘，便于断言持久化与恢复行为。 */
export class MemoryStore implements Store {
  readonly records = new Map<string, TaskRecord>();

  async init(): Promise<void> {}

  async saveMeta(record: TaskRecord): Promise<void> {
    this.records.set(record.id, structuredClone(record));
  }

  async appendEvent(id: string, event: TaskRecord['events'][number]): Promise<void> {
    const current = this.records.get(id);
    if (!current) return;
    current.events.push(structuredClone(event));
  }

  async loadAll(): Promise<TaskRecord[]> {
    return [...this.records.values()].map((r) => structuredClone(r));
  }

  async remove(taskId: string): Promise<void> {
    this.records.delete(taskId);
  }
}

export function makeTestConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    name: 'dsh-mcp-worker',
    version: '0.1.0-test',
    profile: 'headless',
    dsh: { command: process.execPath, args: ['fake-dsh.js'], source: 'test' },
    backend: 'headless',
    transport: 'stdio',
    http: { host: '127.0.0.1', port: 0, token: '' },
    sdk: {
      profile: 'sdk',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      idleMs: 60_000,
      initTimeoutMs: 30_000,
    },
    dshPatch: 'apply',
    aclFallback: 'read-only',
    statusWaitMaxMs: 30_000,
    maxTaskTokens: 0,
    dshHome: 'test-dsh-home',
    tasksDir: 'test-tasks',
    defaultCwd: undefined,
    allowedCwds: [],
    defaultPermissionMode: 'workspace-write',
    capabilityStore: false,
    capabilityTtlMs: 60_000,
    retryTransient: false,
    autoWorktree: false,
    worktreeRoot: 'test-worktrees',
    defaultTimeoutMs: 5_000,
    maxConcurrent: 2,
    maxConcurrentPerCwd: 2,
    taskTtlMs: 24 * 60 * 60 * 1000,
    maxTasks: 500,
    cleanupIntervalMs: 60_000,
    auditDir: 'test-audit',
    batchDir: 'test-batches',
    maxBatchTasks: 8,
    otelServiceName: 'dsh-mcp-worker',
    maxResultChars: 1_000,
    maxStatusEvents: 50,
    maxStatusPayloadBytes: 16 * 1024,
    ...overrides,
  };
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
