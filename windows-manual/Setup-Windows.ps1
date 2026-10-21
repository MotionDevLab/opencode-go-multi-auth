[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [string]$DesktopDirectory = [Environment]::GetFolderPath('Desktop'),
    [string]$StartMenuDirectory = (Join-Path ([Environment]::GetFolderPath('Programs')) 'OpenCode Router')
)

$ErrorActionPreference = 'Stop'
$routerRoot = Split-Path -Parent $PSScriptRoot
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$nodeVersion = & $nodeExe -p 'process.versions.node'
if ($LASTEXITCODE -ne 0 -or [version]$nodeVersion -lt [version]'22.0.0') {
    throw 'Install Node.js 22 or later, then run setup again.'
}

if (-not $SkipBuild) {
    $npmExe = (Get-Command npm.cmd -ErrorAction Stop).Source
    Push-Location $routerRoot
    try {
        & $npmExe ci --ignore-scripts --no-fund --no-audit
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
        & $npmExe run typecheck
        if ($LASTEXITCODE -ne 0) { throw 'Type checking failed.' }
        & $npmExe run build
        if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
    } finally {
        Pop-Location
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $routerRoot 'dist\bin.js'))) {
    throw 'The router is not built. Run setup without -SkipBuild.'
}

$shortcutShell = New-Object -ComObject WScript.Shell
$powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$shortcuts = @(
    @{ Name = 'OpenCode Router'; Script = 'Start-Router.ps1'; Icon = 14 },
    @{ Name = 'Stop OpenCode Router'; Script = 'Stop-Router.ps1'; Icon = 131 }
)
foreach ($directory in @($DesktopDirectory, $StartMenuDirectory)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    foreach ($item in $shortcuts) {
        $shortcut = $shortcutShell.CreateShortcut((Join-Path $directory ($item.Name + '.lnk')))
        $shortcut.TargetPath = $powershellExe
        $shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $PSScriptRoot $item.Script) + '"'
        $shortcut.WorkingDirectory = $routerRoot
        $shortcut.WindowStyle = 7
        $shortcut.IconLocation = (Join-Path $env:SystemRoot 'System32\shell32.dll') + ',' + $item.Icon
        $shortcut.Description = $item.Name + ' (manual launch only)'
        $shortcut.Save()
    }
}
$guide = $shortcutShell.CreateShortcut((Join-Path $StartMenuDirectory 'Router Quick Start.lnk'))
$guide.TargetPath = Join-Path $PSScriptRoot 'Quick Start.txt'
$guide.Save()

Write-Output "Installed manual launch shortcuts for $routerRoot"
Write-Output "Desktop: $DesktopDirectory"
Write-Output "Start menu: $StartMenuDirectory"
Write-Output 'Setup does not start the router or configure autorun. Use OpenCode Router when needed.'
