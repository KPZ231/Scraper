"""
Google Maps Business Scraper
=============================
Scrapes business listings from Google Maps and identifies leads without websites.

Usage:
    python gmaps_scraper.py "car repair Warsaw"
    python gmaps_scraper.py "car repair Warsaw" --limit 50
    python gmaps_scraper.py "car repair Warsaw" --limit 100 --headless
    python gmaps_scraper.py "car repair Warsaw" --proxy http://user:pass@host:port
"""

# ─────────────────────────────────────────────
#  CONFIG
# ─────────────────────────────────────────────
DEFAULT_LIMIT        = 100          # max businesses to scrape
HEADLESS             = True         # set False to watch the browser
MIN_DELAY            = 2.0          # seconds
MAX_DELAY            = 6.0          # seconds
SCROLL_PAUSE         = 1.5          # seconds between scroll steps
SCROLL_ATTEMPTS      = 30           # max scroll iterations per results panel
PAGE_TIMEOUT         = 30_000       # ms – Playwright page / element timeout
NAV_TIMEOUT          = 60_000       # ms – navigation timeout
DB_PATH              = "gmaps.db"
CSV_PATH             = "leads_no_website.csv"
DEBUG_SCREENSHOT     = "debug_search.png"   # saved on search failure
USER_AGENT           = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)
VIEWPORT             = {"width": 1280, "height": 900}
GOOGLE_MAPS_BASE_URL = "https://www.google.com/maps/search/"
# ─────────────────────────────────────────────

import argparse
import asyncio
import csv
import logging
import random
import re
import sqlite3
import sys
import time
from dataclasses import dataclass, field, fields, asdict
from typing import Optional

from playwright.async_api import (
    async_playwright,
    Browser,
    BrowserContext,
    Page,
    TimeoutError as PlaywrightTimeoutError,
)

# ── Logging ──────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("gmaps_scraper")


# ── Data model ───────────────────────────────
@dataclass
class Business:
    name:          str             = ""
    address:       str             = ""
    phone:         str             = ""
    email:         str             = ""
    website:       str             = ""
    rating:        str             = ""
    reviews:       str             = ""
    category:      str             = ""
    maps_url:      str             = ""
    is_lead:       bool            = False   # True  → no website found


# ── Helpers ───────────────────────────────────

def _random_delay(min_s: float = MIN_DELAY, max_s: float = MAX_DELAY) -> None:
    """Block for a random interval to mimic human pacing."""
    time.sleep(random.uniform(min_s, max_s))


async def _safe_text(page: Page, selector: str, default: str = "") -> str:
    """Return inner-text of the first matching element, or *default* on miss."""
    try:
        el = await page.query_selector(selector)
        if el:
            return (await el.inner_text()).strip()
    except Exception:
        pass
    return default


async def _safe_attr(page: Page, selector: str, attr: str, default: str = "") -> str:
    """Return an attribute value, or *default* on miss."""
    try:
        el = await page.query_selector(selector)
        if el:
            val = await el.get_attribute(attr)
            return (val or "").strip()
    except Exception:
        pass
    return default


# ── Database ──────────────────────────────────

