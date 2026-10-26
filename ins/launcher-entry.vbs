' SnowBridge Launcher entry - double click to start the app (no console window).
' It launches the tray host (app\tray.ps1); the tray host owns the background
' service and the window. Closing the window keeps everything running in the
' tray; use the tray menu "??????????????????????????????" to really stop it.
Option Explicit

Dim fso, shell, base, trayScript, psExe
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

base = fso.GetParentFolderName(WScript.ScriptFullName)
trayScript = base & "\app\tray.ps1"

If Not fso.FileExists(trayScript) Then
  MsgBox "tray.ps1 not found: " & trayScript, 16, "SnowBridge Launcher"
  WScript.Quit 1
End If

psExe = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
If Not fso.FileExists(psExe) Then psExe = "powershell.exe"

' 0 = hidden window, False = do not wait
shell.Run """" & psExe & """ -NoProfile -Sta -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & trayScript & """", 0, False
