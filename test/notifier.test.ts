import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { Notifier } from '../src/notifier.js';

describe('Notifier', () => {
  it('webhook 收到 POST JSON', async () => {
    const received: Array<Record<string, unknown>> = [];
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        try {
          received.push(JSON.parse(body));
        } catch {
          received.push({ bad: true });
        }
        response.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      const notifier = new Notifier({ webhook: `http://127.0.0.1:${port}/notify` });
      await notifier.notify({ event: 'task_succeeded', task_id: 't1', status: 'succeeded', cwd: 'C:\\proj' });
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ event: 'task_succeeded', task_id: 't1', status: 'succeeded' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('未配置时 enabled=false 且 notify 不抛错', async () => {
    const notifier = new Notifier({});
    expect(notifier.enabled).toBe(false);
    await expect(notifier.notify({ event: 'x' })).resolves.toBeUndefined();
  });
});
