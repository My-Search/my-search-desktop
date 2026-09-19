@echo off
REM ============================================================
REM  My Search (Desktop) - launcher (ASCII-named copy)
REM  Double-click to start. Close this window to STOP the app.
REM ============================================================

setlocal
title My Search (Desktop) - close this window to stop

cd /d "%~dp0"

echo.
echo ============================================================
echo   My Search (Desktop) is starting ...
echo   Hotkey: Ctrl+Alt+S  (show / hide the search box)
echo   Close this window to stop the app.
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found. Please install Node.js 18+ from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

where cargo >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Rust/Cargo not found. Please install Rust from https://rustup.rs/
    echo.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo [1/3] First run - installing frontend dependencies ^(npm install^) ...
    call npm install
    if errorlevel 1 (
        echo.
        echo [ERROR] npm install failed. Check your network and try again.
        pause
        exit /b 1
    )
) else (
    echo [1/3] Dependencies found, skipping install.
)

echo [2/3] Cleaning up leftover app instances ...
taskkill /F /IM my-search-desktop.exe >nul 2>nul

echo [3/3] Freeing dev port 1420 if it is occupied ...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":1420" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>nul
)

echo.
echo Starting app - first Rust build may take a few minutes, please wait ...
echo (if the window stays blank, close this window, then run start.bat again)
echo.
call npm run tauri dev

echo.
echo The app has exited.
pause
