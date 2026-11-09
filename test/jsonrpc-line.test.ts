import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { JsonRpcLineClient } from '../src/jsonrpc-line.js';

function makePair() {
  const clientInput = new PassThrough();
  const clientOutput = new PassThrough();
  const client = new JsonRpcLineClient(clientInput, clientOutput);
  const sent: Array<Record<string, unknown>> = [];
  clientOutput.setEncoding('utf8');
  clientOutput.on('data', (chunk: string) => {
    for (const line of chunk.split('\n').filter(Boolean)) sent.push(JSON.parse(line) as Record<string, unknown>);
  });
  const reply = (message: Record<string, unknown>) => clientInput.write(`${JSON.stringify(message)}\n`);
  return { client, clientInput, clientOutput, sent, reply };
}

describe('JsonRpcLineClient', () => {
  it('请求/响应关联', async () => {
    const { client, sent, reply } = makePair();
    const promise = client.request('initialize', { cwd: 'C:\\p' });
    expect(sent[0]).toMatchObject({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { cwd: 'C:\\p' } });
    reply({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'x' } } });
    await expect(promise).resolves.toEqual({ serverInfo: { name: 'x' } });
  });

  it('JSON-RPC 错误响应 reject 并带 code', async () => {
    const { client, reply } = makePair();
    const promise = client.request('session/prompt', {});
    reply({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'boom' } });
    await expect(promise).rejects.toMatchObject({ code: -32603, message: expect.stringContaining('boom') });
  });

  it('通知分发（支持跨 chunk 的半行）', async () => {
    const { client, clientInput } = makePair();
    const events: unknown[] = [];
    client.onNotification('session.event', (params) => events.push(params));
    const line = JSON.stringify({ jsonrpc: '2.0', method: 'session.event', params: { sessionId: 's1' } });
    clientInput.write(line.slice(0, 10));
    clientInput.write(`${line.slice(10)}\n`);
    expect(events).toEqual([{ sessionId: 's1' }]);
  });

  it('超时会 reject', async () => {
    const { client } = makePair();
    await expect(client.request('slow', {}, 30)).rejects.toThrow(/超时/);
  });

  it('close 会拒绝所有挂起请求', async () => {
    const { client } = makePair();
    const promise = client.request('hang', {});
    client.close(new Error('已关闭'));
    await expect(promise).rejects.toThrow('已关闭');
  });
});
