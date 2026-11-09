import { describe, expect, it } from 'vitest';
import { NdjsonParser } from '../src/ndjson.js';

describe('NdjsonParser', () => {
  it('解析完整行', () => {
    const p = new NdjsonParser();
    const events = p.push('{"type":"session","sessionId":"s1"}\n{"type":"final","text":"ok"}\n');
    expect(events.map((e) => e.type)).toEqual(['session', 'final']);
    expect(events[0]).toMatchObject({ sessionId: 's1' });
  });

  it('跨 chunk 的半行会缓存到下一块', () => {
    const p = new NdjsonParser();
    expect(p.push('{"type":"sess')).toEqual([]);
    const events = p.push('ion","sessionId":"s2"}\n');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'session', sessionId: 's2' });
  });

  it('跳过空行与非法 JSON，且不抛错', () => {
    const p = new NdjsonParser();
    const events = p.push('\n  \nnot-json\n{"type":"text","text":"hi"}\n{"no_type":true}\n');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'text', text: 'hi' });
    expect(p.skipped).toBe(2);
  });

  it('flush 处理结尾没有换行的残留行', () => {
    const p = new NdjsonParser();
    expect(p.push('{"type":"final","text":"tail"}')).toEqual([]);
    const tail = p.flush();
    expect(tail).toHaveLength(1);
    expect(tail[0]).toMatchObject({ type: 'final', text: 'tail' });
  });

  it('兼容 CRLF', () => {
    const p = new NdjsonParser();
    const events = p.push('{"type":"text","text":"a"}\r\n{"type":"text","text":"b"}\r\n');
    expect(events).toHaveLength(2);
  });
});
