@echo off
setlocal
if "%~1"=="" (
    echo Drag and drop a game folder onto make-ftp-safe.bat
    echo or run: make-ftp-safe.bat "C:\path\to\GameFolder"
    pause
    exit /b 1
)
python "%~dp0scripts\make-ftp-safe.py" %*
echo.
pause