def init_db(db_path: str = DB_PATH) -> sqlite3.Connection:
    """Create (or open) the SQLite database and ensure the schema exists."""
    conn = sqlite3.connect(db_path)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS businesses (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            name     TEXT,
            address  TEXT,
            phone    TEXT,
            email    TEXT,
            website  TEXT,
            rating   TEXT,
            reviews  TEXT,
            category TEXT,
            maps_url TEXT UNIQUE,
            is_lead  INTEGER DEFAULT 0
        )
    """)
    conn.commit()
    return conn


def save_to_db(conn: sqlite3.Connection, biz: Business) -> None:
    """
    Upsert a Business record.
    Uses maps_url as the natural key – re-running the scraper won't create duplicates.
    """
    try:
        conn.execute(
            """
            INSERT INTO businesses
                (name, address, phone, email, website, rating, reviews, category, maps_url, is_lead)
            VALUES
                (:name, :address, :phone, :email, :website, :rating, :reviews, :category, :maps_url, :is_lead)
            ON CONFLICT(maps_url) DO UPDATE SET
                name     = excluded.name,
                address  = excluded.address,
                phone    = excluded.phone,
                email    = excluded.email,
                website  = excluded.website,
                rating   = excluded.rating,
                reviews  = excluded.reviews,
                category = excluded.category,
                is_lead  = excluded.is_lead
            """,
            {**asdict(biz), "is_lead": int(biz.is_lead)},
        )
        conn.commit()
    except sqlite3.Error as exc:
        log.error("DB write error: %s", exc)


def export_csv(conn: sqlite3.Connection, csv_path: str = CSV_PATH) -> int:
    """Write all leads (no website) to a CSV file.  Returns row count."""
    cursor = conn.execute(
        "SELECT name, address, phone, email, rating, reviews, category, maps_url "
        "FROM businesses WHERE is_lead = 1 ORDER BY name"
    )
    rows = cursor.fetchall()
    headers = ["name", "address", "phone", "email", "rating", "reviews", "category", "maps_url"]
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=headers)
        writer.writeheader()
        for row in rows:
            writer.writerow(dict(zip(headers, row)))
    return len(rows)


# ── Playwright helpers ────────────────────────

async def build_context(
    browser: Browser,
    proxy: Optional[str] = None,
) -> BrowserContext:
    """
    Create a browser context with a realistic fingerprint.
    Proxy structure is wired in even when unused – swap in `proxy` param to activate.
    """
    ctx_opts: dict = {
        "user_agent": USER_AGENT,
        "viewport": VIEWPORT,
        # Use a locale consistent with the timezone so Google's consent flow
        # matches what the browser reports (mismatch can cause redirect loops).
        "locale": "pl-PL",
        "timezone_id": "Europe/Warsaw",
        "java_script_enabled": True,
    }
    if proxy:
        # Format: http://user:pass@host:port  or  http://host:port
        parts = proxy.replace("http://", "").replace("https://", "")
        if "@" in parts:
            creds, host_port = parts.rsplit("@", 1)
            username, password = creds.split(":", 1)
            ctx_opts["proxy"] = {
                "server": f"http://{host_port}",
                "username": username,
                "password": password,
            }
        else:
            ctx_opts["proxy"] = {"server": f"http://{parts}"}

    ctx = await browser.new_context(**ctx_opts)
    # Mask navigator.webdriver
    await ctx.add_init_script(
        "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
    )
    return ctx


# ── Core scraping functions ───────────────────

async def _dismiss_consent(page: Page) -> None:
    """
    Handle Google's consent / cookie wall (consent.google.com).

    Google routes EU users through a separate consent subdomain before
    redirecting back to Maps.  We try every known button label so the
    scraper works regardless of which language Google picks.
    """
    consent_labels = [
        # English
        "Accept all", "Reject all", "Accept",
        # Polish
        "Zaakceptuj wszystko", "Odrzuć wszystko", "Akceptuję",
        # German / French / Spanish (common fallbacks Google uses in EU)
        "Alle akzeptieren", "Tout accepter", "Aceptar todo",
    ]
    for label in consent_labels:
        try:
            btn = page.locator(f'button:has-text("{label}")')
            if await btn.first.is_visible(timeout=2_000):
                log.info("Consent dialog found – clicking '%s'", label)
                await btn.first.click()
                # Give Maps time to redirect back and start rendering
                await asyncio.sleep(3)
                return
        except Exception:
            continue


# ── Result-panel selectors (ordered most-specific → most-generic) ─────────
# Google Maps redesigns the DOM periodically; we try each in sequence.
_FEED_SELECTORS = [
    'div[role="feed"]',                   # standard results feed
    'div[aria-label*="Results for"]',     # labelled wrapper (EN)
    'div[aria-label*="Wyniki"]',          # Polish: "Wyniki dla …"
    'div[aria-label*="results" i]',       # case-insensitive fallback
    'div.m6QErb',                         # Maps internal class (stable as of 2024)
    'div[jsrenderer="yGCpXd"]',           # another internal renderer attr
]


async def _wait_for_results_panel(page: Page) -> bool:
    """
    Try each known selector until the results panel appears.
    Returns True and logs which selector matched, or False on complete failure.
    """
    for sel in _FEED_SELECTORS:
        try:
            await page.wait_for_selector(sel, timeout=8_000)
            log.info("Results panel found via selector: %s", sel)
            return True
        except PlaywrightTimeoutError:
            continue
        except Exception as exc:
            log.debug("Selector '%s' error: %s", sel, exc)
    return False


async def search(page: Page, query: str) -> bool:
    """
    Navigate to Google Maps with the search query.

    Key changes vs original:
    - Uses 'networkidle' wait so JS-heavy Maps fully initialises before we
      probe for the results panel.  Falls back to 'domcontentloaded' on
      timeout so slow connections still progress.
    - Calls _dismiss_consent() which handles the EU consent subdomain that
      was blocking Polish users entirely.
    - Tries multiple result-panel selectors via _wait_for_results_panel().
    - Saves a debug screenshot when everything fails so you can see exactly
      what the browser got stuck on.
    """
    url = GOOGLE_MAPS_BASE_URL + query.replace(" ", "+")
    log.info("Navigating → %s", url)

    for attempt in range(2):
        try:
            # 'networkidle' is more reliable for Maps; falls back if too slow
            wait_until = "networkidle" if attempt == 0 else "domcontentloaded"
            await page.goto(url, timeout=NAV_TIMEOUT, wait_until=wait_until)
            log.info("Page loaded (wait_until=%s).", wait_until)

            # ── Consent wall (EU / Poland) ────────────────────────────────
            # consent.google.com intercepts the navigation before Maps loads.
            # We must dismiss it before probing for the results panel.
            await _dismiss_consent(page)

            # After consent, Maps may redirect; wait briefly for that.
            await asyncio.sleep(2)

            # ── Wait for results panel ────────────────────────────────────
            if await _wait_for_results_panel(page):
                return True

            # Nothing matched – dump a screenshot for manual inspection
            log.warning(
                "No results panel found on attempt %d. Current URL: %s",
                attempt + 1, page.url,
            )

        except PlaywrightTimeoutError:
            log.warning("Navigation timed out on attempt %d.", attempt + 1)
        except Exception as exc:
            log.error("search() unexpected error: %s", exc)

        if attempt == 0:
            await asyncio.sleep(3)

    # All attempts failed → save debug screenshot
    try:
        await page.screenshot(path=DEBUG_SCREENSHOT, full_page=False)
        log.error(
            "Could not load results panel after 2 attempts. "
            "Screenshot saved to '%s' – open it to see what the browser got.",
            DEBUG_SCREENSHOT,
        )
    except Exception:
        pass

    return False


async def scroll_results(page: Page, limit: int) -> list[str]:
    """
    Scroll the left-hand results panel until we have at least *limit* listing
    URLs or the panel signals 'end of results'.

    Uses the same multi-selector fallback as search() to locate the scrollable
    feed container, then scrolls it incrementally.  Falls back to mouse-wheel
    on the whole page if the container can't be found.

    Returns a deduplicated list of listing hrefs.
    """
    card_sel   = 'a[href*="/maps/place/"]'
    # Google shows this text (in various languages) at the bottom of the list
    end_markers = [
        "You've reached the end of the list",   # English
        "Dotarłeś do końca listy",              # Polish
        "Ende der Liste",                       # German
    ]

    collected: list[str] = []
    seen: set[str] = set()

    # Locate the scrollable feed element (try all known selectors)
    feed_el = None
    for sel in _FEED_SELECTORS:
        feed_el = await page.query_selector(sel)
        if feed_el:
            log.debug("Scroll container found: %s", sel)
            break

    for attempt in range(SCROLL_ATTEMPTS):
        # Gather all listing anchors currently in the DOM
        anchors = await page.query_selector_all(card_sel)
        for a in anchors:
            href = await a.get_attribute("href") or ""
            if href and href not in seen:
                seen.add(href)
                collected.append(href)

        log.info("Scroll %d/%d – %d listings found", attempt + 1, SCROLL_ATTEMPTS, len(collected))

        if len(collected) >= limit:
            break

        # Check for end-of-results sentinel (any language)
        page_text = await page.inner_text("body")
        if any(marker in page_text for marker in end_markers):
            log.info("Reached end of results.")
            break

        # Scroll the feed container; fall back to window mouse-wheel
        try:
            if feed_el:
                await feed_el.evaluate("el => el.scrollBy(0, 800)")
            else:
                await page.mouse.wheel(0, 800)
        except Exception as exc:
            log.warning("Scroll error (non-fatal): %s", exc)
            # Container reference may be stale after navigation; re-acquire
            for sel in _FEED_SELECTORS:
                feed_el = await page.query_selector(sel)
                if feed_el:
                    break

        await asyncio.sleep(SCROLL_PAUSE + random.uniform(0, 1))

    return collected[:limit]


async def extract_business_data(page: Page, url: str) -> Optional[Business]:
    """
    Open a single Maps listing and extract all fields.
    Retries once on timeout.
    """
    for attempt in range(2):
        try:
            await page.goto(url, timeout=NAV_TIMEOUT, wait_until="domcontentloaded")
            # Wait for the business name heading – signals the panel loaded
            await page.wait_for_selector('h1', timeout=PAGE_TIMEOUT)
            await asyncio.sleep(random.uniform(0.8, 1.8))  # small extra wait for lazy data

            biz = Business(maps_url=page.url)

            # ── Name ──────────────────────────────────────────────────────────
            biz.name = await _safe_text(page, "h1")

            # ── Category ──────────────────────────────────────────────────────
            # The category sits in the first button after the name block
            biz.category = await _safe_text(
                page,
                'button[jsaction*="category"],'
                'span.DkEaL,'          # common selector variant
                'button[aria-label*="category"]',
            )

            # ── Rating ────────────────────────────────────────────────────────
            biz.rating = await _safe_text(
                page,
                'span[aria-label*="stars"], div[aria-label*="stars"], '
                'span.MW4etd',
            )

            # ── Review count ──────────────────────────────────────────────────
            biz.reviews = await _safe_text(
                page,
                'span[aria-label*="reviews"], span.UY7F9',
            )
            # Strip parentheses: "(123)" → "123"
            biz.reviews = biz.reviews.strip("()")

            # ── Address ───────────────────────────────────────────────────────
            # Google uses data-item-id attributes on info rows
            addr_el = await page.query_selector(
                '[data-item-id="address"] .Io6YTe,'
                'button[data-tooltip="Copy address"] .Io6YTe,'
                'button[aria-label*="Address"] .Io6YTe',
            )
            if addr_el:
                biz.address = (await addr_el.inner_text()).strip()

            # ── Phone ─────────────────────────────────────────────────────────
            phone_el = await page.query_selector(
                '[data-item-id^="phone"] .Io6YTe,'
                'button[data-tooltip="Copy phone number"] .Io6YTe,'
                'a[href^="tel:"]',
            )
            if phone_el:
                biz.phone = (await phone_el.inner_text()).strip()
            if not biz.phone:
                # Fallback: grab from tel: href
                tel_href = await _safe_attr(page, 'a[href^="tel:"]', "href")
                biz.phone = tel_href.replace("tel:", "").strip()

            # ── Email ─────────────────────────────────────────────────────────
            # Google Maps does not have a dedicated email field.  We look for
            # mailto: links first (sometimes added by the business owner via
            # Google Business Profile).  If none found, we scan the full page
            # text with a regex as a last-resort fallback.
            email_href = await _safe_attr(page, 'a[href^="mailto:"]', "href")
            if email_href:
                biz.email = email_href.replace("mailto:", "").split("?")[0].strip()
            else:
                # Regex scan of visible page text – catches emails rendered as
                # plain text rather than mailto links.
                try:
                    body_text = await page.inner_text("body")
                    match = re.search(
                        r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}",
                        body_text,
                    )
                    if match:
                        candidate = match.group(0)
                        # Filter out Google's own addresses and image/asset filenames
                        if not any(
                            skip in candidate.lower()
                            for skip in ("google", "gstatic", "googleapis", "example")
                        ):
                            biz.email = candidate
                except Exception:
                    pass

            # ── Website ───────────────────────────────────────────────────────
            web_el = await page.query_selector(
                'a[data-item-id="authority"],'
                'a[aria-label*="website" i],'
                'a[href]:not([href*="google"]):not([href*="maps"]) .Io6YTe',
            )
            if web_el:
                href = await web_el.get_attribute("href") or ""
                # Filter out internal Google redirect-style links
                if href and "google.com" not in href and "maps" not in href:
                    biz.website = href
                else:
                    # Could be a redirect like /url?q=https://...
                    if "url?q=" in href:
                        biz.website = href.split("url?q=")[-1].split("&")[0]
                    else:
                        biz.website = await web_el.inner_text()

            biz.is_lead = not bool(biz.website.strip())
            return biz

        except PlaywrightTimeoutError:
            if attempt == 0:
                log.warning("Timeout on %s – retrying…", url)
                await asyncio.sleep(random.uniform(3, 5))
            else:
                log.error("Timeout on %s – skipping.", url)
                return None
        except Exception as exc:
            log.error("extract_business_data() error for %s: %s", url, exc)
            return None

    return None


# ── Orchestrator ──────────────────────────────

async def run(
    query:    str,
    limit:    int            = DEFAULT_LIMIT,
    headless: bool           = HEADLESS,
    proxy:    Optional[str]  = None,
    db_path:  str            = DB_PATH,
    csv_path: str            = CSV_PATH,
) -> None:
    conn = init_db(db_path)
    log.info("Database ready: %s", db_path)

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=headless,
            args=[
                "--no-sandbox",
                "--disable-blink-features=AutomationControlled",
            ],
        )
        ctx  = await build_context(browser, proxy=proxy)
        page = await ctx.new_page()
        page.set_default_timeout(PAGE_TIMEOUT)

        try:
            # ── 1. Navigate & search ──────────────────────────────────────────
            if not await search(page, query):
                log.error("Could not load search results. Aborting.")
                return

            # ── 2. Scroll to collect listing URLs ─────────────────────────────
            log.info("Collecting listing URLs (limit=%d)…", limit)
            urls = await scroll_results(page, limit)
            log.info("Total listings to scrape: %d", len(urls))

            # ── 3. Visit each listing ─────────────────────────────────────────
            leads = 0
            for idx, url in enumerate(urls, start=1):
                log.info("[%d/%d] Scraping: %s", idx, len(urls), url)
                biz = await extract_business_data(page, url)

                if biz:
                    save_to_db(conn, biz)
                    if biz.is_lead:
                        leads += 1
                    log.info(
                        "  %-40s | email: %-28s | website: %-25s | lead: %s",
                        biz.name[:40],
                        biz.email[:28] if biz.email else "—",
                        biz.website[:25] if biz.website else "—",
                        "YES" if biz.is_lead else "no",
                    )

                _random_delay()

            # ── 4. Export CSV of leads ────────────────────────────────────────
            n = export_csv(conn, csv_path)
            log.info("Done. %d businesses scraped, %d leads → %s", len(urls), n, csv_path)

        finally:
            await ctx.close()
            await browser.close()
            conn.close()


# ── CLI entry point ───────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Scrape Google Maps business listings and find leads without a website."
    )
    parser.add_argument(
        "query",
        nargs="?",
        default="car repair Warsaw",
        help='Search query, e.g. "car repair Warsaw"',
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=DEFAULT_LIMIT,
        help=f"Max number of businesses to scrape (default: {DEFAULT_LIMIT})",
    )
    parser.add_argument(
        "--headless",
        action="store_true",
        default=HEADLESS,
        help="Run browser in headless mode",
    )
    parser.add_argument(
        "--proxy",
        type=str,
        default=None,
        help="Optional proxy URL, e.g. http://user:pass@host:port",
    )
    parser.add_argument(
        "--db",
        type=str,
        default=DB_PATH,
        help=f"SQLite database path (default: {DB_PATH})",
    )
    parser.add_argument(
        "--csv",
        type=str,
        default=CSV_PATH,
        help=f"CSV output path for leads (default: {CSV_PATH})",
    )
    args = parser.parse_args()

    asyncio.run(
        run(
            query    = args.query,
            limit    = args.limit,
            headless = args.headless,
            proxy    = args.proxy,
            db_path  = args.db,
            csv_path = args.csv,
        )
    )


if __name__ == "__main__":
    main()
