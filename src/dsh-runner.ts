import { spawn } from 'node:child_process';
import { NdjsonParser } from './ndjson.js';
import type { RunEvent, RunOutcome } from './types.js';

const STDERR_TAIL_CHARS = 8 * 1024;
const KILL_GRACE_MS = 5_000;

export interface RunSpawn {
  command: string;
  args: string[];
  shell?: boolean;
}

export interface RunInput {
  task: string;
  cwd: string;
  sessionId?: string;
  permissionMode?: string;
  timeoutMs: number;
  profile: string;
  spawn: RunSpawn;
  env?: NodeJS.ProcessEnv;
  /** 第几次尝试（1=首次；沙箱 ACL 降级重试为 2，用于生成新 session id）。 */
  attempt?: number;
  onEvent?: (event: RunEvent) => void;
}

export interface RunHandle {
  pid: number | null;
  cancel: () => void;
  outcome: Promise<RunOutcome>;
}

/**
 * 启动一次 `dsh --profile <profile> --json <task>` 子进程。
 * - stdout：按行解析 NDJSON，投影事件；
 * - stderr：只保留尾部用于诊断，不当作失败信号；
 * - 超时/取消：杀掉整个进程树（Windows 用 taskkill /T）。
 */
export function startDshRun(input: RunInput): RunHandle {
  const parser = new NdjsonParser();
  const events: RunEvent[] = [];
  const startedAt = Date.now();
  let finalText: string | null = null;
  let sessionId: string | null = null;
  let errorMessage: string | null = null;
  let stderrTail = '';
  let timedOut = false;
  let cancelled = false;
  let settled = false;
  let graceTimer: NodeJS.Timeout | undefined;

  let resolveOutcome!: (outcome: RunOutcome) => void;
  const outcome = new Promise<RunOutcome>((resolve) => {
    resolveOutcome = resolve;
  });

  const args = [
    ...input.spawn.args,
    '--profile',
    input.profile,
    '--json',
    ...(input.sessionId
      ? ['--session-id', input.attempt && input.attempt > 1 ? `${input.sessionId}-r${input.attempt}` : input.sessionId]
      : []),
    input.task,
  ];

  const child = spawn(input.spawn.command, args, {
    cwd: input.cwd,
    env: {
      ...process.env,
      ...input.env,
      ...(input.permissionMode ? { DSH_PERMISSION_MODE: input.permissionMode } : {}),
    },
    windowsHide: true,
    shell: input.spawn.shell ?? false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutTimer);
    if (graceTimer) clearTimeout(graceTimer);
    resolveOutcome({
      exitCode,
      signal,
      finalText,
      sessionId,
      errorMessage,
      timedOut,
      cancelled,
      stderrTail,
      events,
      startedAt,
      endedAt: Date.now(),
    });
  };

  const handleEvent = (event: RunEvent): void => {
    events.push(event);
    if (event.type === 'session' && typeof event.sessionId === 'string') sessionId = event.sessionId;
    if (event.type === 'final' && typeof event.text === 'string') finalText = event.text;
    if (event.type === 'error' && typeof event.message === 'string') errorMessage = event.message;
    input.onEvent?.(event);
  };

  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    killTree(child.pid ?? null);
    scheduleGraceFinish();
  }, Math.max(1_000, input.timeoutMs));

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    for (const event of parser.push(chunk)) handleEvent(event);
  });

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
  });

  child.on('error', (error) => {
    errorMessage ??= error.message;
    finish(null, null);
  });

  child.on('close', (code, signal) => {
    for (const event of parser.flush()) handleEvent(event);
    finish(code ?? null, signal);
  });

  function scheduleGraceFinish(): void {
    if (settled || graceTimer) return;
    graceTimer = setTimeout(() => finish(null, null), KILL_GRACE_MS);
    graceTimer.unref?.();
  }

  return {
    pid: child.pid ?? null,
    cancel: () => {
      cancelled = true;
      killTree(child.pid ?? null);
      scheduleGraceFinish();
    },
    outcome,
  };
}

/** 杀掉整个进程树；Windows 用 taskkill /T /F，其它平台对进程组发 SIGKILL。 */
export function killTree(pid: number | null): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.on('error', () => {
      /* taskkill 不可用时忽略：子进程可能已自行退出 */
    });
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* 进程已退出 */
  }
}
