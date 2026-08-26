@echo off
chcp 65001 >nul
cd /d "d:\AI\picture_prompt_produce"

echo.
echo 这是聊天网页，端口 3000。
echo ComfyUI 是另一个程序，端口 8188，需要单独启动。
echo.

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000" ^| findstr LISTENING') do (
  echo 检测到旧服务占用 3000，正在重启以加载最新代码...
  taskkill /PID %%a /F >nul 2>&1
)

echo 正在启动聊天项目...
node server.js
pause
