import type { RunHandle, TaskRunner } from './task-manager.js';
import type { RunEvent, RunOutcome } from './types.js';

export interface FallbackRunnerOptions {
  primary: TaskRunner;
  fallback: TaskRunner;
  /** 自定义判定：返回 true 时用 fallback 重跑（默认匹配 SDK initialize/启动失败）。 */
  shouldFallback?: (outcome: RunOutcome) => boolean;
}

const DEFAULT_FALLBACK_PATTERN = /initialize|SDK 后端启动失败|SDK 后端进程退出|握手/;

/**
 * 后端降级：sdk 长驻后端起不来时（initialize 超时/进程退出），自动用 headless 跑同一个任务，
 * 避免 leader 端直接看到一次失败。仅对「基础设施失败」触发，业务失败原样返回。
 */
export function createFallbackRunner(options: FallbackRunnerOptions): TaskRunner {
  return (input) => {
    const startedAt = Date.now();
    let active: RunHandle | null = null;
    let settled = false;
    let cancelled = false;
    let resolveOutcome!: (outcome: RunOutcome) => void;
    const outcome = new Promise<RunOutcome>((resolve) => {
      resolveOutcome = resolve;
    });

    const finish = (value: RunOutcome): void => {
      if (settled) return;
      settled = true;
      resolveOutcome(value);
    };

    const baseOutcome = (partial: Partial<RunOutcome>): RunOutcome => ({
      exitCode: null,
      signal: null,
      finalText: null,
      sessionId: null,
      errorMessage: null,
      timedOut: false,
      cancelled: false,
      stderrTail: '',
      events: [],
      startedAt,
      endedAt: Date.now(),
      ...partial,
    });

    void (async () => {
      try {
        active = options.primary(input);
        const primaryOutcome = await active.outcome;
        if (cancelled) {
          finish(primaryOutcome);
          return;
        }
        const shouldFallback = options.shouldFallback
          ? options.shouldFallback(primaryOutcome)
          : DEFAULT_FALLBACK_PATTERN.test(primaryOutcome.errorMessage ?? '');
        if (!shouldFallback) {
          finish(primaryOutcome);
          return;
        }
        const note: RunEvent = {
          type: 'status',
          phase: 'fallback',
          reason: 'primary-backend-failed',
          detail: primaryOutcome.errorMessage ?? 'unknown',
        };
        input.onEvent(note);
        active = options.fallback(input);
        const fallbackOutcome = await active.outcome;
        finish({
          ...fallbackOutcome,
          events: [...primaryOutcome.events, note, ...fallbackOutcome.events],
          stderrTail: [primaryOutcome.stderrTail, fallbackOutcome.stderrTail].filter(Boolean).join('\n').slice(-8_000),
        });
      } catch (error) {
        finish(
          baseOutcome({
            exitCode: 1,
            errorMessage: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    })();

    return {
      pid: null,
      cancel: () => {
        cancelled = true;
        active?.cancel();
      },
      outcome,
    };
  };
}
