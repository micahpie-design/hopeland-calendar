@echo off
title Hopeland Calendar Sync Dashboard
echo.
echo  Starting Hopeland Calendar Sync Dashboard...
echo  Opening browser at http://localhost:3031/
echo.

start "" /b cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:3031/"

node "%~dp0calendar_dashboard.js"

echo.
echo  Server has stopped.
pause
