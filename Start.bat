@echo off
setlocal EnableExtensions
title AGT-ERP Server

cd /d "%~dp0"
if errorlevel 1 (
  echo [ERROR] Cannot find repo root.
  pause
  exit /b 1
)

if not exist "apps\agent-erp\" (
  echo [ERROR] Cannot find apps\agent-erp folder.
  pause
  exit /b 1
)

set "PORT=3001"
set "HOST=0.0.0.0"

echo ========================================
echo   AGT-ERP - starting local server
echo ========================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or not in PATH.
  echo Install Node.js 22+ from https://nodejs.org/
  pause
  exit /b 1
)

echo [0/5] Freeing port 3001 if possible...
call :kill_port 3001
timeout /t 1 /nobreak >nul

call :port_in_use 3001
if not errorlevel 1 (
  echo [WARN] Port 3001 is still busy ^(old node process, Access denied to kill^).
  echo        Will start on port 3002 instead.
  set "PORT=3002"
  call :kill_port 3002
)

if not exist "node_modules\" (
  echo [1/5] Installing workspace dependencies...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
) else (
  echo [1/5] Dependencies OK
)

cd apps\agent-erp

if not exist ".env" (
  if exist ".env.example" (
    echo [INFO] Creating .env from .env.example
    copy /Y ".env.example" ".env" >nul
  )
)

echo [2/5] Database sync + seed...
if not exist "node_modules\.prisma\client\index.js" (
  echo        Prisma client missing - running prisma generate...
  call npx prisma generate
  if errorlevel 1 (
    echo [ERROR] prisma generate failed and no existing client found.
    echo         Close all node/AGT-ERP windows, then run Start.bat again.
    pause
    exit /b 1
  )
) else (
  echo        Using existing Prisma client ^(skip generate^)
)

call npx prisma db push --skip-generate
if errorlevel 1 (
  echo [ERROR] prisma db push failed.
  pause
  exit /b 1
)

call npx tsx prisma/seed.ts
if errorlevel 1 (
  echo [ERROR] Database seed failed.
  pause
  exit /b 1
)

echo [3/5] Building frontend...
call npm run build
if errorlevel 1 (
  echo [ERROR] Frontend build failed.
  pause
  exit /b 1
)

echo [4/5] Starting server on http://localhost:%PORT%
echo.
echo Keep this window open while using the app.
echo Press Ctrl+C to stop the server.
echo.
echo Tip: If two servers are running, use THIS window's URL above.
echo      Close old black consoles / Task Manager -^> end leftover node.exe
echo      if you want port 3001 back.
echo.

echo [5/5] Opening browser...
start "" "http://localhost:%PORT%"

set PORT=%PORT%
set HOST=%HOST%
call npm run serve
if errorlevel 1 (
  echo.
  echo [ERROR] Server failed to start on port %PORT%.
  pause
  exit /b 1
)

echo.
echo Server stopped.
pause
endlocal
exit /b 0

:kill_port
set "_PORT=%~1"
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%_PORT%.*LISTENING"') do (
  if not "%%P"=="0" (
    echo        Stopping PID %%P on port %_PORT%...
    taskkill /F /PID %%P >nul 2>&1
    if errorlevel 1 (
      echo        [WARN] Could not stop PID %%P ^(Access denied^).
    )
  )
)
exit /b 0

:port_in_use
netstat -ano | findstr /R /C:":%~1.*LISTENING" >nul 2>&1
exit /b %errorlevel%
