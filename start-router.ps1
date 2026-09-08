$ErrorActionPreference = "SilentlyContinue"
$daemonDir = "$env:USERPROFILE\opencode-go-multi-auth"

function Test-Healthy {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:18904/healthz" -TimeoutSec 3 -UseBasicParsing
    return $r.StatusCode -eq 200
  } catch { return $false }
}

if (Test-Healthy) {
  Write-Output "Router daemon already healthy."
} else {
  # Stale pid file from a dead process blocks the plugin path; standalone start doesn't need it, but clear it anyway.
  $pidFile = "$env:USERPROFILE\.opencode\router.pid"
  if (Test-Path $pidFile) {
    try {
      $pid = (Get-Content $pidFile -Raw | ConvertFrom-Json).pid
      if (-not (Get-Process -Id $pid -ErrorAction SilentlyContinue)) { Remove-Item $pidFile -Force }
    } catch { Remove-Item $pidFile -Force -ErrorAction SilentlyContinue }
  }
  Write-Output "Starting router daemon..."
  Start-Process -FilePath "node" -ArgumentList "dist\bin.js" -WorkingDirectory $daemonDir -WindowStyle Hidden
  $deadline = (Get-Date).AddSeconds(30)
  while (-not (Test-Healthy) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  if (Test-Healthy) { Write-Output "Router daemon started." }
  else { Write-Output "WARNING: daemon did not become healthy within 30s. Check $daemonDir for errors." }
}

Start-Process "http://localhost:18904/"
