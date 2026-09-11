' Windowless health gate for the "Open Code Zen Router" desktop shortcut.
' The .lnk targets wscript.exe + this script (not powershell.exe), so no
' console host ever appears on the healthy path. Healthy (dashboard
' :18904/healthz answers) -> open the dashboard URL silently and exit.
' Unhealthy -> hand off to start-router.ps1, which opens its visible
' titled console (the manual/diagnostics path) and opens the browser
' itself, so this script must not open the URL on that lane.
Option Explicit
Dim sh, fso, repoDir, http, healthy, code
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
repoDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
healthy = False
On Error Resume Next
Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
http.setTimeouts 1000, 1000, 1000, 3000
http.open "GET", "http://127.0.0.1:18904/healthz", False
http.send
If Err.Number = 0 Then
  code = http.status
  If code = 200 Then healthy = True
End If
On Error GoTo 0
If healthy Then
  sh.Run """http://localhost:18904/""", 0, False
Else
  sh.CurrentDirectory = repoDir
  sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & repoDir & "\start-router.ps1""", 1, False
End If
