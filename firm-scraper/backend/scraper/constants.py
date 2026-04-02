DEFAULT_LIMIT        = 100          # max businesses to scrape
HEADLESS             = True         # set False to watch the browser
MIN_DELAY            = 2.0          # seconds
MAX_DELAY            = 6.0          # seconds
SCROLL_PAUSE         = 1.5          # seconds between scroll steps
SCROLL_ATTEMPTS      = 30           # max scroll iterations per results panel
PAGE_TIMEOUT         = 30_000       # ms – Playwright page / element timeout
NAV_TIMEOUT          = 60_000       # ms – navigation timeout
USER_AGENT           = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)
VIEWPORT             = {"width": 1280, "height": 900}
GOOGLE_MAPS_BASE_URL = "https://www.google.com/maps/search/"
DEBUG_SCREENSHOT     = "debug_search.png"
