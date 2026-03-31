# FirmScraper

Google Maps Lead Generator – React frontend + FastAPI backend + Playwright scraper.

```
firm-scraper/
├── backend/
│   ├── server.py          ← FastAPI app
│   └── requirements.txt
├── frontend/
│   ├── index.html
│   ├── vite.config.js
│   ├── package.json
│   └── src/
│       ├── main.jsx
│       ├── App.jsx
│       └── index.css
└── gmaps_scraper.py       ← scraper (musi być w katalogu nadrzędnym)
```

---

## Struktura katalogów

Umieść `gmaps_scraper.py` **jeden poziom wyżej** niż `firm-scraper/`:

```
projekt/
├── gmaps_scraper.py       ← skrypt scrapera
└── firm-scraper/
    ├── backend/
    └── frontend/
```

---

## Instalacja i uruchomienie

### 1. Backend (FastAPI)

```bash
cd firm-scraper/backend

# Utwórz i aktywuj virtualenv
python -m venv .venv
source .venv/bin/activate        # Linux/macOS
.venv\Scripts\activate           # Windows

# Zainstaluj zależności
pip install -r requirements.txt

# Zainstaluj przeglądarkę Playwright
playwright install chromium

# Uruchom serwer
uvicorn server:app --reload --port 8000
```

Backend dostępny pod: http://localhost:8000

### 2. Frontend (React + Vite)

W **nowym terminalu**:

```bash
cd firm-scraper/frontend

npm install
npm run dev
```

Frontend dostępny pod: http://localhost:5173

---

## Użytkowanie

1. Otwórz http://localhost:5173
2. Wpisz frazę, np. `mechanik samochodowy Rybnik`
3. Ustaw limit firm (domyślnie 50)
4. Kliknij **▶ Skanuj**
5. Obserwuj logi w czasie rzeczywistym
6. Po zakończeniu pobierz CSV z leadami (firmy bez strony WWW)

---

## API (FastAPI)

| Metoda | Endpoint | Opis |
|--------|----------|------|
| POST | `/api/scrape` | Uruchom nowe zadanie |
| GET | `/api/jobs` | Lista wszystkich zadań |
| GET | `/api/jobs/{id}` | Status + wyniki zadania |
| GET | `/api/jobs/{id}/csv` | Pobierz CSV leadów |
| DELETE | `/api/jobs/{id}` | Usuń zadanie |

Dokumentacja Swagger: http://localhost:8000/docs

---

## Uwagi

- Zadania działają w tle – można uruchomić kilka jednocześnie
- Wyniki są trzymane w pamięci serwera (restart = reset); baza SQLite zapisywana na dysk
- Proxy można ustawić przez panel „Zaawansowane" w UI
