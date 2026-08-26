@echo off
cd /d "%~dp0"

echo.
echo Chat server port 3000  ^|  ComfyUI port 8188 ^(start separately^)
echo.

echo [1/2] Kill old process on port 3000...
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":3000" ^| findstr "LISTENING"') do (
  echo       taskkill PID %%a
  taskkill /PID %%a /F >nul 2>&1
  ping -n 2 127.0.0.1 >nul
  goto start_server
)
echo       no old process

:start_server
echo.
echo [2/2] Starting node server.js ...
node server.js
if errorlevel 1 (
  echo.
  echo ERROR: node failed. Is Node.js installed?
)
echo.
pause
