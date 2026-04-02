import asyncio
import logging
import random
import re
from typing import Optional, List
from playwright.async_api import (
    Browser,
    BrowserContext,
    Page,
    TimeoutError as PlaywrightTimeoutError,
)

from .constants import (
    USER_AGENT,
    VIEWPORT,
    GOOGLE_MAPS_BASE_URL,
    DEBUG_SCREENSHOT,
    NAV_TIMEOUT,
    PAGE_TIMEOUT,
    SCROLL_ATTEMPTS,
    SCROLL_PAUSE,
)
from .models import Business
from .utils import safe_text, safe_attr

log = logging.getLogger("scraper.engine")

_FEED_SELECTORS = [
    'div[role="feed"]',                   # standard results feed
    'div[aria-label*="Results for"]',     # labelled wrapper (EN)
    'div[aria-label*="Wyniki"]',          # Polish: "Wyniki dla …"
    'div[aria-label*="results" i]',       # case-insensitive fallback
    'div.m6QErb',                         # Maps internal class (stable as of 2024)
    'div[jsrenderer="yGCpXd"]',           # another internal renderer attr
]

async def build_context(
    browser: Browser,
    proxy: Optional[str] = None,
) -> BrowserContext:
    ctx_opts: dict = {
        "user_agent": USER_AGENT,
        "viewport": VIEWPORT,
        "locale": "pl-PL",
        "timezone_id": "Europe/Warsaw",
        "java_script_enabled": True,
    }
    if proxy:
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
    await ctx.add_init_script(
        "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
    )
    return ctx

async def dismiss_consent(page: Page) -> None:
    consent_labels = [
        "Accept all", "Reject all", "Accept",
        "Zaakceptuj wszystko", "Odrzuć wszystko", "Akceptuję",
        "Alle akzeptieren", "Tout accepter", "Aceptar todo",
    ]
    for label in consent_labels:
        try:
            btn = page.locator(f'button:has-text("{label}")')
            if await btn.first.is_visible(timeout=2_000):
                log.info("Consent dialog found – clicking '%s'", label)
                await btn.first.click()
                await asyncio.sleep(3)
                return
        except Exception:
            continue

async def wait_for_results_panel(page: Page) -> bool:
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
    url = GOOGLE_MAPS_BASE_URL + query.replace(" ", "+")
    log.info("Navigating → %s", url)

    for attempt in range(2):
        try:
            wait_until = "networkidle" if attempt == 0 else "domcontentloaded"
            await page.goto(url, timeout=NAV_TIMEOUT, wait_until=wait_until)
            log.info("Page loaded (wait_until=%s).", wait_until)
            await dismiss_consent(page)
            await asyncio.sleep(2)
            if await wait_for_results_panel(page):
                return True
            log.warning("No results panel found on attempt %d.", attempt + 1)
        except PlaywrightTimeoutError:
            log.warning("Navigation timed out on attempt %d.", attempt + 1)
        except Exception as exc:
            log.error("search() unexpected error: %s", exc)

        if attempt == 0:
            await asyncio.sleep(3)

    try:
        await page.screenshot(path=DEBUG_SCREENSHOT, full_page=False)
        log.error("Could not load results panel. Screenshot saved to '%s'", DEBUG_SCREENSHOT)
    except Exception:
        pass
    return False

async def scroll_results(page: Page, limit: int) -> List[str]:
    card_sel   = 'a[href*="/maps/place/"]'
    end_markers = [
        "You've reached the end of the list",
        "Dotarłeś do końca listy",
        "Ende der Liste",
    ]

    collected: List[str] = []
    seen: set[str] = set()

    feed_el = None
    for sel in _FEED_SELECTORS:
        feed_el = await page.query_selector(sel)
        if feed_el:
            break

    for attempt in range(SCROLL_ATTEMPTS):
        anchors = await page.query_selector_all(card_sel)
        for a in anchors:
            href = await a.get_attribute("href") or ""
            if href and href not in seen:
                seen.add(href)
                collected.append(href)

        log.info("Scroll %d/%d – %d listings found", attempt + 1, SCROLL_ATTEMPTS, len(collected))
        if len(collected) >= limit:
            break

        page_text = await page.inner_text("body")
        if any(marker in page_text for marker in end_markers):
            log.info("Reached end of results.")
            break

        try:
            if feed_el:
                await feed_el.evaluate("el => el.scrollBy(0, 800)")
            else:
                await page.mouse.wheel(0, 800)
        except Exception as exc:
            log.warning("Scroll error (non-fatal): %s", exc)
            for sel in _FEED_SELECTORS:
                feed_el = await page.query_selector(sel)
                if feed_el: break

        await asyncio.sleep(SCROLL_PAUSE + random.uniform(0, 1))

    return collected[:limit]

async def extract_business_data(page: Page, url: str) -> Optional[Business]:
    for attempt in range(2):
        try:
            await page.goto(url, timeout=NAV_TIMEOUT, wait_until="domcontentloaded")
            await page.wait_for_selector('h1', timeout=PAGE_TIMEOUT)
            await asyncio.sleep(random.uniform(0.8, 1.8))

            biz = Business(maps_url=page.url)
            biz.name = await safe_text(page, "h1")
            biz.category = await safe_text(page, 'button[jsaction*="category"], span.DkEaL, button[aria-label*="category"]')
            biz.rating = await safe_text(page, 'span[aria-label*="stars"], div[aria-label*="stars"], span.MW4etd')
            biz.reviews = (await safe_text(page, 'span[aria-label*="reviews"], span.UY7F9')).strip("()")

            addr_el = await page.query_selector('[data-item-id="address"] .Io6YTe, button[data-tooltip="Copy address"] .Io6YTe, button[aria-label*="Address"] .Io6YTe')
            if addr_el: biz.address = (await addr_el.inner_text()).strip()

            phone_el = await page.query_selector('[data-item-id^="phone"] .Io6YTe, button[data-tooltip="Copy phone number"] .Io6YTe, a[href^="tel:"]')
            if phone_el: biz.phone = (await phone_el.inner_text()).strip()
            if not biz.phone:
                tel_href = await safe_attr(page, 'a[href^="tel:"]', "href")
                biz.phone = tel_href.replace("tel:", "").strip()

            email_href = await safe_attr(page, 'a[href^="mailto:"]', "href")
            if email_href:
                biz.email = email_href.replace("mailto:", "").split("?")[0].strip()
            else:
                try:
                    body_text = await page.inner_text("body")
                    match = re.search(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}", body_text)
                    if match:
                        candidate = match.group(0)
                        if not any(skip in candidate.lower() for skip in ("google", "gstatic", "googleapis", "example")):
                            biz.email = candidate
                except Exception: pass

            web_el = await page.query_selector('a[data-item-id="authority"], a[aria-label*="website" i], a[href]:not([href*="google"]):not([href*="maps"]) .Io6YTe')
            if web_el:
                href = await web_el.get_attribute("href") or ""
                if href and "google.com" not in href and "maps" not in href:
                    biz.website = href
                elif "url?q=" in href:
                    biz.website = href.split("url?q=")[-1].split("&")[0]
                else:
                    biz.website = await web_el.inner_text()

            biz.is_lead = not bool(biz.website.strip())
            return biz
        except PlaywrightTimeoutError:
            if attempt == 0:
                await asyncio.sleep(random.uniform(3, 5))
            else:
                log.error("Timeout on %s skipping", url)
                return None
        except Exception as exc:
            log.error("extract_business_data() error for %s: %s", url, exc)
            return None
    return None
