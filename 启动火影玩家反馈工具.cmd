@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 火影手游玩家反馈调查工具

where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js，请先安装 Node.js 24 或更高版本。
  pause
  exit /b 1
)

for /f "tokens=1 delims=." %%V in ('node -p "process.versions.node"') do set "NODE_MAJOR=%%V"
if %NODE_MAJOR% LSS 24 (
  echo 当前 Node.js 版本过低，请安装 Node.js 24 或更高版本。
  pause
  exit /b 1
)

call :open_if_running
if not errorlevel 1 exit /b 0

echo 正在检查本地组件...
call npm install --no-audit --no-fund
if errorlevel 1 goto :failed

echo 正在构建最新网页版界面...
call npm run build
if errorlevel 1 goto :failed

call :open_if_running
if not errorlevel 1 exit /b 0

echo 即将在浏览器中打开工具。关闭此窗口不会删除已经保存的调查数据。
call npm start
if errorlevel 1 goto :failed
exit /b 0

:open_if_running
set "RUNNING_URL="
for /f "usebackq delims=" %%U in (`node --env-file-if-exists=.env scripts\find-running-instance.mjs 2^>nul`) do set "RUNNING_URL=%%U"
if not defined RUNNING_URL exit /b 1
echo 工具已经在运行，正在打开现有页面...
if /I not "%NO_OPEN%"=="true" start "" "%RUNNING_URL%"
exit /b 0

:failed
echo.
echo 工具未能启动，请查看上方错误信息。
pause
exit /b 1
