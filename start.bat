@echo off
setlocal enabledelayedexpansion

pushd "%~dp0"

echo ======================================================================
echo   WISSENSRAUM -- Startskript fuer Windows
echo ======================================================================
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
  echo [FEHLER] Node.js wurde nicht im PATH gefunden.
  echo Bitte installiere Node.js von https://nodejs.org/
  pause
  popd
  exit /b 1
)

if not exist ".env" (
  echo [INFO] .env nicht gefunden. Erstelle lokale Konfiguration...
  node -e "const crypto = require('crypto'); const enc = crypto.randomBytes(32).toString('hex'); const jwt = crypto.randomBytes(32).toString('hex'); const fs = require('fs'); const c = '# Lokale Konfiguration\nNODE_ENV=development\nHOST=127.0.0.1\nPORT=3000\nAPP_ORIGIN=http://127.0.0.1:3000\nTRUST_PROXY_HOPS=0\nDATA_DIR=var\nAPP_ENCRYPTION_KEY=' + enc + '\nJWT_MODE=secret\nJWT_ALGORITHM=HS256\nJWT_ISSUER=https://identity.local/\nJWT_AUDIENCE=wissensraum\nJWT_SECRET=' + jwt + '\nJWT_MAX_AGE_SECONDS=86400\nAUTH_LOGIN_URL=\nUPLOAD_MAX_MB=20\nCRAWL_MAX_PAGES=40\nRAG_MIN_SCORE=0.3\nALLOW_UPDATES=false\nUPDATE_REPOSITORY=\nUPDATE_BRANCH=main\nPM2_APP_PREFIX=wissensraum\n'; fs.writeFileSync('.env', c, 'utf8');"
  echo [OK] .env erfolgreich erstellt.
)

if not exist "node_modules" (
  echo [INFO] Abhaengigkeiten fehlen. Fuehre 'npm install' aus...
  call npm install
  if %errorlevel% neq 0 (
    echo [FEHLER] 'npm install' ist fehlgeschlagen.
    pause
    popd
    exit /b 1
  )
)

echo [INFO] Fuehre Datenbankmigrationen aus...
call npm run db:migrate
if %errorlevel% neq 0 (
  echo [FEHLER] Datenbankmigration fehlgeschlagen.
  pause
  popd
  exit /b 1
)

if not exist "dist\index.html" (
  echo [INFO] Frontend wird fuer den ersten Start gebaut...
  call npm run build
  if %errorlevel% neq 0 (
    echo [FEHLER] Frontend-Build fehlgeschlagen.
    pause
    popd
    exit /b 1
  )
)

echo.
echo ======================================================================
echo   ANMELDUNG / TEST-ZUGANG
echo ======================================================================
call npm run token
echo.

echo [INFO] Oeffne Browser mit Test-Zugang...
if exist "var\login_url.txt" (
  set /p LOGIN_URL=<"var\login_url.txt"
  start "" "!LOGIN_URL!"
) else (
  start "" "http://127.0.0.1:3000"
)

echo [INFO] Starte Server und Hintergrund-Worker...
echo Druecke [Strg + C] im Fenster, um den Server zu beenden.
echo.
call npm run serve

popd
pause