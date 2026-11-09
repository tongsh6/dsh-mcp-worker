import { describe, expect, it } from 'vitest';
import {
  DECISION_MARKER,
  DECISION_REQUEST_MAX_BYTES,
  REPORT_PROTOCOL_FOOTER,
  detectDecisionRequest,
  injectReportProtocol,
} from '../src/report-protocol.js';

describe('report-protocol：页脚注入与决策标记检测', () => {
  it('注入一次，重复注入不追加', () => {
    const once = injectReportProtocol('做件事');
    expect(once).toContain(REPORT_PROTOCOL_FOOTER);
    expect(injectReportProtocol(once)).toBe(once);
    expect(once.split('[汇报协议]')).toHaveLength(2);
  });

  it('检测独立一行的标记（允许前后空白）', () => {
    const result = detectDecisionRequest(`先说明\n  ${DECISION_MARKER}  \n选 A 还是 B？\n影响：...`);
    expect(result.outcome).toBe('needs_decision');
    expect(result.decisionRequest).toContain('选 A 还是 B');
  });

  it('代码块内的标记不命中', () => {
    const result = detectDecisionRequest(['```', DECISION_MARKER, '```'].join('\n'));
    expect(result).toEqual({ outcome: 'completed', decisionRequest: null });
  });

  it('无标记 → completed', () => {
    expect(detectDecisionRequest('全部完成')).toEqual({ outcome: 'completed', decisionRequest: null });
    expect(detectDecisionRequest(null)).toEqual({ outcome: 'completed', decisionRequest: null });
  });

  it('decision_request 截断到 4 KiB', () => {
    const result = detectDecisionRequest(`${DECISION_MARKER}\n${'问'.repeat(5_000)}`);
    expect(Buffer.byteLength(result.decisionRequest ?? '', 'utf8')).toBeLessThanOrEqual(DECISION_REQUEST_MAX_BYTES);
  });
});
