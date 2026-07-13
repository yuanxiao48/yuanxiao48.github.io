@echo off
setlocal

set "PROJECT=%~dp0"
set "PROJECT=%PROJECT:~0,-1%"

start "Blog Preview" cmd /k "cd /d ""%PROJECT%"" && npm run dev -- --host 127.0.0.1 --port 4321"
start "Blog Studio" cmd /k "cd /d ""%PROJECT%"" && set STUDIO_PORT=4324&& node studio-server.mjs"

echo.
echo Blog preview:
echo http://127.0.0.1:4321/
echo.
echo Blog Studio:
echo http://127.0.0.1:4324/
echo.
echo Two windows have been opened. Keep them open while editing.
echo.

timeout /t 4 >nul
start "" "http://127.0.0.1:4321/"
start "" "http://127.0.0.1:4324/"

pause
