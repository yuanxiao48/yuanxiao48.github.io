@echo off
setlocal

set "PROJECT=%~dp0"
set "PROJECT=%PROJECT:~0,-1%"
set "BLOG_URL=http://127.0.0.1:4321/"
set "STUDIO_URL=http://127.0.0.1:4322/"

cd /d "%PROJECT%"

for %%P in (4321 4322) do (
  powershell -NoProfile -Command "$busy = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object { $_.Port -eq %%P }; if ($busy) { exit 1 }"
  if errorlevel 1 (
    echo.
    echo Cannot start everything because port %%P is already in use.
    echo Close the existing service first to avoid duplicate windows.
    echo.
    pause
    exit /b 1
  )
)

start "Blog Preview" cmd /k "cd /d ""%PROJECT%"" ^&^& set ASTRO_TELEMETRY_DISABLED=1 ^&^& set npm_config_cache=%PROJECT%\.npm-cache ^&^& npm run dev -- --host 127.0.0.1 --port 4321"
start "Blog Studio" cmd /k "call ""%PROJECT%\start-studio.cmd"""

echo.
echo Starting both services:
echo Blog:   %BLOG_URL%
echo Studio: %STUDIO_URL%
echo.
echo Separate log windows have been opened.

for /L %%I in (1,1,20) do (
  powershell -NoProfile -Command "try { $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 '%BLOG_URL%'; if ($response.StatusCode -eq 200) { exit 0 } } catch {}; exit 1"
  if not errorlevel 1 goto :openBlog
  timeout /t 1 /nobreak >nul
)

echo Blog preview is still starting. Check the Blog Preview window.
pause
exit /b 1

:openBlog
start "" "%BLOG_URL%"
echo Blog preview is ready. Studio opens its own browser tab when it is ready.
pause
