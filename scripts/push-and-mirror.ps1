<#
.SYNOPSIS
  推送当前独立仓到 origin，再同步合仓镜像中对应目录。
#>
param(
    [ValidateSet('client', 'server')]
    [string]$Part = 'server',
    [switch]$NoPushIndependent,
    [switch]$NoPushMono
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$MonoRoot = Join-Path (Split-Path -Parent $RepoRoot) 'AI_tool_server_and_client'
$SyncScript = Join-Path $MonoRoot 'scripts\sync-to-monorepo.ps1'

if (-not (Test-Path $SyncScript)) {
    throw "找不到合仓同步脚本: $SyncScript`n请确认合仓在 $MonoRoot ，或改本脚本里的路径。"
}

Push-Location $RepoRoot
try {
    if (-not $NoPushIndependent) {
        $status = git status --porcelain
        if (-not [string]::IsNullOrWhiteSpace($status)) {
            Write-Warning '工作区有未提交改动。将只推送已有提交；未提交内容不会进合仓。'
        }
        Write-Host ">> git push 独立仓 ($Part) ..."
        git push -u origin HEAD
        if ($LASTEXITCODE -ne 0) { throw '独立仓 push 失败' }
    }
}
finally {
    Pop-Location
}

$syncArgs = @{ Only = $Part }
if ($NoPushMono) { $syncArgs.NoPush = $true }

Write-Host ">> 同步合仓 $Part ..."
& $SyncScript @syncArgs
