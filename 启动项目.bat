@echo off
chcp 65001 >nul
cd /d "d:\AI\picture_prompt_produce"

echo.
echo 这是聊天网页，端口 3000。
echo ComfyUI 是另一个程序，端口 8188，需要单独启动。
echo.

netstat -ano | findstr ":3000" | findstr LISTENING >nul
if %errorlevel%==0 (
  echo 3000 已经有服务在跑，不用再开一次。
  echo 请直接打开: http://localhost:3000
  start "" "http://localhost:3000"
  pause
  exit /b 0
)

echo 正在启动聊天项目...
node server.js
pause
