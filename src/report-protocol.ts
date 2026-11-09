import { sliceUtf8 } from './event-summary.js';

export const DECISION_MARKER = '[DSH:NEEDS_DECISION]';
export const DECISION_REQUEST_MAX_BYTES = 4_096;

/** 每次 dsh_run 追加的固定页脚（幂等：任务文本已包含则不再追加）。 */
export const REPORT_PROTOCOL_FOOTER = [
  '---',
  '[汇报协议] 遇到任务文本中 [待你判断] 列出的分支、或任何需要业务取舍的决定时：停止执行，不要猜；最终回复以单独一行 `[DSH:NEEDS_DECISION]` 开头，其后逐条列出问题与可选方案。其余情况正常完成，不要输出该标记。',
].join('\n');

/** 注入汇报协议页脚；续聊/重复注入时保持幂等。 */
export function injectReportProtocol(task: string): string {
  if (task.includes(DECISION_MARKER) || task.includes('[汇报协议]')) return task;
  return `${task.replace(/\s+$/, '')}\n\n${REPORT_PROTOCOL_FOOTER}`;
}

/**
 * 从最终消息中检测决策请求：
 * - 标记必须是独立一行（允许前后空白），且不能在 ``` / ~~~ 代码块内；
 * - 命中返回 needs_decision + 标记之后的文本（≤ 4 KiB）；
 * - 未命中返回 completed。
 */
export function detectDecisionRequest(finalText: string | null): {
  outcome: 'completed' | 'needs_decision';
  decisionRequest: string | null;
} {
  if (!finalText) return { outcome: 'completed', decisionRequest: null };
  const lines = finalText.split(/\r?\n/);
  let inFence = false;
  let markerIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && line.trim() === DECISION_MARKER) {
      markerIndex = index;
      break;
    }
  }
  if (markerIndex < 0) return { outcome: 'completed', decisionRequest: null };
  const rest = lines.slice(markerIndex + 1).join('\n').trim();
  return { outcome: 'needs_decision', decisionRequest: sliceUtf8(rest, DECISION_REQUEST_MAX_BYTES).text || null };
}
