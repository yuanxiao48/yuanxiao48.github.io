@echo off
setlocal

set "PROJECT=%~dp0"
set "PROJECT=%PROJECT:~0,-1%"
set "DRIVE=X:"

if exist %DRIVE%\NUL (
  echo Drive %DRIVE% is already in use. Please close it or edit this script to use another drive letter.
  pause
  exit /b 1
)

subst %DRIVE% "%PROJECT%"
pushd %DRIVE%\

set ASTRO_TELEMETRY_DISABLED=1
set npm_config_cache=%PROJECT%\.npm-cache

npm run build
set "STATUS=%ERRORLEVEL%"

popd
subst %DRIVE% /D >nul 2>nul

if "%STATUS%"=="0" (
  echo.
  echo Build complete. Output folder:
  echo %PROJECT%\dist
  echo.
) else (
  echo.
  echo Build failed.
  echo.
)

pause
exit /b %STATUS%
