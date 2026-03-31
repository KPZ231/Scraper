@echo off
REM ─────────────────────────────────────────────────────────────────
REM  FirmScraper – Windows start script
REM  Uruchamia backend i frontend w osobnych oknach cmd.
REM ─────────────────────────────────────────────────────────────────

SET ROOT=%~dp0
SET BACKEND=%ROOT%backend
SET FRONTEND=%ROOT%frontend
SET SCRAPER=%ROOT%..\gmaps_scraper.py

IF NOT EXIST "%SCRAPER%" (
    echo [BLAD] Nie znaleziono gmaps_scraper.py w katalogu nadrzednym.
    echo Upewnij sie ze struktura wyglada tak:
    echo.
    echo   projekt\
    echo   +-- gmaps_scraper.py
    echo   +-- firm-scraper\
    echo       +-- start.bat
    pause
    exit /b 1
)

REM ── backend venv ──────────────────────────────────────────────────
IF NOT EXIST "%BACKEND%\.venv" (
    echo Tworzenie virtualenv...
    python -m venv "%BACKEND%\.venv"
    call "%BACKEND%\.venv\Scripts\activate.bat"
    pip install -q -r "%BACKEND%\requirements.txt"
    playwright install chromium
) ELSE (
    call "%BACKEND%\.venv\Scripts\activate.bat"
)

REM ── frontend node_modules ─────────────────────────────────────────
IF NOT EXIST "%FRONTEND%\node_modules" (
    echo Instalacja zależności frontendu...
    cd /d "%FRONTEND%"
    npm install --silent
)

REM ── launch ────────────────────────────────────────────────────────
echo.
echo Uruchamianie backendu...
start "FirmScraper Backend" cmd /k "cd /d %BACKEND% && call .venv\Scripts\activate.bat && uvicorn server:app --port 8000"

timeout /t 2 /nobreak >nul

echo Uruchamianie frontendu...
start "FirmScraper Frontend" cmd /k "cd /d %FRONTEND% && npm run dev"

echo.
echo Backend  -^> http://localhost:8000
echo Frontend -^> http://localhost:5173
echo.
pause
