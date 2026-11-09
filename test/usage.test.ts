import { describe, expect, it } from 'vitest';
import { addTokenUsage, emptyTokenUsage, extractTokenUsage } from '../src/usage.js';

describe('extractTokenUsage', () => {
  it('读取 headless step_end 的 camelCase usage', () => {
    const usage = extractTokenUsage({
      type: 'status',
      phase: 'step_end',
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWriteTokens: 40,
        reasoningTokens: 5,
        totalTokens: 120,
      },
    });
    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 40,
      reasoningTokens: 5,
      totalTokens: 120,
    });
  });

  it('读取嵌套 data.usage 的 snake_case（SDK 原始事件）', () => {
    const usage = extractTokenUsage({
      type: 'status',
      phase: 'step_end',
      data: {
        usage: {
          input_tokens: 7,
          output_tokens: 3,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 2,
          reasoning_output_tokens: 1,
        },
      },
    });
    expect(usage).toMatchObject({ inputTokens: 7, outputTokens: 3, cacheReadTokens: 10, cacheWriteTokens: 2, reasoningTokens: 1 });
    expect(usage?.totalTokens).toBe(10);
  });

  it('没有 usage 或无法识别时返回 null', () => {
    expect(extractTokenUsage({ type: 'text', text: 'hi' })).toBeNull();
    expect(extractTokenUsage({ type: 'status', usage: {} })).toBeNull();
    expect(extractTokenUsage({ type: 'status', usage: { foo: 1 } })).toBeNull();
  });

  it('addTokenUsage 逐项累加', () => {
    const sum = addTokenUsage(
      { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, reasoningTokens: 5, totalTokens: 3 },
      { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, reasoningTokens: 50, totalTokens: 30 },
    );
    expect(sum).toEqual({
      inputTokens: 11,
      outputTokens: 22,
      cacheReadTokens: 33,
      cacheWriteTokens: 44,
      reasoningTokens: 55,
      totalTokens: 33,
    });
    expect(emptyTokenUsage().totalTokens).toBe(0);
  });
});
