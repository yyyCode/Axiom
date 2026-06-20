@echo off
title Axiom Agent Server

echo ======================================
echo   Axiom Agent Server — DeepSeek Mode
echo ======================================
echo.

echo [1/3] Checking Node.js...
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js not found! Please install Node.js first.
    pause
    exit /b
)
node -v
echo.

echo [2/3] Installing dependencies (if needed)...
if not exist "node_modules" (
    echo Running npm install...
    call npm install
)
echo.

echo [3/3] Building TypeScript...
call npx tsc
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] TypeScript build failed! Check errors above.
    pause
    exit /b
)
echo Build OK.
echo.

set PROVIDER_TYPE=deepseek
set DEEPSEEK_API_KEY=your-deepseek-api-key-here
set MODEL=deepseek-v4-flash
set PORT=3000
set DATA_DIR=./data

echo ======================================
echo   Starting server...
echo   Provider: %PROVIDER_TYPE%
echo   Model:    %MODEL%
echo   URL:      http://localhost:%PORT%
echo ======================================
echo.

node dist/start.js

echo.
echo Server stopped.
pause
