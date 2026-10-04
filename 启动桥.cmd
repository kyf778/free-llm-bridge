@echo off
chcp 65001 >nul
title free-llm-bridge
cd /d "%~dp0"

rem 让 NAS 上的容器能访问这台电脑。删掉这行就只能本机用。
set HOST=0.0.0.0

echo ============================================================
echo   free-llm-bridge  启动器（监听所有网卡，NAS 容器可访问）
echo ============================================================
echo.
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do echo   本机局域网地址:%%a
echo.
echo   上面这个地址就是 NAS 上 Hindsight 要填的 IP。
echo   停止桥：直接关掉本窗口，或按 Ctrl+C
echo ============================================================
echo.

node index.js --port 18999

echo.
echo 桥已退出。按任意键关闭...
pause >nul
