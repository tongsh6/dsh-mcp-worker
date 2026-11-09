# 输出 pnpm 全局安装的 MCP 入口路径，供 Codex/ChatGPT/Claude 配置使用。
#
# 用法：
#   pwsh -File scripts/mcp-entry.ps1
#   pwsh -File scripts/mcp-entry.ps1 -Package dsh-mcp-worker
param(
  [string]$Package = 'dsh-mcp-worker',
  [string]$PnpmHome = $env:PNPM_HOME
)

$ErrorActionPreference = 'Stop'

if (-not $PnpmHome) {
  $pnpm = (Get-Command pnpm -ErrorAction SilentlyContinue).Source
  if (-not $pnpm) { throw '找不到 pnpm，请先安装并确保在 PATH 中' }
  $PnpmHome = Split-Path -Parent $pnpm
}

$shim = Join-Path $PnpmHome "bin\$Package.cmd"
if (-not (Test-Path $shim)) { $shim = Join-Path $PnpmHome "$Package.cmd" }
if (-not (Test-Path $shim)) {
  throw "未找到 pnpm 全局 shim：$PnpmHome\bin\$Package.cmd（先执行 pnpm add -g $Package）"
}

$raw = Get-Content $shim -Raw
$pattern = 'global\\[^"]*?node_modules\\' + [regex]::Escape($Package) + '\\dist\\index\.js'
$match = [regex]::Match($raw, $pattern)
if (-not $match.Success) { throw "无法从 shim 解析 $Package 入口：$shim" }

$entry = Join-Path $PnpmHome $match.Value
if (-not (Test-Path $entry)) { throw "入口不存在：$entry" }
Write-Output $entry
