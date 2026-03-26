@echo off
echo Starting IONEX Time Tracking...
echo.

REM Find Node.js in common locations
set NODE_PATH=
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" (
    set NODE_PATH=%LOCALAPPDATA%\Programs\nodejs
    goto :found
)
if exist "C:\Program Files\nodejs\node.exe" (
    set NODE_PATH=C:\Program Files\nodejs
    goto :found
)
if exist "%PROGRAMFILES%\nodejs\node.exe" (
    set NODE_PATH=%PROGRAMFILES%\nodejs
    goto :found
)

echo ERROR: Node.js not found
pause
exit /b 1

:found
REM Add Node.js to PATH for this session
set PATH=%NODE_PATH%;%PATH%

REM Change to project directory
cd /d "%~dp0"

echo Starting backend and frontend servers...
echo.
call npm run dev

