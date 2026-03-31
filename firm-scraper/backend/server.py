"""
Firm Scraper – FastAPI Backend
================================
Wraps gmaps_scraper.py and exposes:

  POST /api/scrape          – start a scrape job
  GET  /api/jobs            – list all jobs
  GET  /api/jobs/{job_id}   – job status + results
  GET  /api/jobs/{job_id}/csv – download leads CSV
  DELETE /api/jobs/{job_id} – remove job

Run:
    uvicorn server:app --reload --port 8000
"""

import asyncio
import csv
import io
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

# ── import scraper functions ──────────────────────────────────────────────────
import sys
sys.path.insert(0, str(Path(__file__).parent.parent))

from gmaps_scraper import (
    init_db, save_to_db, export_csv,
    search, scroll_results, extract_business_data,
    build_context, Business,
    DEFAULT_LIMIT, HEADLESS,
)
from playwright.async_api import async_playwright

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(title="Firm Scraper API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── In-memory job store ───────────────────────────────────────────────────────
# {job_id: {status, query, limit, progress, total, results: [], log: []}}
JOBS: dict[str, dict[str, Any]] = {}


# ── Request / Response models ─────────────────────────────────────────────────
class ScrapeRequest(BaseModel):
    query: str
    limit: int = DEFAULT_LIMIT
    headless: bool = True
    proxy: Optional[str] = None


class JobStatus(BaseModel):
    job_id: str
    status: str          # pending | running | done | error
    query: str
    limit: int
    progress: int
    total: int
    leads: int
    log: list[str]
    results: list[dict]


# ── Background scrape task ────────────────────────────────────────────────────

async def run_scrape(job_id: str, req: ScrapeRequest) -> None:
    job = JOBS[job_id]
    db_path  = f"job_{job_id}.db"
    csv_path = f"job_{job_id}_leads.csv"

    def log(msg: str) -> None:
        job["log"].append(msg)

    try:
        job["status"] = "running"
        conn = init_db(db_path)
        log(f"Szukam: {req.query!r} (limit={req.limit})")

        async with async_playwright() as pw:
            browser = await pw.chromium.launch(
                headless=req.headless,
                args=["--no-sandbox", "--disable-blink-features=AutomationControlled"],
            )
            ctx  = await build_context(browser, proxy=req.proxy)
            page = await ctx.new_page()

            # ── search ────────────────────────────────────────────────────────
            ok = await search(page, req.query)
            if not ok:
                job["status"] = "error"
                log("Nie udało się załadować wyników Google Maps.")
                await ctx.close(); await browser.close(); conn.close()
                return

            log("Wyniki załadowane. Przewijam listę…")

            # ── scroll ────────────────────────────────────────────────────────
            urls = await scroll_results(page, req.limit)
            job["total"] = len(urls)
            log(f"Znaleziono {len(urls)} firm do sprawdzenia.")

            # ── extract ───────────────────────────────────────────────────────
            for idx, url in enumerate(urls, 1):
                biz = await extract_business_data(page, url)
                if biz:
                    save_to_db(conn, biz)
                    job["results"].append({
                        "name":     biz.name,
                        "address":  biz.address,
                        "phone":    biz.phone,
                        "email":    biz.email,
                        "website":  biz.website,
                        "rating":   biz.rating,
                        "reviews":  biz.reviews,
                        "category": biz.category,
                        "maps_url": biz.maps_url,
                        "is_lead":  biz.is_lead,
                    })
                    job["leads"] = sum(1 for r in job["results"] if r["is_lead"])
                    log(
                        f"[{idx}/{len(urls)}] {biz.name or '(brak nazwy)'}"
                        + (" ← LEAD" if biz.is_lead else "")
                    )
                job["progress"] = idx
                # small async yield so other requests aren't starved
                await asyncio.sleep(0)

            export_csv(conn, csv_path)
            job["status"]   = "done"
            job["csv_path"] = csv_path
            log(f"Gotowe! Znaleziono {job['leads']} leadów bez strony WWW.")

            await ctx.close()
            await browser.close()
            conn.close()

    except Exception as exc:
        JOBS[job_id]["status"] = "error"
        JOBS[job_id]["log"].append(f"Błąd: {exc}")
        raise


# ── Routes ────────────────────────────────────────────────────────────────────

@app.post("/api/scrape", response_model=dict)
async def start_scrape(req: ScrapeRequest, background_tasks: BackgroundTasks):
    job_id = str(uuid.uuid4())[:8]
    JOBS[job_id] = {
        "job_id":   job_id,
        "status":   "pending",
        "query":    req.query,
        "limit":    req.limit,
        "progress": 0,
        "total":    0,
        "leads":    0,
        "log":      [],
        "results":  [],
        "csv_path": None,
    }
    background_tasks.add_task(run_scrape, job_id, req)
    return {"job_id": job_id}


@app.get("/api/jobs")
async def list_jobs():
    return [
        {k: v for k, v in job.items() if k not in ("results", "log")}
        for job in JOBS.values()
    ]


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str):
    if job_id not in JOBS:
        raise HTTPException(404, "Job not found")
    return JOBS[job_id]


@app.get("/api/jobs/{job_id}/csv")
async def download_csv(job_id: str):
    if job_id not in JOBS:
        raise HTTPException(404, "Job not found")
    job = JOBS[job_id]
    csv_path = job.get("csv_path")
    if not csv_path or not Path(csv_path).exists():
        raise HTTPException(404, "CSV not ready yet")

    content = Path(csv_path).read_text(encoding="utf-8")
    return StreamingResponse(
        io.StringIO(content),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="leads_{job_id}.csv"'},
    )


@app.delete("/api/jobs/{job_id}")
async def delete_job(job_id: str):
    if job_id not in JOBS:
        raise HTTPException(404, "Job not found")
    del JOBS[job_id]
    return {"deleted": job_id}
