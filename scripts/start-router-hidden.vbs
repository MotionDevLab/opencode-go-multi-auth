' Hidden autostart launcher for the Open Code Zen Router daemon.
' Invoked by the "Open Code Zen Router" scheduled task as:
'   wscript.exe "<repo>\scripts\start-router-hidden.vbs"
' wscript.exe itself is windowless, and node.exe is spawned with window
' style 0 (hidden), so no console ever appears and no window can be closed
' by accident. Live logs stay on the dashboard Logs page and in
' ~/.opencode/router.log. The visible-console lane (start-router.ps1,
' manual/diagnostics) is untouched by this script.
Option Explicit
Dim sh, fso, repoDir, nodeExe, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
repoDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
nodeExe = "C:\Program Files\nodejs\node.exe"
If Not fso.FileExists(nodeExe) Then nodeExe = "node.exe"
sh.Environment("PROCESS")("OPENCODE_ROUTER_PLUGIN_MODE") = "1"
sh.CurrentDirectory = repoDir
cmd = """" & nodeExe & """ """ & repoDir & "\dist\bin.js"""
sh.Run cmd, 0, False
