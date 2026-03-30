@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0collab.ps1" %*
exit /b %ERRORLEVEL%
