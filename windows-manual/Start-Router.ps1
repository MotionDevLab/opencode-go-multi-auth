param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$routerRoot = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $env:USERPROFILE '.opencode'
function Test-Router {
    try { return (Invoke-RestMethod 'http://127.0.0.1:18904/healthz' -TimeoutSec 2).ok -eq $true }
    catch { return $false }
}
try {
    if (-not (Test-Router)) {
        $nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
        if (-not (Test-Path (Join-Path $routerRoot 'dist\bin.js'))) { throw 'Router build is missing. Run npm ci and npm run build in the installation folder.' }
        $occupied = Get-NetTCPConnection -State Listen -LocalPort 18904,18905 -ErrorAction SilentlyContinue
        if ($occupied) { throw 'Port 18904 or 18905 is already in use. See the router logs before starting another instance.' }
        New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
        $env:OPENCODE_ROUTER_PLUGIN_MODE = '1'
        $env:CONFIG_DIR = $stateDir
        $routerProcess = Start-Process -FilePath $nodeExe -ArgumentList ('"' + (Join-Path $routerRoot 'dist\bin.js') + '"') -WorkingDirectory $routerRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $stateDir 'router-stdout.log') -RedirectStandardError (Join-Path $stateDir 'router-stderr.log') -PassThru
        $deadline = (Get-Date).AddSeconds(30)
        while (-not (Test-Router)) {
            if ($routerProcess.HasExited) { throw 'Router exited during startup. Check .opencode\router-stderr.log.' }
            if ((Get-Date) -gt $deadline) { throw 'Router did not become healthy within 30 seconds. Check the logs in .opencode.' }
            Start-Sleep -Milliseconds 500
        }
    }
    Write-Output 'Router is running. Dashboard: http://127.0.0.1:18904 | Proxy: http://127.0.0.1:18905'
    if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:18904/' }
} catch {
    if ($NoBrowser) { throw }
    (New-Object -ComObject WScript.Shell).Popup($_.Exception.Message, 0, 'OpenCode Router - startup failed', 16) | Out-Null
    exit 1
}
