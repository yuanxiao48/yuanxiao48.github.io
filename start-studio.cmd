@echo off
setlocal

set "PROJECT=%~dp0"
set "PROJECT=%PROJECT:~0,-1%"

pushd "%PROJECT%"

echo.
echo Blog Studio:
echo http://127.0.0.1:4324/
echo.
echo Keep this window open while editing.
echo.

set STUDIO_PORT=4324
node studio-server.mjs
set "STATUS=%ERRORLEVEL%"

popd
pause
exit /b %STATUS%
