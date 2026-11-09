# 修复 DSH 在 read-only 沙箱下「中文输出乱码」
#
# 背景：补丁 `patch-dsh-pwsh-encoding.ps1` 让 read-only（ConstrainedLanguage）跳过
# UTF-8 前缀后，无控制台 spawn 的 pwsh 会按系统代码页（GBK/936）写 stdout/stderr，
# 而 DSH 的 OutputCollector 固定按 UTF-8 解码 → 中文变成 �。
# 本脚本给 dsh-subprocess-local/lib/output.js 打「UTF-8 严格解码失败 → GBK 兜底」补丁，
# 对合法 UTF-8 输出完全无影响。
#
# 用法：
#   pwsh -File scripts/patch-dsh-output-decoding.ps1 [-DshDir D:\dsh-harness]
# 幂等；worker 启动时也会自动应用（DSH_MCP_DSH_PATCH=apply）。

param(
  [string]$DshDir = $(if ($env:DSH_MCP_DSH_DIR) { $env:DSH_MCP_DSH_DIR } else { 'D:\dsh-harness' })
)

$ErrorActionPreference = 'Stop'

$file = Join-Path $DshDir 'node_modules\@deepseek-ai\dsh-subprocess-local\lib\output.js'
if (-not (Test-Path $file)) {
  throw "找不到 dsh-subprocess-local OutputCollector：$file"
}

$readTarget = 'text: (lossy ? buffer : buffer.subarray(fromByte - windowStart)).toString("utf8"),'
$readReplacement = 'text: decodeStreamText(lossy ? buffer : buffer.subarray(fromByte - windowStart)),'
$finalTarget = 'text: Buffer.concat(this.chunks).toString("utf8"),'
$finalReplacement = 'text: decodeStreamText(Buffer.concat(this.chunks)),'
$marker = 'function decodeStreamText('

$helper = @'

/** DSH 兼容补丁：ConstrainedLanguage 下 pwsh 可能按系统代码页输出；UTF-8 严格解码失败时回退 GBK。 */
function decodeStreamText(buffer) {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
	} catch {
		try {
			return new TextDecoder("gbk").decode(buffer);
		} catch {
			return buffer.toString("utf8");
		}
	}
}
'@

$raw = [System.IO.File]::ReadAllText($file)
if ($raw.Contains($marker)) {
  Write-Host "[patch] 已是修复后的版本，无需改动：$file"
  exit 0
}

if (-not $raw.Contains($readTarget) -or -not $raw.Contains($finalTarget)) {
  throw '未找到预期的解码调用点；DSH 版本可能已变化，请人工确认。'
}

$backup = "$file.bak-dsh-mcp-decoding"
if (-not (Test-Path $backup)) {
  Copy-Item $file $backup
  Write-Host "[patch] 已备份：$backup"
}

$patched = $raw.Replace($readTarget, $readReplacement).Replace($finalTarget, $finalReplacement) + $helper
[System.IO.File]::WriteAllText($file, $patched, (New-Object System.Text.UTF8Encoding($false)))

if (-not ([System.IO.File]::ReadAllText($file).Contains($marker))) {
  throw '补丁写入后校验失败，请从备份恢复。'
}
Write-Host '[patch] 完成：read-only 下中文输出/错误将按 GBK 兜底解码（DSH 升级后请重跑或依赖 worker 自动修复）。'
