# 修复 DSH 在 read-only 沙箱下的 pwsh 编码噪音
#
# 背景：DSH 的 dsh-pwsh-local 会给每条 pwsh 命令前缀一段编码固定脚本：
#   [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ...
# 但 Windows ACL 沙箱下 read-only 模式会以 ConstrainedLanguage 启动 pwsh，
# 创建 .NET 类型被拒绝，导致每次调用都多出两条 stderr：
#   InvalidOperation: 无法创建类型。此语言模式仅支持核心类型。
# 本脚本把前缀改成「仅 FullLanguage 时执行」，行为在 workspace-write /
# danger-full-access 下完全不变，在 read-only 下不再产生噪音。
#
# 用法：
#   pwsh -File scripts/patch-dsh-pwsh-encoding.ps1 [-DshDir D:\dsh-harness]
# DSH 升级后（文件被覆盖）需重新执行本脚本；可重复执行（幂等）。

param(
  [string]$DshDir = $(if ($env:DSH_MCP_DSH_DIR) { $env:DSH_MCP_DSH_DIR } else { 'D:\dsh-harness' })
)

$ErrorActionPreference = 'Stop'

$file = Join-Path $DshDir 'node_modules\@deepseek-ai\dsh-pwsh-local\lib\index.js'
if (-not (Test-Path $file)) {
  throw "找不到 dsh-pwsh-local 入口：$file"
}

$oldPreamble = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); '
$newPreamble = 'if ($ExecutionContext.SessionState.LanguageMode -ne ''ConstrainedLanguage'') { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false) }; '
$marker = "LanguageMode -ne 'ConstrainedLanguage'"

$raw = [System.IO.File]::ReadAllText($file)
if ($raw.Contains($marker)) {
  Write-Host "[patch] 已是修复后的版本，无需改动：$file"
  exit 0
}

$occurrences = ([regex]::Matches($raw, [regex]::Escape($oldPreamble))).Count
if ($occurrences -ne 1) {
  throw "预期恰好 1 处编码前缀，实际 $occurrences 处；DSH 版本可能已变化，请人工确认。"
}

$backup = "$file.bak-dsh-mcp-encoding"
if (-not (Test-Path $backup)) {
  Copy-Item $file $backup
  Write-Host "[patch] 已备份：$backup"
}

$patched = $raw.Replace($oldPreamble, $newPreamble)
[System.IO.File]::WriteAllText($file, $patched, (New-Object System.Text.UTF8Encoding($false)))

$verify = [System.IO.File]::ReadAllText($file)
if (-not $verify.Contains($marker)) {
  throw '补丁写入后校验失败，请从备份恢复。'
}
Write-Host '[patch] 完成：read-only 沙箱下不再产生 InvalidOperation 噪音（DSH 升级后请重跑本脚本）。'
