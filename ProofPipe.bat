@echo off
title ProofPipe
rem ProofPipe launcher - double-click to start background daemon + Windows tray.
rem Pass --console to run in an attached foreground terminal window instead.
cd /d "%~dp0"

if not exist node_modules (
  echo Installing dependencies, one moment...
  call npm install --no-audit --no-fund
)

rem more libuv threads: parallel uploads (fs + sharp) do not queue behind each other
set UV_THREADPOOL_SIZE=16

if /i "%~1"=="--console" goto :console

rem Default: launch background daemon + Windows system tray icon (no lingering CMD window)
set PP_OPEN_BROWSER=1
node scripts\daemon.js start --open >nul 2>&1
start "" /B powershell.exe -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0scripts\tray.ps1"
exit /b 0

:console
set "PPP=%PORT%"
if "%PPP%"=="" set "PPP=8787"
netstat -ano | findstr /r /c:":%PPP% *.*LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo ProofPipe is ALREADY RUNNING on port %PPP% - just use it.
  echo Stop the background server first with: npm run daemon -- stop
  echo.
  pause
  exit /b 1
)

set PP_OPEN_BROWSER=1
echo ProofPipe server running - KEEP THIS WINDOW OPEN.
echo Closing this window stops the server.
echo.
node server.js

echo.
echo ProofPipe exited - see any error message above.
pause
