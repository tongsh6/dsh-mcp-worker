import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { DshEntry } from './config.js';

/**
 * DSH 兼容补丁（read-only 沙箱下的 pwsh 中文输出）：
 *
 * 1) pwsh-encoding：DSH 给每条 pwsh 命令前缀 UTF-8 固定脚本，但 read-only 沙箱以
 *    ConstrainedLanguage 启动 pwsh，构造 .NET 类型被拒 → 每次调用两条 InvalidOperation。
 *    修复：前缀改为「仅非 ConstrainedLanguage 时执行」。
 * 2) output-decoding：跳过前缀后，无控制台 spawn 的 pwsh 按系统代码页（GBK）写管道，
 *    而 DSH 固定按 UTF-8 解码 → 中文输出/错误乱码。修复：UTF-8 严格解码失败时回退 GBK。
 */

// ---- 补丁 1：pwsh 编码前缀 ----
const OLD_PREAMBLE =
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); ';
const NEW_PREAMBLE =
  "if ($ExecutionContext.SessionState.LanguageMode -ne 'ConstrainedLanguage') { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false) }; ";
const PREAMBLE_MARKER = "LanguageMode -ne 'ConstrainedLanguage'";
const PREAMBLE_BACKUP_SUFFIX = '.bak-dsh-mcp-encoding';

// ---- 补丁 2：输出解码 GBK 兜底 ----
const DECODE_READ_TARGET = 'text: (lossy ? buffer : buffer.subarray(fromByte - windowStart)).toString("utf8"),';
const DECODE_READ_REPLACEMENT = 'text: decodeStreamText(lossy ? buffer : buffer.subarray(fromByte - windowStart)),';
const DECODE_FINAL_TARGET = 'text: Buffer.concat(this.chunks).toString("utf8"),';
const DECODE_FINAL_REPLACEMENT = 'text: decodeStreamText(Buffer.concat(this.chunks)),';
const DECODE_MARKER = 'function decodeStreamText(';
const DECODE_BACKUP_SUFFIX = '.bak-dsh-mcp-decoding';
const DECODE_HELPER = `
/** DSH 兼容补丁：ConstrainedLanguage 下 pwsh 可能按系统代码页输出；UTF-8 严格解码失败时回退 GBK。 */
function decodeStreamText(buffer) {
\ttry {
\t\treturn new TextDecoder("utf-8", { fatal: true }).decode(buffer);
\t} catch {
\t\ttry {
\t\t\treturn new TextDecoder("gbk").decode(buffer);
\t\t} catch {
\t\t\treturn buffer.toString("utf8");
\t\t}
\t}
}
`;

export type DshPatchMode = 'apply' | 'notify' | 'off';

export type PatchStatus = 'patched' | 'applied' | 'not_needed' | 'unknown' | 'failed';

export type DshPatchName = 'pwsh-encoding' | 'output-decoding';

export interface DshPatchResult {
  name: DshPatchName;
  status: PatchStatus;
  mode: DshPatchMode;
  file?: string;
  backup?: string;
  message: string;
}

/** 兼容旧类型名（pwsh 编码补丁）。 */
export type PwshEncodingPatchStatus = PatchStatus;
export type PwshEncodingPatchResult = DshPatchResult;

interface PatchSpec {
  name: DshPatchName;
  label: string;
  relativePath: string;
  marker: string;
  backupSuffix: string;
  apply: (raw: string) => { ok: true; text: string } | { ok: false; reason: string };
  /** 未找到文件时的说明。 */
  missingMessage: (file: string | null) => string;
  patchedMessage: string;
  appliedMessage: string;
  notifyMessage: string;
}

