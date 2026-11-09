import type { TaskRecord } from './types.js';

/** DSH/沙箱在无人值守时因缺少审批通道而拒绝的典型文案。 */
const APPROVAL_PATTERNS: RegExp[] = [
  /requires approval/i,
  /approval channel is not available/i,
  /no approval channel/i,
  /approval(?: is)? unavailable/i,
  /需要审批/,
  /审批(?:通道)?不可用/,
  /requires? permission/i,
];

/**
 * 判断一个失败任务是否是「被审批卡住」而非真实执行错误。
 * 用于 dsh_result 里的审批桥：客户端支持 elicitation 时询问用户是否授权重试。
 */
export function detectApprovalRequired(record: TaskRecord): boolean {
  const texts: string[] = [];
  if (record.error) texts.push(record.error);
  if (record.finalText) texts.push(record.finalText);
  for (const event of record.events) {
    if (event.type === 'tool_result') texts.push(stringify(event.result));
    if (event.type === 'error') texts.push(String(event.message ?? ''));
  }
  return texts.some((text) => APPROVAL_PATTERNS.some((pattern) => pattern.test(text)));
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}
