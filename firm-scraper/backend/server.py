"""
Firm Scraper – FastAPI Backend
================================
Refactored production-ready server using the scraper package.
"""

import asyncio
import io
import logging
import uuid
from pathlib import Path
from typing import Any, Optional, Dict

from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

# ── Import scraper package ────────────────────────────────────────────────────
from scraper import (
    Business,
    DEFAULT_LIMIT,
    init_db,
    save_to_db,
    export_csv,
    build_context,
    search,
    scroll_results,
    extract_business_data,
)
from playwright.async_api import async_playwright

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("firm-scraper")

# ── Constants ─────────────────────────────────────────────────────────────────
BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(
    title="Firm Scraper API",
    description="API for scraping business leads from Google Maps",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── In-memory job store ───────────────────────────────────────────────────────
# In production, this should be Redis or a Database.
# {job_id: {status, query, limit, progress, total, leads, results: [], log: []}}
JOBS: Dict[str, Dict[str, Any]] = {}

# ── Request / Response models ─────────────────────────────────────────────────
class ScrapeRequest(BaseModel):
    query: str = Field(..., example="car repair Warsaw")
    limit: int = Field(default=DEFAULT_LIMIT, ge=1, le=500)
    headless: bool = True
    proxy: Optional[str] = None

class JobStatus(BaseModel):
    job_id: str
    status: str
    query: str
    limit: int
    progress: int
    total: int
    leads: int
    log: list[str]
    results: list[dict]

# ── Background scrape task ────────────────────────────────────────────────────

async def run_scrape_task(job_id: str, req: ScrapeRequest) -> None:
    job = JOBS[job_id]
    db_path  = DATA_DIR / f"job_{job_id}.db"
    csv_path = DATA_DIR / f"job_{job_id}_leads.csv"

    def add_log(msg: str):
        logger.info(f"Job {job_id}: {msg}")
        job["log"].append(msg)

    try:
        job["status"] = "running"
        conn = init_db(str(db_path))
        add_log(f"Starting scrape for query: {req.query!r} (limit={req.limit})")

        async with async_playwright() as pw:
            # Render-friendly launch args
            browser = await pw.chromium.launch(
                headless=req.headless,
                args=[
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-blink-features=AutomationControlled",
                ],
            )
            
            try:
                ctx = await build_context(browser, proxy=req.proxy)
                page = await ctx.new_page()
                
                # ── Step 1: Search ───────────────────────────────────────────
                add_log("Searching Google Maps...")
                if not await search(page, req.query):
                    job["status"] = "error"
                    add_log("Failed to load search results.")
                    return

                add_log("Results loaded. Scrolling results...")

                # ── Step 2: Scroll ───────────────────────────────────────────
                urls = await scroll_results(page, req.limit)
                job["total"] = len(urls)
                add_log(f"Found {len(urls)} listings to process.")

                if not urls:
                    job["status"] = "done"
                    add_log("No results found.")
                    return

                # ── Step 3: Extract ──────────────────────────────────────────
                for idx, url in enumerate(urls, 1):
                    # Check if job was deleted
                    if job_id not in JOBS:
                        add_log("Job cancelled.")
                        return

                    biz = await extract_business_data(page, url)
                    if biz:
                        save_to_db(conn, biz)
                        job["results"].append(biz.to_dict())
                        if biz.is_lead:
                            job["leads"] += 1
                        
                        add_log(f"[{idx}/{len(urls)}] Scraped: {biz.name or 'Unknown'} " + 
                                ("(LEAD)" if biz.is_lead else ""))
                    
                    job["progress"] = idx
                    # Yield control to the event loop
                    await asyncio.sleep(0.1)

                # ── Step 4: Finalize ─────────────────────────────────────────
                export_csv(conn, str(csv_path))
                job["status"] = "done"
                job["csv_path"] = str(csv_path)
                add_log(f"Scrape complete. Found {job['leads']} leads.")

            finally:
                await browser.close()
                conn.close()

    except Exception as exc:
        logger.exception(f"Error in job {job_id}")
        if job_id in JOBS:
            job["status"] = "error"
            job["log"].append(f"Unexpected error: {str(exc)}")

# ── Routes ────────────────────────────────────────────────────────────────────

@app.post("/api/scrape", status_code=202)
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
    background_tasks.add_task(run_scrape_task, job_id, req)
    return {"job_id": job_id}

@app.get("/api/jobs")
async def list_jobs():
    return [
        {k: v for k, v in job.items() if k not in ("results", "log")}
        for job in JOBS.values()
    ]

@app.get("/api/jobs/{job_id}", response_model=JobStatus)
async def get_job(job_id: str):
    if job_id not in JOBS:
        raise HTTPException(status_code=404, detail="Job not found")
    return JOBS[job_id]

@app.get("/api/jobs/{job_id}/csv")
async def download_csv(job_id: str):
    if job_id not in JOBS:
        raise HTTPException(status_code=404, detail="Job not found")
    
    job = JOBS[job_id]
    csv_path_str = job.get("csv_path")
    
    if not csv_path_str:
        raise HTTPException(status_code=400, detail="CSV not ready")
        
    csv_path = Path(csv_path_str)
    if not csv_path.exists():
         raise HTTPException(status_code=404, detail="CSV file not found on disk")

    def iter_file():
        with open(csv_path, mode="rb") as f:
            yield from f

    return StreamingResponse(
        iter_file(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="leads_{job_id}.csv"'},
    )

@app.delete("/api/jobs/{job_id}")
async def delete_job(job_id: str):
    if job_id not in JOBS:
        raise HTTPException(status_code=404, detail="Job not found")
    
    # Cleanup files
    job = JOBS[job_id]
    db_path = DATA_DIR / f"job_{job_id}.db"
    csv_path = DATA_DIR / f"job_{job_id}_leads.csv"
    
    try:
        if db_path.exists(): db_path.unlink()
        if csv_path.exists(): csv_path.unlink()
    except Exception as e:
        logger.error(f"Failed to delete files for job {job_id}: {e}")

    del JOBS[job_id]
    return {"deleted": job_id}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)
