# Google Maps Business Scraper

## Requirements
- Python 3.11+
- pip

---

## Installation

```bash
# 1. Create and activate a virtual environment (recommended)
python -m venv .venv
source .venv/bin/activate        # Linux / macOS
.venv\Scripts\activate           # Windows

# 2. Install Python dependencies
pip install -r requirements.txt

# 3. Install Playwright's Chromium browser
playwright install chromium
```

---

## Usage

```bash
# Basic – uses default query "car repair Warsaw", limit 100
python gmaps_scraper.py

# Custom query
python gmaps_scraper.py "dentist London"

# Limit results
python gmaps_scraper.py "dentist London" --limit 50

# Run with visible browser (useful for debugging)
python gmaps_scraper.py "dentist London" --limit 20
# (remove --headless from the CLI or set HEADLESS=False in the CONFIG block)

# Use a proxy
python gmaps_scraper.py "dentist London" --proxy http://user:pass@1.2.3.4:8080

# Custom output paths
python gmaps_scraper.py "dentist London" --db my_data.db --csv my_leads.csv
```

---

## Output

| File                    | Description                                         |
|-------------------------|-----------------------------------------------------|
| `gmaps.db`              | SQLite database with all scraped businesses         |
| `leads_no_website.csv`  | CSV of businesses with no website (your leads)      |

### SQLite schema
```
businesses(id, name, address, phone, website, rating, reviews, category, maps_url, is_lead)
```

Query all leads directly:
```bash
sqlite3 gmaps.db "SELECT name, address, phone FROM businesses WHERE is_lead=1;"
```

---

## Configuration

Edit the `CONFIG` block at the top of `gmaps_scraper.py`:

| Variable             | Default | Purpose                                  |
|----------------------|---------|------------------------------------------|
| `DEFAULT_LIMIT`      | 100     | Max businesses per run                   |
| `HEADLESS`           | True    | Show/hide browser                        |
| `MIN_DELAY`          | 2.0 s   | Min random delay between listings        |
| `MAX_DELAY`          | 6.0 s   | Max random delay between listings        |
| `SCROLL_PAUSE`       | 1.5 s   | Pause between panel scroll steps         |
| `SCROLL_ATTEMPTS`    | 30      | Max scroll iterations before stopping    |
| `PAGE_TIMEOUT`       | 30 000  | Element wait timeout (ms)                |
| `NAV_TIMEOUT`        | 60 000  | Page navigation timeout (ms)             |

---

## Notes

- Google Maps HTML structure changes frequently. If selectors break, inspect
  the page with `headless=False` and update the CSS selectors in
  `extract_business_data()`.
- The scraper uses `maps_url` as a unique key — re-running the same query
  updates existing records rather than creating duplicates.
- Proxy support is fully wired; pass any `http://[user:pass@]host:port` string
  via `--proxy`.
