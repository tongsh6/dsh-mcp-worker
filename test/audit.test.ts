import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/audit.js';

const cleanup: Array<() => Promise<void>> = [];

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'audit-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const log = new AuditLog(dir);
  await log.init();
  return { dir, log };
}

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn().catch(() => undefined);
});

describe('AuditLog', () => {
  it('append 后可按时间顺序读取', async () => {
    const { log } = await setup();
    await log.append({ ts: 1, event: 'task_created', task_id: 'a' });
    await log.append({ ts: 2, event: 'task_started', task_id: 'a' });
    const entries = await log.read(10);
    expect(entries.map((entry) => entry.event)).toEqual(['task_created', 'task_started']);
  });

  it('limit 只返回最近 N 条', async () => {
    const { log } = await setup();
    for (let index = 0; index < 10; index += 1) {
      await log.append({ ts: index, event: `e${index}` });
    }
    const entries = await log.read(3);
    expect(entries.map((entry) => entry.event)).toEqual(['e7', 'e8', 'e9']);
  });

  it('忽略损坏行与空文件', async () => {
    const { dir, log } = await setup();
    await writeFile(join(dir, 'audit.jsonl'), 'not-json\n{"event":"ok","ts":1}\n', 'utf8');
    const entries = await log.read(10);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.event).toBe('ok');
    expect(await new AuditLog(join(dir, 'missing')).read(5)).toEqual([]);
  });
});
