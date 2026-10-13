@echo off
REM ClinePass Bridge launcher (thin stub).
REM Runs start-bridge.ps1, which prints numbered stages and logs everything
REM to setup.log. This window stays open (pause below) so you can always
REM read what happened - if it fails, send setup.log + bridge.log.
title ClinePass Bridge
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-bridge.ps1"
echo.
echo [launcher] Finished with exit code %errorlevel%. Full log: setup.log
pause
