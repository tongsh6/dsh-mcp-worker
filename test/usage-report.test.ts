import { describe, expect, it } from 'vitest';
import type { TaskRecord, TokenUsage } from '../src/types.js';
import { buildUsageReport } from '../src/usage-report.js';

const NOW = 10_000_000_000;

function tokenUsage(partial: Partial<TokenUsage>): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    ...partial,
  };
}

function makeTask(partial: Partial<TaskRecord>): TaskRecord {
  return {
    id: 'task',
    status: 'succeeded',
    task: 'do work',
    cwd: '/proj',
    permissionMode: 'workspace-write',
    createdAt: NOW - 1_000,
    timedOut: false,
    events: [],
    ...partial,
  };
}

const PRICING = { inputPerMTok: 1, cacheReadPerMTok: 0.1, outputPerMTok: 2, usdCny: 7 };

describe('buildUsageReport', () => {
  it('汇总窗口内的任务数/状态/耗时/token/费用', () => {
    const tasks = [
      makeTask({
        id: 'a',
        status: 'succeeded',
        createdAt: NOW - 1_000,
        startedAt: NOW - 1_000,
        endedAt: NOW - 500,
        usageTokens: tokenUsage({ inputTokens: 1_000_000, outputTokens: 500_000, totalTokens: 1_500_000 }),
      }),
      makeTask({ id: 'b', status: 'failed', createdAt: NOW - 2_000, startedAt: NOW - 2_000, endedAt: NOW - 1_500 }),
      // 窗口外
      makeTask({ id: 'c', status: 'succeeded', createdAt: NOW - 3 * 86_400_000, startedAt: NOW - 3 * 86_400_000, endedAt: NOW - 3 * 86_400_000 + 10 }),
    ];
    const report = buildUsageReport(tasks, { days: 1, now: NOW, pricing: PRICING });
    expect(report.jobs).toBe(2);
    expect(report.by_state).toEqual({ succeeded: 1, failed: 1 });
    expect(report.total_duration_ms).toBe(1_000);
    expect(report.avg_duration_ms).toBe(500);
    expect(report.usage).not.toBeNull();
    expect(report.usage!.jobs_with_usage).toBe(1);
    expect(report.usage!.input_tokens).toBe(1_000_000);
    expect(report.usage!.output_tokens).toBe(500_000);
    expect(report.usage!.total_tokens).toBe(1_500_000);
    // 1M input × $1/M + 0.5M output × $2/M = 1 + 1 = $2
    expect(report.usage!.cost_usd).toBeCloseTo(2);
    expect(report.usage!.cost_cny).toBeCloseTo(14);
    expect(report.by_cwd).toEqual([{ cwd: '/proj', jobs: 2, duration_ms: 1_000, tokens: 1_500_000, cost_usd: 2 }]);
  });

  it('按 cwd 过滤且提供 top 分布', () => {
    const tasks = [
      makeTask({ id: 'a', cwd: '/proj-a', createdAt: NOW - 1_000, startedAt: NOW - 1_000, endedAt: NOW - 900 }),
      makeTask({ id: 'b', cwd: '/proj-b', createdAt: NOW - 1_000, startedAt: NOW - 1_000, endedAt: NOW - 900 }),
      makeTask({ id: 'c', cwd: '/proj-a', createdAt: NOW - 1_000, startedAt: NOW - 1_000, endedAt: NOW - 900 }),
    ];
    const report = buildUsageReport(tasks, { days: 7, now: NOW, cwd: '/proj-a', pricing: PRICING });
    expect(report.jobs).toBe(2);
    expect(report.cwd_filter).toBe('/proj-a');
    expect(report.by_cwd).toHaveLength(1);
    expect(report.by_cwd[0]!.cwd).toBe('/proj-a');
    expect(report.by_cwd[0]!.jobs).toBe(2);
  });

  it('没有任何 token 用量时 usage 为 null', () => {
    const report = buildUsageReport([makeTask({ startedAt: NOW - 1_000, endedAt: NOW - 900 })], {
      days: 1,
      now: NOW,
      pricing: PRICING,
    });
    expect(report.usage).toBeNull();
    expect(report.pricing.input_per_mtok).toBe(1);
  });

  it('运行中的任务计入 token 但不算耗时', () => {
    const tasks = [
      makeTask({
        id: 'running',
        status: 'running',
        createdAt: NOW - 1_000,
        startedAt: NOW - 1_000,
        usageTokens: tokenUsage({ totalTokens: 42 }),
      }),
    ];
    const report = buildUsageReport(tasks, { days: 1, now: NOW, pricing: PRICING });
    expect(report.jobs).toBe(1);
    expect(report.usage!.total_tokens).toBe(42);
    expect(report.total_duration_ms).toBe(0);
    expect(report.avg_duration_ms).toBeNull();
  });
});
