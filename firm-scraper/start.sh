#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
#  FirmScraper – one-command start script
#  Uruchamia backend (FastAPI) i frontend (Vite) jednocześnie.
#  Ctrl+C zatrzymuje oba procesy.
# ─────────────────────────────────────────────────────────────────
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"
SCRAPER="$ROOT/../gmaps_scraper.py"

# ── check gmaps_scraper.py ───────────────────────────────────────
if [ ! -f "$SCRAPER" ]; then
  echo "❌  Nie znaleziono gmaps_scraper.py w katalogu nadrzędnym ($ROOT/..)"
  echo "    Upewnij się że struktura katalogów wygląda tak:"
  echo ""
  echo "    projekt/"
  echo "    ├── gmaps_scraper.py"
  echo "    └── firm-scraper/"
  echo "        ├── start.sh   ← jesteś tutaj"
  echo "        ├── backend/"
  echo "        └── frontend/"
  exit 1
fi

# ── backend venv ─────────────────────────────────────────────────
if [ ! -d "$BACKEND/.venv" ]; then
  echo "🐍  Tworzę virtualenv dla backendu..."
  python3 -m venv "$BACKEND/.venv"
  source "$BACKEND/.venv/bin/activate"
  pip install -q -r "$BACKEND/requirements.txt"
  playwright install chromium
  echo "✅  Backend gotowy."
else
  source "$BACKEND/.venv/bin/activate"
fi

# ── frontend node_modules ─────────────────────────────────────────
if [ ! -d "$FRONTEND/node_modules" ]; then
  echo "📦  Instaluję zależności frontendu..."
  cd "$FRONTEND" && npm install --silent
  echo "✅  Frontend gotowy."
fi

# ── launch both ───────────────────────────────────────────────────
echo ""
echo "🚀  Uruchamiam FirmScraper..."
echo "    Backend  → http://localhost:8000"
echo "    Frontend → http://localhost:5173"
echo "    (Ctrl+C zatrzymuje oba)"
echo ""

# Start backend in background
cd "$BACKEND"
uvicorn server:app --port 8000 &
BACKEND_PID=$!

# Start frontend in background
cd "$FRONTEND"
npm run dev &
FRONTEND_PID=$!

# Wait and handle Ctrl+C
trap "echo ''; echo '🛑  Zatrzymuję...'; kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit 0" INT TERM
wait
