import type { RunEvent, TokenUsage } from './types.js';

export function emptyTokenUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
}

export function addTokenUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

/**
 * 从 DSH 运行事件里提取 token 用量：
 * - headless `--json`：`{type:'status', phase:'step_end', usage:{...}}`
 * - sdk 后端：我们映射的 step_end 事件同样携带原始 assistant/message usage
 * 兼容 camelCase（DSH）与 snake_case（上游 API）两种命名。
 */
export function extractTokenUsage(event: RunEvent): TokenUsage | null {
  const container = event as Record<string, unknown>;
  const data = container.data as Record<string, unknown> | undefined;
  const raw = (container.usage ?? data?.usage) as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object') return null;

  const pick = (...keys: string[]): number | null => {
    for (const key of keys) {
      const value = raw[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return null;
  };

  const input = pick('inputTokens', 'input_tokens');
  const output = pick('outputTokens', 'output_tokens');
  const cacheRead = pick('cacheReadTokens', 'cache_read_input_tokens', 'cachedInputTokens', 'cached_input_tokens');
  const cacheWrite = pick('cacheWriteTokens', 'cache_creation_input_tokens', 'cacheWriteInputTokens', 'cache_write_input_tokens');
  const reasoning = pick('reasoningTokens', 'reasoning_output_tokens');
  const total = pick('totalTokens', 'total_tokens');

  if ([input, output, cacheRead, cacheWrite, reasoning, total].every((value) => value === null)) return null;

  const normalized: TokenUsage = {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    cacheReadTokens: cacheRead ?? 0,
    cacheWriteTokens: cacheWrite ?? 0,
    reasoningTokens: reasoning ?? 0,
    totalTokens: 0,
  };
  normalized.totalTokens = total ?? normalized.inputTokens + normalized.outputTokens;
  return normalized;
}
