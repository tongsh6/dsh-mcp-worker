// 假 DSH SDK 运行时：实现 initialize / session/prompt / shutdown 与 session.event 通知，
// 供 sdk 后端单测使用（不启动真实 DSH）。
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const log = (message) => {
  if (process.env.FAKE_SDK_LOG) appendFileSync(process.env.FAKE_SDK_LOG, `${message}\n`);
};
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
const event = (sessionId, ev) => notify('session.event', { sessionId, event: ev });

let promptSeq = 0;
const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  const { id, method, params } = message;
  if (method === 'initialize') {
    log('initialize');
    send({ jsonrpc: '2.0', id, result: { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } } });
    notify('session.status', { sessionId: 'boot', status: 'idle' });
    return;
  }
  if (method === 'session/prompt') {
    log('session/prompt');
    const { sessionId } = params;
    if (process.env.FAKE_SDK_REJECT_SESSION && sessionId === process.env.FAKE_SDK_REJECT_SESSION) {
      // 模拟 DSH 新后端无法恢复持久化 session
      send({ jsonrpc: '2.0', id, error: { code: -32000, message: `session "${sessionId}" already exists` } });
      return;
    }
    const text = (params.contentBlocks ?? []).map((block) => block.text ?? '').join('');
    promptSeq += 1;
    send({ jsonrpc: '2.0', id, result: { messageId: `m-${promptSeq}` } });
    setTimeout(() => {
      if (text.includes('HANG')) return;
      if (text.includes('FAIL')) {
        event(sessionId, { type: 'turn/end', data: { reason: 'error' } });
        return;
      }
      const messages = text.includes('MULTI') ? ['part-1', 'part-2'] : [`fake:${text}`];
      for (const content of messages) {
        event(sessionId, {
          type: 'assistant/message',
          data: {
            message: { content: [{ type: 'text', text: content }] },
            usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
          },
        });
      }
      event(sessionId, { type: 'turn/end', data: { reason: 'completed' } });
    }, 10);
    return;
  }
  if (method === 'shutdown') {
    log('shutdown');
    send({ jsonrpc: '2.0', id, result: {} });
    setTimeout(() => process.exit(0), 5);
    return;
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method: ${method}` } });
});

process.stdin.on('close', () => process.exit(0));
