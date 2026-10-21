$ErrorActionPreference = 'Stop'
try {
    $routerRoot = Split-Path -Parent $PSScriptRoot
    $pidPath = Join-Path $env:USERPROFILE '.opencode\router.pid'
    if (-not (Test-Path $pidPath)) { exit 0 }
    $routerState = Get-Content -LiteralPath $pidPath -Raw | ConvertFrom-Json
    $routerProcessId = [int]$routerState.pid
    $routerProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $routerProcessId"
    if (-not $routerProcess) { exit 0 }
    $expectedEntry = Join-Path $routerRoot 'dist\bin.js'
    if ($routerProcess.Name -ne 'node.exe' -or -not $routerProcess.CommandLine.Contains($expectedEntry)) {
        throw 'The recorded process does not match this router installation. Refusing to stop an unrelated process.'
    }
    Stop-Process -Id $routerProcessId -ErrorAction Stop
    Wait-Process -Id $routerProcessId -Timeout 10 -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $pidPath -ErrorAction SilentlyContinue
} catch {
    (New-Object -ComObject WScript.Shell).Popup($_.Exception.Message, 0, 'OpenCode Router - stop failed', 16) | Out-Null
    exit 1
}
