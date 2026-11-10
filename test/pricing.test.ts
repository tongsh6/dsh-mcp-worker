import { describe, expect, it } from 'vitest';
import { DEFAULT_PRICING, estimateCost, pricingView } from '../src/pricing.js';
import type { TokenUsage } from '../src/types.js';

const million: TokenUsage = {
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  cacheReadTokens: 1_000_000,
  cacheWriteTokens: 500_000,
  reasoningTokens: 0,
  totalTokens: 2_000_000,
};

describe('estimateCost', () => {
  it('按 input/cacheRead/output 三项计算美元与人民币', () => {
    const cost = estimateCost(million, { inputPerMTok: 1, cacheReadPerMTok: 0.1, outputPerMTok: 2, usdCny: 7 });
    expect(cost).not.toBeNull();
    expect(cost!.input_usd).toBeCloseTo(1);
    expect(cost!.cache_read_usd).toBeCloseTo(0.1);
    expect(cost!.output_usd).toBeCloseTo(2);
    expect(cost!.usd).toBeCloseTo(3.1);
    expect(cost!.cny).toBeCloseTo(21.7);
  });

  it('cacheWrite/reasoning 不计价（避免重复计费）', () => {
    const onlyCacheWrite = estimateCost(
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 10_000_000,
        reasoningTokens: 10_000_000,
        totalTokens: 20_000_000,
      },
      { inputPerMTok: 1, cacheReadPerMTok: 1, outputPerMTok: 1, usdCny: 1 },
    );
    expect(onlyCacheWrite!.usd).toBe(0);
  });

  it('tokens 缺失返回 null', () => {
    expect(estimateCost(undefined)).toBeNull();
    expect(estimateCost(null)).toBeNull();
  });

  it('默认单价是 DeepSeek 估算价', () => {
    const cost = estimateCost(million);
    const expected =
      (1_000_000 / 1_000_000) * DEFAULT_PRICING.inputPerMTok +
      (1_000_000 / 1_000_000) * DEFAULT_PRICING.cacheReadPerMTok +
      (1_000_000 / 1_000_000) * DEFAULT_PRICING.outputPerMTok;
    expect(cost!.usd).toBeCloseTo(expected);
    expect(cost!.cny).toBeCloseTo(expected * DEFAULT_PRICING.usdCny);
  });

  it('pricingView 暴露费率口径', () => {
    expect(pricingView(DEFAULT_PRICING)).toEqual({
      input_per_mtok: DEFAULT_PRICING.inputPerMTok,
      cache_read_per_mtok: DEFAULT_PRICING.cacheReadPerMTok,
      output_per_mtok: DEFAULT_PRICING.outputPerMTok,
      usd_cny: DEFAULT_PRICING.usdCny,
    });
  });
});
