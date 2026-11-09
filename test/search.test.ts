import { describe, expect, it } from 'vitest';
import { searchTasks } from '../src/search.js';
import type { TaskRecord } from '../src/types.js';

function makeTask(partial: Partial<TaskRecord>): TaskRecord {
  return {
    id: 't',
    status: 'succeeded',
    task: 'x',
    cwd: 'C:\\p',
    permissionMode: 'workspace-write',
    createdAt: 0,
    events: [],
    timedOut: false,
    ...partial,
  };
}

describe('searchTasks', () => {
  it('命中最终输出（大小写不敏感）', () => {
    const tasks = [makeTask({ id: 't1', finalText: 'TypeScript error TS2345 in utils.ts' })];
    const matches = searchTasks(tasks, 'ts2345');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ task_id: 't1', field: 'output' });
    expect(matches[0]?.snippet).toContain('TS2345');
  });

  it('命中工具结果事件', () => {
    const tasks = [
      makeTask({
        id: 't2',
        events: [{ type: 'tool_result', callId: 'c1', status: 'completed', result: 'all tests passed' }],
      }),
    ];
    const matches = searchTasks(tasks, 'tests passed');
    expect(matches[0]).toMatchObject({ task_id: 't2', field: 'event' });
  });

  it('空查询/无命中返回空数组', () => {
    const tasks = [makeTask({ finalText: 'hello' })];
    expect(searchTasks(tasks, '   ')).toEqual([]);
    expect(searchTasks(tasks, 'nope')).toEqual([]);
  });

  it('limit 生效', () => {
    const tasks = Array.from({ length: 10 }, (_, index) => makeTask({ id: `t${index}`, finalText: 'needle' }));
    expect(searchTasks(tasks, 'needle', 3)).toHaveLength(3);
  });

  it('snippet 会截断并带省略号', () => {
    const tasks = [makeTask({ finalText: `${'a'.repeat(500)}needle${'b'.repeat(500)}` })];
    const matches = searchTasks(tasks, 'needle', 20, 100);
    expect(matches[0]?.snippet.startsWith('…')).toBe(true);
    expect(matches[0]?.snippet.endsWith('…')).toBe(true);
    expect(matches[0]?.snippet.length).toBeLessThan(150);
  });
});
