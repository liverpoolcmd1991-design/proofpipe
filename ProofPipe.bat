@echo off
title ProofPipe
rem ProofPipe launcher - double-click to run (sits in the repo root).
rem Starts the server and opens the harness; closing this window stops it.
cd /d "%~dp0"

rem port already busy? (e.g. the server is already running somewhere else).
rem Resolve the port the server will actually use (PORT env wins; default 8787)
rem and match it with the word-boundary form: plain ":8787" also matched
rem ":87870" etc. (substring hit).
set "PPP=%PORT%"
if "%PPP%"=="" set "PPP=8787"
netstat -ano | findstr /r /c:":%PPP% *.*LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo ProofPipe is ALREADY RUNNING on port %PPP% - just use it.
  echo Close the other ProofPipe window first if you want a fresh one.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies, one moment...
  call npm install --no-audit --no-fund
)

rem more libuv threads: parallel uploads (fs + sharp) do not queue behind each other
set UV_THREADPOOL_SIZE=16

rem tell the server this launch came from the .bat: once it is listening it
rem opens the harness itself, in the browser chosen in Settings. (The .bat
rem can't read settings.json; the server can — and it also removes the old
rem "wait 2s then open" race that could land on a dead page.)
set PP_OPEN_BROWSER=1

rem belt + suspenders: the server itself refuses a second instance via a
rem PID-guarded lockfile (data/proofpipe.lock) covering ANY port; this early
rem check just gives a friendlier exit for the common double-click case.
rem (honours the PORT env var; the server lock covers every remaining case)

echo ProofPipe server running - KEEP THIS WINDOW OPEN.
echo Closing this window stops the server.
echo.
node server.js

echo.
echo ProofPipe exited - see any error message above.
pause
