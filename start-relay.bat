@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [ST Multiplayer Relay] Node.js not found. Please install Node.js 20+ from https://nodejs.org/
    pause
    exit /b 1
)

if not exist node_modules (
    echo [ST Multiplayer Relay] First run - installing dependencies...
    call npm install
    if errorlevel 1 (
        echo [ST Multiplayer Relay] npm install failed.
        pause
        exit /b 1
    )
)

echo [ST Multiplayer Relay] Building...
call npm run build
if errorlevel 1 (
    echo [ST Multiplayer Relay] Build failed.
    pause
    exit /b 1
)

node dist\local.js
pause
