@echo off
rem Double-click launcher for Reader. Extra args pass through, e.g. Reader.bat -Lan
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-reader.ps1" %*
pause
