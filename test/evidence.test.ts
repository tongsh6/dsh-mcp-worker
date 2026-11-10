import { describe, expect, it } from 'vitest';
import { extractEvidence, normalizeToolEvents, parseCommandExit } from '../src/evidence.js';
import type { RunEvent } from '../src/types.js';

const sdkCall = (callId: string, name: string, args: Record<string, unknown>): RunEvent => ({
  type: 'tool_call',
  tool: name,
  call_id: callId,
  arguments: args,
});

const sdkResult = (callId: string, text: string, isError = false): RunEvent => ({
  type: 'tool_result',
  call_id: callId,
  message: { role: 'tool', toolCallId: callId, isError, content: [{ type: 'text', text }] },
});

describe('evidence：工具事件归一化与退出码', () => {
  it('sdk 形态配对并解析 [exit code: N]', () => {
    const events = [
      sdkCall('c1', 'pwsh', { command: 'pwsh -c "exit 3"', workdir: 'D:\\proj' }),
      sdkResult('c1', 'out\n[exit code: 3]'),
      sdkCall('c2', 'pwsh', { command: 'git status' }),
      sdkResult('c2', 'clean'),
    ];
    const evidence = extractEvidence(events);
    expect(evidence.commands).toHaveLength(2);
    expect(evidence.commands[0]).toMatchObject({
      tool: 'pwsh',
      command: 'pwsh -c "exit 3"',
      workdir: 'D:\\proj',
      exit_code: 3,
      is_error: false,
    });
    expect(evidence.commands[0]?.markers).toContain('[exit code: 3]');
    expect(evidence.commands[1]?.exit_code).toBe(0);
    expect(evidence.summary).toMatchObject({ commands_failed: 1, last_command_exit_code: 0 });
  });

  it('headless 形态（callId/tool/input + callId/status/result）同样解析', () => {
    const events: RunEvent[] = [
      { type: 'tool_call', callId: 'h1', tool: 'pwsh', input: { command: 'echo ok' } },
      { type: 'tool_result', callId: 'h1', status: 'completed', result: 'ok' },
    ];
    const evidence = extractEvidence(events);
    expect(evidence.commands[0]).toMatchObject({ tool: 'pwsh', command: 'echo ok', exit_code: 0 });
  });

  it('退出码解析：NO marker/isError/killed/timed/sandbox 均按契约退化', () => {
    expect(parseCommandExit('done', false)).toEqual({ exitCode: 0, markers: [] });
    expect(parseCommandExit('boom', true)).toEqual({ exitCode: null, markers: [] });
    expect(parseCommandExit('x\n[exit code: 2]', false)).toEqual({ exitCode: 2, markers: ['[exit code: 2]'] });
    expect(parseCommandExit('[killed by signal: SIGTERM]', false).exitCode).toBeNull();
    expect(parseCommandExit('[timed out after 100ms]', false).markers[0]).toContain('timed out');
    expect(parseCommandExit('[sandbox: file access denied under read-only mode]', false).exitCode).toBeNull();
    expect(parseCommandExit('[stopped: 用户取消]', false).exitCode).toBeNull();
    expect(parseCommandExit('[exit code: 7]', true).exitCode).toBe(7);
  });

  it('配不上对的 tool_call 记 [no result]', () => {
    const evidence = extractEvidence([sdkCall('miss', 'pwsh', { command: 'ls' })]);
    expect(evidence.commands[0]).toMatchObject({ exit_code: null, markers: ['[no result]'] });
  });

  it('命令超过 500 字节截断并标记', () => {
    const command = 'x'.repeat(2_000);
    const evidence = extractEvidence([sdkCall('c1', 'bash', { command }), sdkResult('c1', 'ok')]);
    expect(evidence.commands[0]?.command_truncated).toBe(true);
    expect(Buffer.byteLength(evidence.commands[0]?.command ?? '', 'utf8')).toBeLessThanOrEqual(500);
  });

  it('60 条命令保留前 10 + 失败全部 + 后 10，并标记截断', () => {
    const events: RunEvent[] = [];
    for (let index = 0; index < 60; index += 1) {
      const id = `c${index}`;
      events.push(sdkCall(id, 'pwsh', { command: `cmd-${index}` }));
      events.push(sdkResult(id, index === 30 ? '[exit code: 1]' : 'ok'));
    }
    const evidence = extractEvidence(events);
    expect(evidence.commands_total).toBe(60);
    expect(evidence.commands_truncated).toBe(true);
    expect(evidence.commands).toHaveLength(21);
    expect(evidence.commands.some((command) => command.command === 'cmd-30' && command.exit_code === 1)).toBe(true);
    expect(evidence.commands[0]?.command).toBe('cmd-0');
    expect(evidence.commands[evidence.commands.length - 1]?.command).toBe('cmd-59');
  });

  it('str_replace_editor 按 path 聚合 ops 与 errors', () => {    const events: RunEvent[] = [
      sdkCall('e1', 'str_replace_editor', { command: 'create', path: 'a.txt' }),
      sdkResult('e1', 'ok'),
      sdkCall('e2', 'str_replace_editor', { command: 'str_replace', path: 'a.txt' }),
      sdkResult('e2', 'ok'),
      sdkCall('e3', 'str_replace_editor', { command: 'insert', path: 'a.txt' }),
      sdkResult('e3', 'bad', true),
    ];
    const evidence = extractEvidence(events);
    expect(evidence.edits).toEqual([{ path: 'a.txt', ops: { create: 1, str_replace: 1, insert: 1 }, errors: 1 }]);
    expect(evidence.summary.edits_failed).toBe(1);
  });

  it('write / edit 工具按 file_path 聚合（真实 DSH 形态）', () => {
    const events: RunEvent[] = [
      sdkCall('w1', 'write', { file_path: 'a.txt', content: 'x' }),
      sdkResult('w1', 'ok'),
      sdkCall('e1', 'edit', { file_path: 'a.txt' }),
      sdkResult('e1', 'ok'),
      sdkCall('w2', 'write', { file_path: 'a.txt', content: 'y' }),
      sdkResult('w2', 'bad', true),
    ];
    const evidence = extractEvidence(events);
    expect(evidence.edits).toEqual([{ path: 'a.txt', ops: { write: 2, edit: 1 }, errors: 1 }]);
    expect(evidence.summary.edits_failed).toBe(1);
  });

  it('normalizeToolEvents 暴露配对结果', () => {
    const { calls, results } = normalizeToolEvents([sdkCall('c1', 'pwsh', { command: 'x' }), sdkResult('c1', 'ok')]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.result?.text).toBe('ok');
    expect(results.get('c1')?.isError).toBe(false);
  });
});
