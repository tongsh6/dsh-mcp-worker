import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureDshCompatPatches,
  ensureOutputDecodingPatch,
  ensurePwshEncodingPatch,
  inspectDshCompatPatches,
  inspectPwshEncodingPatch,
  resolveOutputCollectorFile,
  resolvePwshLocalFile,
  type DshPatchMode,
} from '../src/dsh-patch.js';
import type { DshEntry } from '../src/config.js';

const OLD_PREAMBLE =
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); ';
const fakeEntryLine = `const ENCODING_PREAMBLE = "${OLD_PREAMBLE}";\n`;

const OUTPUT_JS = `import { Buffer } from "node:buffer";
class OutputCollector {
	readFrom(fromByte) {
		const windowStart = this.total - this.bytes;
		const buffer = Buffer.concat(this.chunks);
		const lossy = fromByte < windowStart;
		return {
			text: (lossy ? buffer : buffer.subarray(fromByte - windowStart)).toString("utf8"),
			nextOffset: this.total,
			lossy
		};
	}
	finalize() {
		this.seal();
		return {
			text: Buffer.concat(this.chunks).toString("utf8"),
			truncated: this.dropped
		};
	}
}
export { OutputCollector };
`;

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await Promise.resolve(fn()).catch(() => undefined);
});

async function setup(
  options: { content?: string; omitPwshLocal?: boolean; omitBinJs?: boolean; omitOutputCollector?: boolean; outputContent?: string } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-patch-'));
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const scopeDir = join(root, 'node_modules', '@deepseek-ai');
  const binJs = join(scopeDir, 'dsh', 'lib', 'bin.js');
  await mkdir(join(scopeDir, 'dsh', 'lib'), { recursive: true });
  if (!options.omitBinJs) await writeFile(binJs, '// fake dsh entry\n', 'utf8');

  const pwshFile = join(scopeDir, 'dsh-pwsh-local', 'lib', 'index.js');
  if (!options.omitPwshLocal) {
    await mkdir(join(scopeDir, 'dsh-pwsh-local', 'lib'), { recursive: true });
    await writeFile(pwshFile, options.content ?? `// pretest\n${fakeEntryLine}`, 'utf8');
  }

  const outputFile = join(scopeDir, 'dsh-subprocess-local', 'lib', 'output.js');
  if (!options.omitOutputCollector) {
    await mkdir(join(scopeDir, 'dsh-subprocess-local', 'lib'), { recursive: true });
    await writeFile(outputFile, options.outputContent ?? OUTPUT_JS, 'utf8');
  }

  const entry: DshEntry = { command: process.execPath, args: [binJs], source: 'test' };
  return { root, entry, pwshFile, outputFile, binJs };
}

describe('resolvePwshLocalFile / resolveOutputCollectorFile', () => {
  it('从 @deepseek-ai/dsh/lib/bin.js 推导两个目标文件', async () => {
    const { entry, pwshFile, outputFile } = await setup();
    expect(resolvePwshLocalFile(entry)).toBe(pwshFile);
    expect(resolveOutputCollectorFile(entry)).toBe(outputFile);
  });

  it('非 node bin.js 入口返回 null', async () => {
    await setup({ omitBinJs: true });
    const shellEntry: DshEntry = { command: 'dsh', args: [], shell: true, source: 'PATH(dsh)' };
    expect(resolvePwshLocalFile(shellEntry)).toBeNull();
    expect(resolveOutputCollectorFile({ ...shellEntry, args: ['C:\\dsh.cmd'] })).toBeNull();
  });
});

