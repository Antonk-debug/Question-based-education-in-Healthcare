@echo off
cd /d "%~dp0"
title Update Gemini API Key
echo Paste your Gemini API key below.
echo It usually starts with AIza...
echo.
set /p GEMINI_KEY=Gemini API key: 
if "%GEMINI_KEY%"=="" (
  echo.
  echo No key entered. Nothing changed.
  pause
  exit /b 1
)
echo.
echo Optional: set an access code for people using the hosted app.
echo Leave this blank if you do not want an access code.
set /p ACCESS_CODE=Access code: 
(
  echo GEMINI_API_KEY=%GEMINI_KEY%
  echo GEMINI_MODEL=gemini-3.1-flash-lite-preview
  echo GEMINI_MODELS=gemini-3.1-flash-lite-preview,gemini-2.5-flash,gemini-2.5-flash-lite
  echo ACCESS_CODE=%ACCESS_CODE%
) > .env
echo.
echo Saved the Gemini API key locally.
echo Close any old backend window, then run Start Adaptive Quiz Studio.bat again.
pause
