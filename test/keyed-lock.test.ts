import { describe, expect, it } from 'vitest';
import { KeyedLock } from '../src/keyed-lock.js';

describe('KeyedLock', () => {
  it('同一 key 串行执行', async () => {
    const lock = new KeyedLock();
    const order: string[] = [];
    const first = lock.runExclusive('s1', async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 30));
      order.push('a-end');
    });
    const second = lock.runExclusive('s1', async () => {
      order.push('b-start');
      order.push('b-end');
    });
    await Promise.all([first, second]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('不同 key 并行执行', async () => {
    const lock = new KeyedLock();
    const order: string[] = [];
    const a = lock.runExclusive('a', async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 30));
      order.push('a-end');
    });
    const b = lock.runExclusive('b', async () => {
      order.push('b-start');
      order.push('b-end');
    });
    await Promise.all([a, b]);
    expect(order).toEqual(['a-start', 'b-start', 'b-end', 'a-end']);
  });

  it('busy 状态在释放后清空', async () => {
    const lock = new KeyedLock();
    const task = lock.runExclusive('k', async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(lock.isBusy('k')).toBe(true);
    await task;
    expect(lock.isBusy('k')).toBe(false);
    expect(lock.busyKeys()).toEqual([]);
  });

  it('前一个任务抛错不会阻塞后续任务', async () => {
    const lock = new KeyedLock();
    await expect(lock.runExclusive('k', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(lock.runExclusive('k', async () => 'ok')).resolves.toBe('ok');
  });
});