describe('ensurePwshEncodingPatch（兼容保留）', () => {
  it('apply 模式：备份 + 修复 + 幂等', async () => {
    const { entry, pwshFile } = await setup();
    const first = await ensurePwshEncodingPatch(entry, 'apply');
    expect(first.status).toBe('applied');
    const content = await readFile(pwshFile, 'utf8');
    expect(content).toContain("LanguageMode -ne 'ConstrainedLanguage'");
    expect(content).not.toContain(OLD_PREAMBLE);
    expect(existsSync(`${pwshFile}.bak-dsh-mcp-encoding`)).toBe(true);

    const second = await ensurePwshEncodingPatch(entry, 'apply');
    expect(second.status).toBe('patched');
    expect(await readFile(pwshFile, 'utf8')).toBe(content);
  });

  it('notify 模式只报告不修改', async () => {
    const { entry, pwshFile } = await setup();
    const result = await ensurePwshEncodingPatch(entry, 'notify');
    expect(result.status).toBe('not_needed');
    expect(await readFile(pwshFile, 'utf8')).toContain(OLD_PREAMBLE);
    expect(existsSync(`${pwshFile}.bak-dsh-mcp-encoding`)).toBe(false);
  });

  it('off 模式完全跳过', async () => {
    const { entry } = await setup();
    const result = await ensurePwshEncodingPatch(entry, 'off' satisfies DshPatchMode);
    expect(result.status).toBe('unknown');
  });

  it('找不到 dsh-pwsh-local 时返回 unknown 而不抛错', async () => {
    const { entry } = await setup({ omitPwshLocal: true });
    const result = await ensurePwshEncodingPatch(entry, 'apply');
    expect(result.status).toBe('unknown');
  });

  it('DSH 版本变化（前缀不匹配）时跳过并报告 unknown', async () => {
    const { entry } = await setup({ content: 'const ENCODING_PREAMBLE = "changed";\n' });
    const result = await ensurePwshEncodingPatch(entry, 'apply');
    expect(result.status).toBe('unknown');
    expect(result.message).toContain('版本可能已变化');
  });

  it('inspect 能读出 patched/missing', async () => {
    const { entry } = await setup();
    expect((await inspectPwshEncodingPatch(entry)).status).toBe('missing');
    await ensurePwshEncodingPatch(entry, 'apply');
    expect((await inspectPwshEncodingPatch(entry)).status).toBe('patched');
  });
});

describe('ensureOutputDecodingPatch（GBK 兜底）', () => {
  it('apply 模式：两处解码点被替换 + 注入 helper + 备份', async () => {
    const { entry, outputFile } = await setup();
    const result = await ensureOutputDecodingPatch(entry, 'apply');
    expect(result.status).toBe('applied');
    const content = await readFile(outputFile, 'utf8');
    expect(content).toContain('function decodeStreamText(');
    expect(content).toContain('decodeStreamText(lossy ? buffer : buffer.subarray(fromByte - windowStart))');
    expect(content).toContain('decodeStreamText(Buffer.concat(this.chunks))');
    expect(content).not.toContain('.toString("utf8"),');
    expect(existsSync(`${outputFile}.bak-dsh-mcp-decoding`)).toBe(true);
  });

  it('幂等：第二次执行不再改动', async () => {
    const { entry, outputFile } = await setup();
    await ensureOutputDecodingPatch(entry, 'apply');
    const once = await readFile(outputFile, 'utf8');
    const second = await ensureOutputDecodingPatch(entry, 'apply');
    expect(second.status).toBe('patched');
    expect(await readFile(outputFile, 'utf8')).toBe(once);
  });

  it('notify 模式不写文件', async () => {
    const { entry, outputFile } = await setup();
    const result = await ensureOutputDecodingPatch(entry, 'notify');
    expect(result.status).toBe('not_needed');
    expect(await readFile(outputFile, 'utf8')).toBe(OUTPUT_JS);
  });

  it('调用点不匹配时跳过并报告 unknown', async () => {
    const { entry } = await setup({ outputContent: 'export const x = 1;\n' });
    const result = await ensureOutputDecodingPatch(entry, 'apply');
    expect(result.status).toBe('unknown');
    expect(result.message).toContain('版本可能已变化');
  });

  it('文件缺失时返回 unknown', async () => {
    const { entry } = await setup({ omitOutputCollector: true });
    const result = await ensureOutputDecodingPatch(entry, 'apply');
    expect(result.status).toBe('unknown');
  });
});

describe('ensureDshCompatPatches / inspectDshCompatPatches', () => {
  it('一次返回两个补丁结果', async () => {
    const { entry } = await setup();
    const results = await ensureDshCompatPatches(entry, 'apply');
    expect(results.map((result) => result.name)).toEqual(['pwsh-encoding', 'output-decoding']);
    expect(results.every((result) => result.status === 'applied')).toBe(true);
  });

  it('inspect 汇总两个补丁状态', async () => {
    const { entry } = await setup();
    expect(await inspectDshCompatPatches(entry)).toEqual({ pwsh_encoding: 'missing', output_decoding: 'missing' });
    await ensureDshCompatPatches(entry, 'apply');
    expect(await inspectDshCompatPatches(entry)).toEqual({ pwsh_encoding: 'patched', output_decoding: 'patched' });
  });
});
