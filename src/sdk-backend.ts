import { spawn, type ChildProcess } from 'node:child_process';
import { WorkerError } from './errors.js';
import { JsonRpcLineClient } from './jsonrpc-line.js';
import type { RunEvent } from './types.js';

const STDERR_TAIL_CHARS = 8 * 1024;
const PROMPT_REQUEST_TIMEOUT_MS = 30_000;

export interface SdkBackendOptions {
  spawn: { command: string; args: string[]; shell?: boolean };
  profile: string;
  cwd: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
  maxTokens?: number;
  initTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface PromptOutcome {
  text: string | null;
  reason: string | null;
  error?: string;
  timedOut: boolean;
  cancelled: boolean;
}

interface PendingPrompt {
  sessionId: string;
  onEvent: (event: RunEvent) => void;
  assistantText: string | null;
  steps: number;
  timedOut: boolean;
  cancelled: boolean;
  timer: NodeJS.Timeout | undefined;
  resolve: (outcome: PromptOutcome) => void;
}

interface SessionMessage {
  sessionId: string;
  event: {
    type: string;
    data?: {
      reason?: unknown;
      usage?: unknown;
      call?: { name?: string; tool?: string };
      message?: { content?: Array<{ type?: string; text?: string }> };
    };
  };
}

/**
 * 长驻的 `dsh --profile sdk` 后端：一次 initialize，之后每个任务只发一次 `session/prompt`。
 * 协议没有 cancel / session close —— 取消等价于杀掉进程，下次任务会重新启动。
 */
export class SdkBackend {
  readonly cwd: string;
  lastUsedAt = Date.now();
  private child: ChildProcess | null = null;
  private client: JsonRpcLineClient | null = null;
  private initialized = false;
  private closed = false;
  private exitError: Error | null = null;
  private stderrTail = '';
  private readonly pending = new Map<string, PendingPrompt>();
  private readonly exitListeners = new Set<(error: Error | null) => void>();

  private constructor(private readonly options: SdkBackendOptions) {
    this.cwd = options.cwd;
  }

  static async start(options: SdkBackendOptions, startOptions: { attempts?: number } = {}): Promise<SdkBackend> {
    const attempts = Math.max(1, startOptions.attempts ?? 2);
    let lastError: string = 'unknown';
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const backend = new SdkBackend(options);
      try {
        await backend.boot();
        return backend;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stderr = backend.diagnostics.trim();
        lastError = `${message}${stderr ? `；stderr: ${stderr.slice(-600)}` : ''}`;
        backend.kill();
        if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
    }
    throw new WorkerError('internal', `SDK 后端启动失败（已尝试 ${attempts} 次）：${lastError}`);
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** 是否有正在执行的 prompt（有则不能被空闲回收杀掉）。 */
  get busy(): boolean {
    return this.pending.size > 0;
  }

  get diagnostics(): string {
    return this.stderrTail;
  }

  async prompt(
    sessionId: string,
    text: string,
    onEvent: (event: RunEvent) => void,
    timeoutMs: number,
  ): Promise<PromptOutcome> {
    if (this.closed) throw new WorkerError('internal', `SDK 后端已关闭：${this.exitError?.message ?? 'unknown'}`);
    this.lastUsedAt = Date.now();
    if (this.pending.has(sessionId)) {
      throw new WorkerError('internal', `SDK session 已有进行中的任务：${sessionId}`);
    }

    return new Promise<PromptOutcome>((resolve) => {
      const state: PendingPrompt = {
        sessionId,
        onEvent,
        assistantText: null,
        steps: 0,
        timedOut: false,
        cancelled: false,
        timer: undefined,
        resolve,
      };
      state.timer = setTimeout(() => {
        state.timedOut = true;
        this.kill();
      }, Math.max(1_000, timeoutMs));
      this.pending.set(sessionId, state);

      onEvent({ type: 'status', phase: 'turn_start', turn: 1 });
      this.client
        ?.request(
          'session/prompt',
          { sessionId, contentBlocks: [{ type: 'text', text }] },
          PROMPT_REQUEST_TIMEOUT_MS,
        )
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.finishPrompt(sessionId, { text: null, reason: null, error: message, timedOut: false, cancelled: false });
        });
    });
  }

  /** 取消当前后端：杀进程（SDK 协议无 cancel 方法）。 */
  cancel(): void {
    for (const [sessionId] of this.pending) {
      const state = this.pending.get(sessionId);
      if (state) state.cancelled = true;
    }
    this.kill();
  }

  /** 优雅关闭：先发 shutdown，再兜底杀进程。 */
  async shutdown(): Promise<void> {
    if (this.closed) return;
    try {
      await this.client?.request('shutdown', undefined, 5_000);
    } catch {
      // 忽略：随后仍会杀死进程
    }
    this.kill();
  }

