@echo off
echo IONEX Time Tracking - Setup Script
echo ===================================
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

echo ERROR: Node.js not found in common locations
echo Please install Node.js from https://nodejs.org/ or add it to PATH
pause
exit /b 1

:found
echo Found Node.js at: %NODE_PATH%
%NODE_PATH%\node.exe --version
%NODE_PATH%\npm.cmd --version
echo.

REM Add Node.js to PATH for this session (must be first for child processes)
set "PATH=%NODE_PATH%;%PATH%"

echo Installing root dependencies...
call "%NODE_PATH%\npm.cmd" install
if errorlevel 1 (
    echo Failed to install root dependencies
    pause
    exit /b 1
)

echo.
echo Installing backend dependencies...
cd backend
call "%NODE_PATH%\npm.cmd" install
if errorlevel 1 (
    echo Failed to install backend dependencies
    pause
    exit /b 1
)

echo.
echo Generating Prisma client...
set "PATH=%NODE_PATH%;%PATH%"
call "%NODE_PATH%\npm.cmd" run prisma:generate
if errorlevel 1 (
    echo Failed to generate Prisma client
    pause
    exit /b 1
)

echo.
echo Running database migrations...
set "PATH=%NODE_PATH%;%PATH%"
call "%NODE_PATH%\npm.cmd" run prisma:migrate -- --name init
if errorlevel 1 (
    echo Failed to run migrations
    pause
    exit /b 1
)

cd ..

echo.
echo Installing frontend dependencies...
cd ..\frontend
call "%NODE_PATH%\npm.cmd" install
if errorlevel 1 (
    echo Failed to install frontend dependencies
    pause
    exit /b 1
)

cd ..

echo.
echo ===================================
echo Setup complete!
echo ===================================
echo.
echo To start the application, run:
echo   start-dev.bat
echo.
echo Or manually run:
echo   npm run dev
echo.
echo This will start:
echo   - Backend on http://localhost:3001
echo   - Frontend on http://localhost:3000
echo.
pause

