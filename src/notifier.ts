import { spawn } from 'node:child_process';

export interface NotifyEvent {
  event: string;
  task_id?: string;
  status?: string;
  cwd?: string;
  session_id?: string;
  detail?: string;
}

/**
 * 任务完成通知：MCP 无法主动唤醒空闲 leader，所以用外部通道（webhook / 命令）补通知。
 * fire-and-forget，失败不影响任务与审计。
 */
export class Notifier {
  constructor(private readonly options: { webhook?: string; cmd?: string; timeoutMs?: number }) {}

  get enabled(): boolean {
    return Boolean(this.options.webhook || this.options.cmd);
  }

  async notify(event: NotifyEvent): Promise<void> {
    const payload = { ...event, ts: Date.now() };
    if (this.options.webhook) {
      try {
        await fetch(this.options.webhook, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 3_000),
        });
      } catch {
        // 通知失败不影响任务
      }
    }
    if (this.options.cmd) {
      try {
        const child = spawn(this.options.cmd, {
          shell: true,
          windowsHide: true,
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, DSH_MCP_NOTIFY_JSON: JSON.stringify(payload) },
        });
        child.unref();
      } catch {
        // 通知失败不影响任务
      }
    }
  }
}