  onExit(listener: (error: Error | null) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  private async boot(): Promise<void> {
    const { spawn: spawnOptions, cwd } = this.options;
    const child = spawn(spawnOptions.command, [...spawnOptions.args, '--profile', this.options.profile], {
      cwd,
      env: { ...process.env, ...this.options.env },
      windowsHide: true,
      shell: spawnOptions.shell ?? false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.on('error', (error) => {
      this.closeWithError(error);
    });
    child.on('exit', (code, signal) => {
      this.closeWithError(new Error(`SDK 后端进程退出（code=${String(code)}, signal=${String(signal)}）`));
    });

    this.client = new JsonRpcLineClient(child.stdout, child.stdin);
    this.client.onNotification('session.event', (params) => this.onSessionEvent(params as SessionMessage));
    this.client.onNotification('session.status', (params) => {
      const payload = params as { sessionId?: string; status?: string };
      if (!payload?.sessionId) return;
      const state = this.pending.get(payload.sessionId);
      if (!state) return;
      state.onEvent({ type: 'status', phase: payload.status === 'running' ? 'step_start' : 'idle' });
    });

    const result = await this.client.request<{ serverInfo?: { name?: string } }>(
      'initialize',
      {
        cwd,
        provider: this.options.provider,
        model: this.options.model,
        ...(this.options.reasoningEffort ? { reasoningEffort: this.options.reasoningEffort } : {}),
        ...(this.options.maxTokens ? { maxTokens: this.options.maxTokens } : {}),
      },
      this.options.initTimeoutMs ?? 120_000,
    );
    if (result?.serverInfo?.name !== 'deepseek-harness-sdk-runtime') {
      this.kill();
      throw new WorkerError('internal', `SDK 后端握手返回了非预期身份：${JSON.stringify(result)}`);
    }
    this.initialized = true;
  }

  private onSessionEvent(payload: SessionMessage): void {
    const state = this.pending.get(payload?.sessionId);
    if (!state) return;
    const event = payload.event;
    if (!event) return;

    if (event.type === 'assistant/message') {
      const content = event.data?.message?.content ?? [];
      const text = content
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('');
      if (text.length > 0) {
        state.assistantText = text;
        state.onEvent({ type: 'text', text });
      }
      state.steps += 1;
      // 把 assistant/message 上的原始 usage 透传给 TaskManager，用于 token 计量
      const rawUsage = (event.data as { usage?: unknown } | undefined)?.usage;
      state.onEvent({
        type: 'status',
        phase: 'step_end',
        turn: 1,
        step: state.steps,
        ...(rawUsage !== undefined ? { usage: rawUsage } : {}),
      });
      return;
    }

    if (event.type === 'tool/call') {
      const data = event.data as
        | { callId?: string; name?: string; arguments?: unknown; call?: { name?: string; tool?: string; callId?: string; arguments?: unknown } }
        | undefined;
      const name = data?.name ?? data?.call?.name ?? data?.call?.tool ?? 'unknown';
      const callId = data?.callId ?? data?.call?.callId;
      state.onEvent({
        type: 'tool_call',
        tool: name,
        ...(callId ? { call_id: callId } : {}),
        arguments: boundedToolArguments(data?.arguments ?? data?.call?.arguments),
      });
      return;
    }

    if (event.type === 'tool/result') {
      const data = event.data as { message?: { toolCallId?: string } } | undefined;
      const callId = data?.message?.toolCallId;
      state.onEvent({
        type: 'tool_result',
        ...(callId ? { call_id: callId } : {}),
        message: data?.message ?? null,
      });
      return;
    }

    if (event.type === 'turn/end') {
      const reason = normalizeTurnEndReason(event.data?.reason);
      state.onEvent({ type: 'status', phase: 'turn_end', turn: 1, reason });
      this.finishPrompt(payload.sessionId, {
        text: state.assistantText,
        reason,
        timedOut: state.timedOut,
        cancelled: state.cancelled,
      });
    }
  }

  private finishPrompt(sessionId: string, outcome: PromptOutcome): void {
    const state = this.pending.get(sessionId);
    if (!state) return;
    this.pending.delete(sessionId);
    this.lastUsedAt = Date.now();
    if (state.timer) clearTimeout(state.timer);
    state.resolve({ ...outcome, timedOut: outcome.timedOut || state.timedOut, cancelled: outcome.cancelled || state.cancelled });
  }

  private kill(): void {
    const child = this.child;
    if (!child?.pid) {
      this.closeWithError(new Error('SDK 后端已终止'));
      return;
    }
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => undefined);
    } else {
      try {
        child.kill('SIGKILL');
      } catch {
        // 进程已退出
      }
    }
    this.closeWithError(new Error('SDK 后端已被终止'));
  }

  private closeWithError(error: Error | null): void {
    if (this.closed) return;
    this.closed = true;
    this.exitError = error;
    this.client?.close(error ?? undefined);
    for (const [, state] of this.pending) {
      if (state.timer) clearTimeout(state.timer);
      state.resolve({
        text: state.assistantText,
        reason: state.cancelled ? 'cancelled' : 'error',
        error: error?.message,
        timedOut: state.timedOut,
        cancelled: state.cancelled,
      });
    }
    this.pending.clear();
    for (const listener of [...this.exitListeners]) {
      try {
        listener(error);
      } catch {
        // 忽略监听器异常
      }
    }
    this.exitListeners.clear();
  }
}

/** turn/end 的 reason 在新版 session 事件里是 `{ kind }` 对象，老格式可能是字符串。 */
/** 工具参数落盘预算：字符串字段截到 2 KiB，避免大参数撑爆事件文件。 */
function boundedToolArguments(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = typeof item === 'string' && item.length > 2_048 ? `${item.slice(0, 2_048)}…` : item;
  }
  return output;
}

function normalizeTurnEndReason(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object' && typeof (value as { kind?: unknown }).kind === 'string') {
    return (value as { kind: string }).kind;
  }
  return 'unknown';
}
