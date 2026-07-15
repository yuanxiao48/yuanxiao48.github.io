@echo off
setlocal

set "PROJECT=%~dp0"
set "PROJECT=%PROJECT:~0,-1%"
set "STUDIO_PORT=4322"
set "STUDIO_URL=http://127.0.0.1:4322/"

cd /d "%PROJECT%"

powershell -NoProfile -Command "$busy = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object { $_.Port -eq 4322 }; if ($busy) { exit 1 }"
if errorlevel 1 (
  echo.
  echo Studio could not start because port 4322 is already in use.
  echo Another Studio may already be running at %STUDIO_URL%
  echo Close that Studio window first, then try again.
  echo.
  pause
  exit /b 1
)

echo.
echo Starting Blog Studio...
echo %STUDIO_URL%
echo.

start "Blog Studio Server" /b node studio-server.mjs

set "READY="
for /L %%I in (1,1,15) do (
  powershell -NoProfile -Command "try { $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 '%STUDIO_URL%'; if ($response.StatusCode -eq 200) { exit 0 } } catch {}; exit 1"
  if not errorlevel 1 (
    set "READY=1"
    goto :openStudio
  )
  timeout /t 1 /nobreak >nul
)

echo Studio did not become ready on port 4322.
echo Check the log above for details.
pause
exit /b 1

:openStudio
start "" "%STUDIO_URL%"
echo Studio is ready. Keep this window open to view logs.
echo Press Ctrl+C or close this window to stop Studio.
echo.
pause