/** 从 DSH 入口 `.../@deepseek-ai/dsh/lib/bin.js` 推导 @deepseek-ai 作用域目录。 */
export function resolveDshScopeDir(dsh: DshEntry): string | null {
  const binJs = dsh.args.find((arg) => arg.replace(/\\/g, '/').endsWith('/lib/bin.js'));
  if (!binJs) return null;
  let dir = dirname(binJs);
  for (let depth = 0; depth < 6; depth += 1) {
    if (basename(dir) === '@deepseek-ai') return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function resolvePatchFile(dsh: DshEntry, relativePath: string): string | null {
  const scope = resolveDshScopeDir(dsh);
  return scope ? join(scope, relativePath) : null;
}

/** 兼容保留：dsh-pwsh-local 文件位置。 */
export function resolvePwshLocalFile(dsh: DshEntry): string | null {
  return resolvePatchFile(dsh, join('dsh-pwsh-local', 'lib', 'index.js'));
}

/** dsh-subprocess-local 的 OutputCollector 文件位置。 */
export function resolveOutputCollectorFile(dsh: DshEntry): string | null {
  return resolvePatchFile(dsh, join('dsh-subprocess-local', 'lib', 'output.js'));
}

const PREAMBLE_PATCH: PatchSpec = {
  name: 'pwsh-encoding',
  label: 'pwsh 编码前缀',
  relativePath: join('dsh-pwsh-local', 'lib', 'index.js'),
  marker: PREAMBLE_MARKER,
  backupSuffix: PREAMBLE_BACKUP_SUFFIX,
  apply: (raw) => {
    const occurrences = countOccurrences(raw, OLD_PREAMBLE);
    if (occurrences !== 1) {
      return { ok: false, reason: `未找到预期的编码前缀（DSH 版本可能已变化，实际 ${occurrences} 处），跳过自动修复` };
    }
    return { ok: true, text: raw.replace(OLD_PREAMBLE, NEW_PREAMBLE) };
  },
  missingMessage: (file) => `未找到 dsh-pwsh-local（${file ?? '入口不是 node bin.js'}）；跳过编码补丁检查`,
  patchedMessage: 'read-only pwsh 编码补丁已在位',
  appliedMessage: '已自动修复 DSH read-only pwsh 编码噪音（DSH 升级后会自动再修）',
  notifyMessage: '检测到 DSH pwsh 编码补丁缺失（notify 模式不修改）；可运行 scripts/patch-dsh-pwsh-encoding.ps1',
};

const DECODING_PATCH: PatchSpec = {
  name: 'output-decoding',
  label: '输出解码 GBK 兜底',
  relativePath: join('dsh-subprocess-local', 'lib', 'output.js'),
  marker: DECODE_MARKER,
  backupSuffix: DECODE_BACKUP_SUFFIX,
  apply: (raw) => {
    const readCount = countOccurrences(raw, DECODE_READ_TARGET);
    const finalCount = countOccurrences(raw, DECODE_FINAL_TARGET);
    if (readCount !== 1 || finalCount !== 1) {
      return {
        ok: false,
        reason: `未找到预期的输出解码调用点（DSH 版本可能已变化：readFrom=${readCount}、finalize=${finalCount}），跳过自动修复`,
      };
    }
    const patched = raw
      .replace(DECODE_READ_TARGET, DECODE_READ_REPLACEMENT)
      .replace(DECODE_FINAL_TARGET, DECODE_FINAL_REPLACEMENT);
    return { ok: true, text: `${patched}${DECODE_HELPER}` };
  },
  missingMessage: (file) => `未找到 dsh-subprocess-local（${file ?? '入口不是 node bin.js'}）；跳过输出解码补丁检查`,
  patchedMessage: 'read-only 下中文输出/错误的 GBK 兜底解码已在位',
  appliedMessage: '已自动修复 read-only 下中文输出乱码（UTF-8 解码失败时回退 GBK）',
  notifyMessage: '检测到 DSH 输出解码补丁缺失（notify 模式不修改）；可运行 scripts/patch-dsh-output-decoding.ps1',
};

/**
 * 启动时自动检测并（按 mode）修复 DSH 兼容补丁。
 * - apply（默认）：缺补丁就备份并原地修复；
 * - notify：只报告，不写文件；
 * - off：完全跳过。
 * 任何异常都返回 failed/unknown，不阻断 worker 启动。
 */
export async function ensureDshPatch(dsh: DshEntry, spec: PatchSpec, mode: DshPatchMode): Promise<DshPatchResult> {
  if (mode === 'off') {
    return { name: spec.name, status: 'unknown', mode, message: `已通过 DSH_MCP_DSH_PATCH=off 关闭 ${spec.label} 检查` };
  }
  const file = resolvePatchFile(dsh, spec.relativePath);
  if (!file || !existsSync(file)) {
    return { name: spec.name, status: 'unknown', mode, ...(file ? { file } : {}), message: spec.missingMessage(file) };
  }

  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    return { name: spec.name, status: 'failed', mode, file, message: `读取失败：${String(error)}` };
  }

  if (raw.includes(spec.marker)) {
    return { name: spec.name, status: 'patched', mode, file, message: spec.patchedMessage };
  }

  const applied = spec.apply(raw);
  if (!applied.ok) {
    return { name: spec.name, status: 'unknown', mode, file, message: applied.reason };
  }
  if (mode === 'notify') {
    return { name: spec.name, status: 'not_needed', mode, file, message: spec.notifyMessage };
  }

  const backup = `${file}${spec.backupSuffix}`;
  try {
    if (!existsSync(backup)) await copyFile(file, backup);
    await writeFile(file, applied.text, 'utf8');
    const verify = await readFile(file, 'utf8');
    if (!verify.includes(spec.marker)) {
      return { name: spec.name, status: 'failed', mode, file, backup, message: '写入后校验失败，请从备份恢复' };
    }
    return { name: spec.name, status: 'applied', mode, file, backup, message: spec.appliedMessage };
  } catch (error) {
    return {
      name: spec.name,
      status: 'failed',
      mode,
      file,
      backup,
      message: `自动修复失败（不影响 worker 启动）：${String(error)}`,
    };
  }
}

/** 一次性应用/检查两个兼容补丁（worker 启动时调用）。 */
export async function ensureDshCompatPatches(dsh: DshEntry, mode: DshPatchMode = 'apply'): Promise<DshPatchResult[]> {
  return [await ensureDshPatch(dsh, PREAMBLE_PATCH, mode), await ensureDshPatch(dsh, DECODING_PATCH, mode)];
}

/** 兼容保留：单独执行 pwsh 编码补丁。 */
export async function ensurePwshEncodingPatch(dsh: DshEntry, mode: DshPatchMode = 'apply'): Promise<PwshEncodingPatchResult> {
  return ensureDshPatch(dsh, PREAMBLE_PATCH, mode);
}

/** 兼容保留：单独执行输出解码补丁。 */
export async function ensureOutputDecodingPatch(dsh: DshEntry, mode: DshPatchMode = 'apply'): Promise<DshPatchResult> {
  return ensureDshPatch(dsh, DECODING_PATCH, mode);
}

export interface DshCompatInspection {
  pwsh_encoding: 'patched' | 'missing' | 'unknown';
  output_decoding: 'patched' | 'missing' | 'unknown';
}

/** 只读检查两个补丁状态（用于 describe / 启动日志之外的排障）。 */
export async function inspectDshCompatPatches(dsh: DshEntry): Promise<DshCompatInspection> {
  const inspect = async (file: string | null, marker: string): Promise<'patched' | 'missing' | 'unknown'> => {
    if (!file || !existsSync(file)) return 'unknown';
    try {
      return (await readFile(file, 'utf8')).includes(marker) ? 'patched' : 'missing';
    } catch {
      return 'unknown';
    }
  };
  return {
    pwsh_encoding: await inspect(resolvePwshLocalFile(dsh), PREAMBLE_MARKER),
    output_decoding: await inspect(resolveOutputCollectorFile(dsh), DECODE_MARKER),
  };
}

/** 兼容保留：pwsh 编码补丁只读检查。 */
export async function inspectPwshEncodingPatch(dsh: DshEntry): Promise<{ status: 'patched' | 'missing' | 'unknown'; file?: string }> {
  const file = resolvePwshLocalFile(dsh);
  const status = await inspectDshCompatPatches(dsh).then((value) => value.pwsh_encoding);
  return { status, ...(file ? { file } : {}) };
}

function countOccurrences(text: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = text.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}
