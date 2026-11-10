import type { TokenUsage } from './types.js';

/**
 * DeepSeek 单价（美元 / 百万 token），仅供费用估算。
 * 合并自本机 Codex 在用的 dsh-mcp bridge v2.2.0（`dsh_usage` / 成本记账）。
 */
export interface PricingConfig {
  inputPerMTok: number;
  cacheReadPerMTok: number;
  outputPerMTok: number;
  /** 美元兑人民币汇率（仅用于展示估算值）。 */
  usdCny: number;
}

/** 默认单价与汇率，均可用 DSH_MCP_PRICE_* / DSH_MCP_USD_CNY 覆盖。 */
export const DEFAULT_PRICING: PricingConfig = {
  inputPerMTok: 0.28,
  cacheReadPerMTok: 0.028,
  outputPerMTok: 0.42,
  usdCny: 6.65,
};

export interface CostEstimate {
  input_usd: number;
  cache_read_usd: number;
  output_usd: number;
  usd: number;
  cny: number;
}

/**
 * 按 token 用量估算费用。cacheWrite/reasoning 不计价（DeepSeek 计费口径里已含在
 * input/output 内，重复计费会高估）。
 */
export function estimateCost(
  tokens: TokenUsage | null | undefined,
  pricing: PricingConfig = DEFAULT_PRICING,
): CostEstimate | null {
  if (!tokens) return null;
  const input = (tokens.inputTokens / 1_000_000) * pricing.inputPerMTok;
  const cacheRead = (tokens.cacheReadTokens / 1_000_000) * pricing.cacheReadPerMTok;
  const output = (tokens.outputTokens / 1_000_000) * pricing.outputPerMTok;
  const usd = input + cacheRead + output;
  return {
    input_usd: input,
    cache_read_usd: cacheRead,
    output_usd: output,
    usd,
    cny: usd * pricing.usdCny,
  };
}

/** 便于 leader 理解「费用按什么单价算」。 */
export function pricingView(pricing: PricingConfig): Record<string, number> {
  return {
    input_per_mtok: pricing.inputPerMTok,
    cache_read_per_mtok: pricing.cacheReadPerMTok,
    output_per_mtok: pricing.outputPerMTok,
    usd_cny: pricing.usdCny,
  };
}
