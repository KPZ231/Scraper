import random
import time
from playwright.async_api import Page
from .constants import MIN_DELAY, MAX_DELAY

def random_delay(min_s: float = MIN_DELAY, max_s: float = MAX_DELAY) -> None:
    """Block for a random interval to mimic human pacing."""
    time.sleep(random.uniform(min_s, max_s))


async def safe_text(page: Page, selector: str, default: str = "") -> str:
    """Return inner-text of the first matching element, or *default* on miss."""
    try:
        el = await page.query_selector(selector)
        if el:
            return (await el.inner_text()).strip()
    except Exception:
        pass
    return default


async def safe_attr(page: Page, selector: str, attr: str, default: str = "") -> str:
    """Return an attribute value, or *default* on miss."""
    try:
        el = await page.query_selector(selector)
        if el:
            val = await el.get_attribute(attr)
            return (val or "").strip()
    except Exception:
        pass
    return default
