@echo off
title free-llm-bridge
cd /d "%~dp0"
set HOST=0.0.0.0
echo ============================================================
echo   free-llm-bridge  (listening on ALL interfaces so the
echo   Hindsight container on your NAS can reach this PC)
echo.
echo   LAN address to put in the Hindsight BASE_URL:
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do echo     %%a
echo.
echo   Pick the address in the SAME subnet as your NAS.
echo   Keep this window open.  Ctrl+C stops the bridge.
echo ============================================================
echo.
node index.js --port 18999
echo.
echo Bridge stopped. Press any key to close...
pause >nul
