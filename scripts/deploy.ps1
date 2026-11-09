# 将构建产物 + 生产依赖部署到独立运行目录，MCP 客户端只指向运行目录，不直接加载源码树。
#
# 用法：
#   pwsh -File scripts/deploy.ps1 -Target D:\dsh-mcp-worker
#   或先设 DSH_MCP_WORKER_HOME，然后 pwsh -File scripts/deploy.ps1
#
# 之后 MCP 配置里的入口应为 <Target>\dist\index.js（例如 D:\dsh-mcp-worker\dist\index.js）。
param(
  [string]$Target = $(if ($env:DSH_MCP_WORKER_HOME) { $env:DSH_MCP_WORKER_HOME } else { Join-Path $env:LOCALAPPDATA 'dsh-mcp-worker' }),
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

if (-not $SkipBuild) {
  Push-Location $repo
  try {
    pnpm build
    if ($LASTEXITCODE -ne 0) { throw 'pnpm build 失败' }
  } finally {
    Pop-Location
  }
}

New-Item -ItemType Directory -Force $Target | Out-Null
if (Test-Path (Join-Path $Target 'dist')) {
  Remove-Item (Join-Path $Target 'dist') -Recurse -Force
}
Copy-Item (Join-Path $repo 'dist') (Join-Path $Target 'dist') -Recurse -Force

$runtimeFiles = @('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'README.md', 'LICENSE')
foreach ($file in $runtimeFiles) {
  $path = Join-Path $repo $file
  if (Test-Path $path) { Copy-Item $path $Target -Force }
}

Push-Location $Target
try {
  pnpm install --prod --frozen-lockfile --ignore-scripts
  if ($LASTEXITCODE -ne 0) { throw 'pnpm install --prod 失败' }
} finally {
  Pop-Location
}

Write-Host "[deploy] 源码：$repo"
Write-Host "[deploy] 运行目录：$Target"
Write-Host "[deploy] MCP 入口：$(Join-Path $Target 'dist\index.js')"
