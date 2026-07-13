@echo off
setlocal

set "PROJECT=%~dp0"
set "PROJECT=%PROJECT:~0,-1%"

pushd "%PROJECT%"

set ASTRO_TELEMETRY_DISABLED=1
set npm_config_cache=%PROJECT%\.npm-cache

echo.
echo Firefly local preview:
echo http://127.0.0.1:4321/
echo.
echo If 4321 is busy, use the Local URL printed below.
echo Keep this window open while editing.
echo.

npm run dev -- --host 127.0.0.1 --port 4321
set "STATUS=%ERRORLEVEL%"

popd
pause
exit /b %STATUS%
