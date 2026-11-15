' ProofPipe silent Windows tray launcher (runs via wscript.exe with zero console window).
Option Explicit

Dim fso, root, ps1, cmd, shell
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = fso.BuildPath(root, "scripts\tray.ps1")

cmd = "powershell.exe -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & ps1 & """"

Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = root
' 0 = SW_HIDE (never allocate or flash a console window), False = do not wait
shell.Run cmd, 0, False
