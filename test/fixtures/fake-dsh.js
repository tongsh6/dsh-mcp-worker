#!/usr/bin/env node
// 假 DSH：按任务文本模拟 `dsh --profile headless --json` 的事件流，供单元测试使用。
// 支持：成功 / 失败（FAIL）/ 挂起（HANG，用于超时与取消测试）。
const args = process.argv.slice(2);
const task = args[args.length - 1] ?? '';
const sessionIdx = args.indexOf('--session-id');
const sessionId = sessionIdx >= 0 ? args[sessionIdx + 1] : 'sess-fake';

const emit = (ev) => process.stdout.write(`${JSON.stringify(ev)}\n`);

// 模拟 DSH 常驻的 Node 警告噪声，验证 runner 不会把 stderr 当成失败信号
process.stderr.write('[fake-dsh] (node:1) [UNDICI-EHPA] Warning: noise\n');
emit({ type: 'session', sessionId, cwd: process.cwd() });

setTimeout(() => {
  if (task.includes('HANG')) {
    setInterval(() => {}, 1000);
    return;
  }
  if (task.includes('FAIL')) {
    process.stderr.write('dsh: boom: simulated failure\n');
    emit({ type: 'error', message: 'simulated failure' });
    process.exit(1);
  }
  emit({ type: 'status', phase: 'turn_start', turn: 1 });
  emit({ type: 'status', phase: 'step_start', turn: 1, step: 1 });
  emit({ type: 'tool_call', callId: 'c1', tool: 'pwsh', input: {} });
  emit({ type: 'tool_result', callId: 'c1', status: 'completed', result: 'ok' });
  emit({ type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { totalTokens: 10 } });
  emit({ type: 'final', text: `ok:${task}` });
}, 10);
