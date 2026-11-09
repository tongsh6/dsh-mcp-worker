import type { RunEvent, RunOutcome } from './types.js';
import type { SdkBackendPool } from './sdk-pool.js';
import type { RunHandle, TaskRunner } from './task-manager.js';

/**
 * 用长驻 SDK 后端实现 TaskRunner：
 * - 首任务支付一次 `dsh --profile sdk` 冷启动 + initialize，后续任务只发 prompt；
 * - 取消 = 杀掉该 cwd 的后端进程（SDK 协议无 cancel 方法），下次任务自动重建；
 * - 续聊恢复：DSH SDK 协议没有 resume/restore，新后端遇到磁盘上已存在的 session id 会报
 *   `session "..." already exists`；此时自动换新 session id 重试一次，并附上 worker 记录的
 *   上一轮任务/结果摘要（resumeContext），让续聊语义尽量保留。
 */
export function createSdkRunner(pool: SdkBackendPool): TaskRunner {
  return (input): RunHandle => {
    const startedAt = Date.now();
    const events: RunEvent[] = [];
    let cancelled = false;
    let settled = false;
    let backendRef: Awaited<ReturnType<SdkBackendPool['acquire']>> | null = null;
    let resolveOutcome!: (outcome: RunOutcome) => void;
    const outcome = new Promise<RunOutcome>((resolve) => {
      resolveOutcome = resolve;
    });

    const finish = (partial: Partial<RunOutcome>): void => {
      if (settled) return;
      settled = true;
      resolveOutcome({
        exitCode: 0,
        signal: null,
        finalText: null,
        sessionId: null,
        errorMessage: null,
        timedOut: false,
        cancelled: false,
        stderrTail: '',
        events,
        startedAt,
        endedAt: Date.now(),
        ...partial,
      });
    };

    const baseSessionId = input.sessionId ?? `mcp-${input.id}`;
    let sessionId = input.attempt && input.attempt > 1 ? `${baseSessionId}-r${input.attempt}` : baseSessionId;
    input.onEvent({ type: 'session', sessionId, cwd: input.cwd });

    const emit = (event: RunEvent): void => {
      events.push(event);
      input.onEvent(event);
    };

    const promptWithRecovery = async (
      backend: NonNullable<typeof backendRef>,
      timeoutMs: number,
    ): Promise<Awaited<ReturnType<(typeof backend)['prompt']>>> => {
      const isSessionExists = (text: string): boolean => /already exists/i.test(text);
      const recover = async (message: string): Promise<Awaited<ReturnType<(typeof backend)['prompt']>>> => {
        // 持久化 session 存在、但当前后端无法恢复：换新 id 重试，并附 worker 侧的上一轮摘要
        const resumeId = `${baseSessionId}-resume-${Date.now().toString(36)}`;
        emit({
          type: 'status',
          phase: 'session_resume_fallback',
          reason: 'session-not-live',
          detail: message.slice(0, 500),
          from: sessionId,
          to: resumeId,
        });
        sessionId = resumeId;
        input.onEvent({ type: 'session', sessionId, cwd: input.cwd });
        const resumeText = input.resumeContext ? `${input.resumeContext}\n\n[新指令]\n${input.task}` : input.task;
        return backend.prompt(sessionId, resumeText, emit, timeoutMs);
      };

      let result: Awaited<ReturnType<(typeof backend)['prompt']>>;
      try {
        result = await backend.prompt(sessionId, input.task, emit, timeoutMs);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!isSessionExists(message)) throw error;
        return recover(message);
      }
      if (result.reason !== 'completed' && !result.cancelled && !result.timedOut) {
        const message = result.error ?? '';
        if (isSessionExists(message)) return recover(message);
      }
      return result;
    };

    void (async () => {
      try {
        const backend = await pool.acquire(input.cwd, input.permissionMode);
        backendRef = backend;
        if (cancelled) {
          pool.kill(backend);
          finish({ sessionId, cancelled: true });
          return;
        }
        const result = await promptWithRecovery(backend, input.timeoutMs);
        const succeeded = result.reason === 'completed';
        finish({
          exitCode: succeeded ? 0 : 1,
          sessionId,
          finalText: result.text,
          timedOut: result.timedOut,
          cancelled: result.cancelled,
          errorMessage: succeeded ? null : (result.error ?? `turn/end: ${String(result.reason)}`),
          stderrTail: backend.diagnostics,
        });
        if (result.timedOut || result.cancelled) pool.kill(backend);
      } catch (error) {
        finish({
          exitCode: 1,
          sessionId,
          errorMessage: error instanceof Error ? error.message : String(error),
          stderrTail: backendRef?.diagnostics ?? '',
        });
      }
    })();

    return {
      pid: null,
      cancel: () => {
        cancelled = true;
        if (backendRef) {
          pool.kill(backendRef);
          return;
        }
        // 后端还没拿到：先结算，异步分支拿到后会发现 cancelled 并清理
        finish({ sessionId, cancelled: true });
      },
      outcome,
    };
  };
}
