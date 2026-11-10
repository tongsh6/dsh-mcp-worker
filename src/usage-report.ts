import { DEFAULT_PRICING, estimateCost, pricingView, type PricingConfig } from './pricing.js';
import type { TaskRecord, TokenUsage } from './types.js';
import { isTerminalStatus } from './types.js';

export interface UsageReportOptions {
  days?: number;
  cwd?: string | null;
  now?: number;
  pricing?: PricingConfig;
}

export interface UsageReportUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  jobs_with_usage: number;
  /** 估算费用（美元）。 */
  cost_usd: number;
  /** 估算费用（人民币）。 */
  cost_cny: number;
}

export interface UsageReportCwdRow {
  cwd: string;
  jobs: number;
  duration_ms: number;
  tokens: number;
  cost_usd: number;
}

export interface UsageReport {
  generated_at: number;
  window_days: number;
  cwd_filter: string | null;
  jobs: number;
  by_state: Record<string, number>;
  avg_duration_ms: number | null;
  total_duration_ms: number;
  usage: UsageReportUsage | null;
  by_cwd: UsageReportCwdRow[];
  pricing: Record<string, number>;
}

/**
 * 用量与成本聚合（对应本机在用版 `dsh_usage`）：
 * 任务数 / 状态分布 / 耗时 / DSH token / 估算费用，并给出按 cwd 的 top 分布。
 * 数据源是 TaskManager 里的任务记录（含重启从磁盘恢复的任务）。
 */
export function buildUsageReport(tasks: TaskRecord[], options: UsageReportOptions = {}): UsageReport {
  const days = Math.max(1, Math.min(90, Math.trunc(options.days ?? 1)));
  const now = options.now ?? Date.now();
  const since = now - days * 86_400_000;
  const cwdFilter = options.cwd ?? null;
  const pricing = options.pricing ?? DEFAULT_PRICING;

  const rows = tasks.filter((task) => {
    const startedAt = task.startedAt ?? task.createdAt;
    if (startedAt < since) return false;
    if (cwdFilter !== null && task.cwd !== cwdFilter) return false;
    return true;
  });

  const byState: Record<string, number> = {};
  const byCwdMap = new Map<string, UsageReportCwdRow>();
  const usage: UsageReportUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 0,
    jobs_with_usage: 0,
    cost_usd: 0,
    cost_cny: 0,
  };
  let totalDuration = 0;
  let durationSamples = 0;

  for (const task of rows) {
    byState[task.status] = (byState[task.status] ?? 0) + 1;

    let durationMs = 0;
    if (task.startedAt !== undefined && task.endedAt !== undefined && isTerminalStatus(task.status)) {
      durationMs = Math.max(0, task.endedAt - task.startedAt);
      totalDuration += durationMs;
      durationSamples += 1;
    }

    const row = byCwdMap.get(task.cwd) ?? { cwd: task.cwd, jobs: 0, duration_ms: 0, tokens: 0, cost_usd: 0 };
    row.jobs += 1;
    row.duration_ms += durationMs;

    const tokens = task.usageTokens;
    if (tokens) {
      usage.jobs_with_usage += 1;
      usage.input_tokens += tokens.inputTokens;
      usage.output_tokens += tokens.outputTokens;
      usage.cache_read_tokens += tokens.cacheReadTokens;
      usage.cache_write_tokens += tokens.cacheWriteTokens;
      usage.reasoning_tokens += tokens.reasoningTokens;
      usage.total_tokens += tokens.totalTokens;
      row.tokens += tokens.totalTokens;
      const cost = estimateCost(tokens, pricing);
      if (cost) {
        usage.cost_usd += cost.usd;
        usage.cost_cny += cost.cny;
        row.cost_usd += cost.usd;
      }
    }
    byCwdMap.set(task.cwd, row);
  }

  const byCwd = [...byCwdMap.values()]
    .sort((left, right) => right.jobs - left.jobs || right.tokens - left.tokens)
    .slice(0, 10);

  return {
    generated_at: now,
    window_days: days,
    cwd_filter: cwdFilter,
    jobs: rows.length,
    by_state: byState,
    avg_duration_ms: durationSamples > 0 ? Math.round(totalDuration / durationSamples) : null,
    total_duration_ms: totalDuration,
    usage: usage.jobs_with_usage > 0 ? usage : null,
    by_cwd: byCwd,
    pricing: pricingView(pricing),
  };
}

/** 便捷函数：直接给单个任务的 token 用量算费用（dsh_result / dsh_metrics 共用）。 */
export function taskCost(tokens: TokenUsage | undefined, pricing: PricingConfig) {
  return estimateCost(tokens, pricing);
}
