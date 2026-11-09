import type { RunEvent } from './types.js';

/** 单条事件摘要的 UTF-8 字节上限（含 seq 等摘要字段前的预算余量）。 */
export const EVENT_SUMMARY_MAX_BYTES = 2_048;

/** UTF-8 字节数（不依赖 string.length 的 UTF-16 计数）。 */
export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** 按 UTF-8 字节截断，且不切断多字节字符（不会产生 U+FFFD）。 */
export function sliceUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (maxBytes <= 0) return { text: '', truncated: value.length > 0 };
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return { text: value, truncated: false };
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true };
}

/**
 * 按「JSON.stringify 后的 UTF-8 字节数」截断字符串。
 * 用于 error 等直接进入响应 JSON 的字段：引号、反斜杠、换行转义后的膨胀也计入预算。
 */
export function sliceJsonString(value: string, maxJsonBytes: number): { text: string; truncated: boolean } {
  if (maxJsonBytes <= 2) return { text: '', truncated: value.length > 0 };
  if (utf8ByteLength(JSON.stringify(value)) <= maxJsonBytes) return { text: value, truncated: false };
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (utf8ByteLength(JSON.stringify(value.slice(0, mid))) <= maxJsonBytes) low = mid;
    else high = mid - 1;
  }
  if (low > 0 && low < value.length) {
    const code = value.charCodeAt(low - 1);
    if (code >= 0xd800 && code <= 0xdbff) low -= 1; // 不切断 UTF-16 代理对
  }
  return { text: value.slice(0, low), truncated: low < value.length };
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * 把单条 RunEvent 压成有界摘要：
 * - 未超限的事件原样返回；
 * - 超限时保留 type 与各字段（字符串/嵌套对象按预算截断），并标记 `truncated`/`original_bytes`；
 * - 字段过多或 JSON 转义膨胀时退化为「type + 原文前缀」的硬上限摘要。
 * 原始事件不受影响，仍由 store 完整落盘。
 */
export function summarizeEvent(event: RunEvent, maxBytes = EVENT_SUMMARY_MAX_BYTES): RunEvent {
  const raw = json(event);
  const originalBytes = utf8ByteLength(raw);
  if (originalBytes <= maxBytes) return event;

  const type = typeof event.type === 'string' ? event.type : 'unknown';
  const out: RunEvent = { type, truncated: true, original_bytes: originalBytes };
  for (const [key, value] of Object.entries(event)) {
    if (key === 'type') continue;
    if (value === null || typeof value === 'number' || typeof value === 'boolean') {
      const trial = { ...out, [key]: value };
      if (utf8ByteLength(json(trial)) <= maxBytes) out[key] = value;
      continue;
    }
    const candidate = typeof value === 'string' ? value : json(value);
    const room = Math.max(0, maxBytes - utf8ByteLength(json({ ...out, [key]: '' })) - 2);
    const slice = sliceUtf8(candidate, room);
    out[key] = slice.text;
    if (slice.truncated && utf8ByteLength(json(out)) >= maxBytes - 32) break;
  }

  if (utf8ByteLength(json(out)) <= maxBytes) return out;

  // 兜底：保证摘要本身绝不超限（即使原文含大量需转义字符）。
  const reserve = 128 + utf8ByteLength(type);
  let keep = Math.max(0, maxBytes - reserve);
  let summary = sliceUtf8(raw, keep).text;
  while (
    keep > 0 &&
    utf8ByteLength(json({ type, truncated: true, original_bytes: originalBytes, summary })) > maxBytes
  ) {
    keep = Math.floor(keep * 0.7);
    summary = sliceUtf8(raw, keep).text;
  }
  return { type, truncated: true, original_bytes: originalBytes, summary };
}
