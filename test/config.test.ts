import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, validateCwd } from '../src/config.js';
import { DEFAULT_PRICING } from '../src/pricing.js';

describe('loadConfig（合并自本机在用版 bridge 的配置项）', () => {
  it('默认超时 1800s（900s 实测偏小）', () => {
    expect(loadConfig({}).defaultTimeoutMs).toBe(1_800_000);
  });

  it('默认版本号随合并升级', () => {
    expect(loadConfig({}).version).toBe('0.10.0');
  });

  it('默认单价是 DeepSeek 估算价', () => {
    expect(loadConfig({}).pricing).toEqual(DEFAULT_PRICING);
  });

  it('单价与汇率可由环境变量覆盖', () => {
    const config = loadConfig({
      DSH_MCP_PRICE_INPUT_PER_MTOK: '1.5',
      DSH_MCP_PRICE_CACHE_READ_PER_MTOK: '0.15',
      DSH_MCP_PRICE_OUTPUT_PER_MTOK: '3',
      DSH_MCP_USD_CNY: '7.1',
    });
    expect(config.pricing).toEqual({ inputPerMTok: 1.5, cacheReadPerMTok: 0.15, outputPerMTok: 3, usdCny: 7.1 });
  });

  it('幂等 TTL 与目录可配置', () => {
    const config = loadConfig({ DSH_MCP_IDEM_TTL_H: '48', DSH_HOME: '/tmp/dsh-home-test' });
    expect(config.idemTtlMs).toBe(48 * 3_600_000);
    // Windows 上 resolve('/tmp/...') 会变成当前盘符的 D:\tmp\...，用同平台规则算期望值。
    expect(config.idemDir).toBe(join(resolve('/tmp/dsh-home-test'), 'mcp-idem'));
  });

  it('兼容本机在用版的 DSH_MCP_ALLOWED_ROOTS（按平台分隔符）', () => {
    const roots = process.platform === 'win32' ? 'C:\\a;D:\\b' : '/a:/b';
    const config = loadConfig({ DSH_MCP_ALLOWED_ROOTS: roots });
    expect(config.allowedCwds).toHaveLength(2);
  });

  it('DSH_MCP_ALLOWED_CWDS 优先于 DSH_MCP_ALLOWED_ROOTS', () => {
    const config = loadConfig({ DSH_MCP_ALLOWED_CWDS: '/only', DSH_MCP_ALLOWED_ROOTS: '/ignored' });
    expect(config.allowedCwds).toEqual([resolve('/only')]);
  });
});

describe('validateCwd 平台差异', () => {
  it.skipIf(process.platform === 'win32')('macOS/Linux 允许主目录作为 cwd', () => {
    const config = loadConfig({});
    expect(validateCwd(homedir(), config)).toBe(resolve(homedir()));
  });

  it('拒绝不存在的目录', () => {
    const config = loadConfig({});
    expect(() => validateCwd('/definitely/not/exists/dsh-mcp-worker', config)).toThrow(/不存在/);
  });

  it('允许列表之外的目录被拒绝', () => {
    const config = loadConfig({ DSH_MCP_ALLOWED_ROOTS: '/allowed-root' });
    // 必须是存在的目录，否则会先命中「cwd 不存在」校验。
    expect(() => validateCwd(process.cwd(), config)).toThrow(/不在允许列表内/);
  });
});
