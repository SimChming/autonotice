@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo [qqsched] dir    = %CD%
echo [qqsched] config = configs\config.yaml
echo.

".\qqsched.exe" -config "configs\config.yaml"

echo.
echo [qqsched] exited with code %ERRORLEVEL%
echo Press any key to close this window...
pause >nul
