import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkerError } from './errors.js';
import type { TaskCreateInput, TaskManager } from './task-manager.js';
import type { TaskStatus } from './types.js';

export interface BatchRecord {
  id: string;
  taskIds: string[];
  createdAt: number;
}

export interface BatchChildStatus {
  task_id: string;
  task: string;
  cwd: string;
  status: TaskStatus;
  phase: string;
  progress: number;
  error?: string | null;
}

export type BatchOverallStatus = 'queued' | 'running' | 'completed' | 'partial_failed' | 'all_failed' | 'cancelled';

export interface BatchStatusPayload {
  batch_id: string;
  status: BatchOverallStatus;
  created_at: number;
  counts: Record<TaskStatus, number>;
  children: BatchChildStatus[];
}

export interface BatchResultItem {
  task_id: string;
  status: TaskStatus;
  output: string | null;
  error: string | null;
  wall_ms: number | null;
  events_count: number | null;
}

export interface BatchResultPayload {
  batch_id: string;
  status: BatchOverallStatus;
  results: BatchItemResult[];
}

type BatchItemResult = BatchResultItem;

/**
 * 批量任务（fan-out）：一次提交多个独立任务（不同 cwd / session / 权限模式），
 * 复用 TaskManager 的并发配额与排队，聚合查询状态/结果。
 * 批量元数据落在 batchDir（JSON），任务本体仍由 TaskManager 管理。
 */
export class BatchManager {
  constructor(
    private readonly manager: TaskManager,
    private readonly dir: string,
    private readonly maxTasks = 8,
  ) {}

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async create(inputs: TaskCreateInput[]): Promise<BatchRecord> {
    if (inputs.length === 0) throw new WorkerError('bad_request', '批量任务不能为空');
    if (inputs.length > this.maxTasks) {
      throw new WorkerError('bad_request', `单次批量最多 ${this.maxTasks} 个任务（当前 ${inputs.length}）`);
    }
    const taskIds: string[] = [];
    for (const input of inputs) {
      const record = await this.manager.create(input);
      taskIds.push(record.id);
    }
    const batch: BatchRecord = { id: randomUUID(), taskIds, createdAt: Date.now() };
    await this.persist(batch);
    this.manager.audit({ event: 'batch_created', detail: `${batch.id}: ${taskIds.length} tasks` });
    return batch;
  }

  async status(batchId: string): Promise<BatchStatusPayload> {
    const batch = await this.load(batchId);
    const counts: Record<TaskStatus, number> = { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 };
    const children = batch.taskIds.map((taskId) => this.childStatus(taskId, counts));
    return {
      batch_id: batch.id,
      status: aggregate(children),
      created_at: batch.createdAt,
      counts,
      children,
    };
  }

  async result(batchId: string): Promise<BatchResultPayload> {
    const batch = await this.load(batchId);
    const items: BatchResultItem[] = [];
    const counts: Record<TaskStatus, number> = { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 };
    for (const taskId of batch.taskIds) {
      const record = this.manager.get(taskId);
      if (!record) {
        counts.failed += 1;
        items.push({
          task_id: taskId,
          status: 'failed',
          output: null,
          error: '任务已被清理（超过 TTL 或数量上限）',
          wall_ms: null,
          events_count: null,
        });
        continue;
      }
      counts[record.status] += 1;
      if (record.status === 'succeeded' || record.status === 'failed' || record.status === 'cancelled') {
        try {
          const result = await this.manager.result(taskId);
          items.push({
            task_id: taskId,
            status: result.status,
            output: result.output,
            error: result.error,
            wall_ms: result.usage.wall_ms,
            events_count: result.events_count,
          });
          continue;
        } catch {
          // 落到下面的「未结束」分支
        }
      }
      items.push({
        task_id: taskId,
        status: record.status,
        output: null,
        error: '任务尚未结束',
        wall_ms: null,
        events_count: null,
      });
    }
    const children = batch.taskIds.map((taskId) => this.childStatus(taskId));
    return { batch_id: batch.id, status: aggregate(children), results: items };
  }

  async cancel(batchId: string): Promise<{ batch_id: string; cancelled: string[] }> {
    const batch = await this.load(batchId);
    const cancelled: string[] = [];
    for (const taskId of batch.taskIds) {
      const record = this.manager.get(taskId);
      if (!record) continue;
      if (record.status === 'succeeded' || record.status === 'failed' || record.status === 'cancelled') continue;
      const result = await this.manager.cancel(taskId);
      if (result.cancelled) cancelled.push(taskId);
    }
    return { batch_id: batch.id, cancelled };
  }

  private childStatus(taskId: string, counts?: Record<TaskStatus, number>): BatchChildStatus {
    const record = this.manager.get(taskId);
    if (!record) {
      if (counts) counts.failed += 1;
      return {
        task_id: taskId,
        task: '(已清理)',
        cwd: '',
        status: 'failed',
        phase: 'cleaned',
        progress: 0,
        error: '任务已被清理',
      };
    }
    if (counts) counts[record.status] += 1;
    return {
      task_id: record.id,
      task: record.task,
      cwd: record.cwd,
      status: record.status,
      phase: record.status === 'running' ? 'running' : record.status,
      progress: record.events.filter((event) => event.type === 'status' && event.phase === 'step_end').length,
      error: record.error ?? null,
    };
  }

  private async persist(batch: BatchRecord): Promise<void> {
    await writeFile(join(this.dir, `${batch.id}.json`), JSON.stringify(batch), 'utf8');
  }

  private async load(batchId: string): Promise<BatchRecord> {
    try {
      const raw = await readFile(join(this.dir, `${batchId}.json`), 'utf8');
      const parsed = JSON.parse(raw) as BatchRecord;
      if (typeof parsed?.id !== 'string' || !Array.isArray(parsed.taskIds)) throw new Error('bad batch');
      return parsed;
    } catch {
      throw new WorkerError('task_not_found', `批量不存在：${batchId}`);
    }
  }
}

function aggregate(children: BatchChildStatus[]): BatchOverallStatus {
  if (children.length === 0) return 'queued';
  const statuses = children.map((child) => child.status);
  const queued = statuses.filter((status) => status === 'queued').length;
  const running = statuses.filter((status) => status === 'running').length;
  const succeeded = statuses.filter((status) => status === 'succeeded').length;
  const failed = statuses.filter((status) => status === 'failed').length;
  const cancelled = statuses.filter((status) => status === 'cancelled').length;

  if (queued === statuses.length) return 'queued';
  if (queued > 0 || running > 0) return 'running';
  if (succeeded === statuses.length) return 'completed';
  if (cancelled === statuses.length) return 'cancelled';
  if (failed === statuses.length) return 'all_failed';
  return 'partial_failed';
}
