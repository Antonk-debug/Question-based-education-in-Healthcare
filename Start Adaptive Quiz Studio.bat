@echo off
cd /d "%~dp0"
title Adaptive Quiz Studio Backend
echo Starting Adaptive Quiz Studio...
echo.
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":4173" ^| findstr "LISTENING"') do (
  echo Closing old backend on port 4173...
  taskkill /PID %%a /F >nul 2>nul
)
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://127.0.0.1:4173/"

py -3 --version >nul 2>nul
if %errorlevel%==0 (
  py -3 server.py
  goto stopped
)

python --version >nul 2>nul
if %errorlevel%==0 (
  python server.py
  goto stopped
)

node --version >nul 2>nul
if %errorlevel%==0 (
  node server.js
  goto stopped
)

echo Could not find Python or Node on this computer.
echo Install Python from https://www.python.org/downloads/ and try again.

:stopped
echo.
echo Adaptive Quiz Studio backend stopped.
echo If the browser says 127.0.0.1 refused to connect, this window shows why.
pause
