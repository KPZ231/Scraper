"""
Firm Scraper – FastAPI Backend (Production)
============================================
Designed for deployment on Render.com.

Key features:
  - SSE (Server-Sent Events) for real-time job progress streaming
  - Job metadata persisted to disk (survives Render cold restarts)
  - Graceful shutdown handling
  - CORS properly configured
  - Health check endpoint for Render health probes
  - Structured JSON logging
"""

import asyncio
import json
import logging
import os
import signal
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator, Dict, Optional

import uvicorn
from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from playwright.async_api import async_playwright
from pydantic import BaseModel, Field

from scraper import (
    DEFAULT_LIMIT,
    build_context,
    export_csv,
    extract_business_data,
    init_db,
    save_to_db,
    scroll_results,
    search,
)

# ── Logging ───────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("firm-scraper")

# ── Paths ─────────────────────────────────────────────────────────────────────

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)

JOBS_META_FILE = DATA_DIR / "jobs_meta.json"

# ── In-memory job store ───────────────────────────────────────────────────────
# { job_id: { status, query, limit, progress, total, leads, log, results, csv_path } }
JOBS: Dict[str, Dict[str, Any]] = {}

# SSE subscriber queues: { job_id: [asyncio.Queue, ...] }
SSE_SUBSCRIBERS: Dict[str, list] = {}


# ── Job persistence (survives Render restarts for GET /api/jobs listing) ──────

def _persist_jobs_meta() -> None:
    """Save lightweight metadata (no results blob) to disk."""
    try:
        meta = {
            jid: {k: v for k, v in job.items() if k not in ("results", "log")}
            for jid, job in JOBS.items()
        }
        JOBS_META_FILE.write_text(json.dumps(meta, default=str), encoding="utf-8")
    except Exception as exc:
        logger.warning("Could not persist jobs meta: %s", exc)


def _load_jobs_meta() -> None:
    """Restore job metadata from disk on startup."""
    if not JOBS_META_FILE.exists():
        return
    try:
        meta: dict = json.loads(JOBS_META_FILE.read_text(encoding="utf-8"))
        for jid, job in meta.items():
            # Mark any previously-running jobs as interrupted
            if job.get("status") == "running":
                job["status"] = "interrupted"
            job.setdefault("results", [])
            job.setdefault("log", [])
            JOBS[jid] = job
        logger.info("Restored %d job(s) from disk.", len(meta))
    except Exception as exc:
        logger.warning("Could not load jobs meta: %s", exc)


# ── SSE helpers ───────────────────────────────────────────────────────────────

def _sse_event(data: Any, event: str = "message") -> str:
    payload = json.dumps(data, default=str)
    return f"event: {event}\ndata: {payload}\n\n"


async def _broadcast(job_id: str, data: Any, event: str = "message") -> None:
    subs = SSE_SUBSCRIBERS.get(job_id, [])
    dead = []
    for q in subs:
        try:
            q.put_nowait((event, data))
        except asyncio.QueueFull:
            dead.append(q)
    for q in dead:
        subs.remove(q)


# ── Lifespan ──────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    _load_jobs_meta()
    logger.info("Firm Scraper API started. Data dir: %s", DATA_DIR)
    yield
    _persist_jobs_meta()
    logger.info("Firm Scraper API shut down cleanly.")


# ── App ───────────────────────────────────────────────────────────────────────

ALLOWED_ORIGINS = os.environ.get(
    "ALLOWED_ORIGINS", "*"
).split(",")

app = FastAPI(
    title="Firm Scraper API",
    description="Scrape business leads from Google Maps",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS", "HEAD"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition"],
)


# ── Pydantic models ───────────────────────────────────────────────────────────

class ScrapeRequest(BaseModel):
    query: str = Field(..., min_length=2, max_length=300, example="naprawa samochodów Warszawa")
    limit: int = Field(default=DEFAULT_LIMIT, ge=1, le=500)
    headless: bool = Field(default=True)
    proxy: Optional[str] = Field(default=None, example="http://user:pass@host:port")


class JobSummary(BaseModel):
    job_id: str
    status: str
    query: str
    limit: int
    progress: int
    total: int
    leads: int
    csv_ready: bool


class JobDetail(JobSummary):
    log: list[str]
    results: list[dict]


# ── Background scrape task ────────────────────────────────────────────────────

async def run_scrape_task(job_id: str, req: ScrapeRequest) -> None:
    job = JOBS[job_id]
    db_path = DATA_DIR / f"job_{job_id}.db"
    csv_path = DATA_DIR / f"job_{job_id}_leads.csv"

    async def log_and_broadcast(msg: str, event: str = "log") -> None:
        logger.info("Job %s: %s", job_id, msg)
        job["log"].append(msg)
        await _broadcast(job_id, {"message": msg}, event=event)

    async def progress_broadcast() -> None:
        await _broadcast(
            job_id,
            {
                "progress": job["progress"],
                "total": job["total"],
                "leads": job["leads"],
            },
            event="progress",
        )

    try:
        job["status"] = "running"
        await _broadcast(job_id, {"status": "running"}, event="status")

        conn = init_db(str(db_path))
        await log_and_broadcast(f"Scrape started – query: {req.query!r}, limit: {req.limit}")

        async with async_playwright() as pw:
            browser = await pw.chromium.launch(
                headless=req.headless,
                args=[
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-blink-features=AutomationControlled",
                    "--single-process",           # important for Render free tier
                ],
            )

            try:
                ctx = await build_context(browser, proxy=req.proxy)
                page = await ctx.new_page()

                # Step 1 – Search
                await log_and_broadcast("Searching Google Maps…")
                if not await search(page, req.query):
                    job["status"] = "error"
                    await log_and_broadcast("Failed to load search results.", event="error")
                    await _broadcast(job_id, {"status": "error"}, event="status")
                    return

                # Step 2 – Scroll
                await log_and_broadcast("Results panel found. Scrolling…")
                urls = await scroll_results(page, req.limit)
                job["total"] = len(urls)

                await log_and_broadcast(f"Found {len(urls)} listings.")
                await progress_broadcast()

                if not urls:
                    job["status"] = "done"
                    await _broadcast(job_id, {"status": "done"}, event="status")
                    return

                # Step 3 – Extract
                for idx, url in enumerate(urls, 1):
                    if job_id not in JOBS:
                        await log_and_broadcast("Job cancelled.")
                        return

                    biz = await extract_business_data(page, url)
                    if biz:
                        save_to_db(conn, biz)
                        biz_dict = biz.to_dict()
                        job["results"].append(biz_dict)
                        if biz.is_lead:
                            job["leads"] += 1

                        # broadcast each result individually so the client can render live
                        await _broadcast(job_id, biz_dict, event="result")
                        await log_and_broadcast(
                            f"[{idx}/{len(urls)}] {biz.name or 'Unknown'}"
                            + (" 🎯 LEAD" if biz.is_lead else "")
                        )

                    job["progress"] = idx
                    await progress_broadcast()
                    await asyncio.sleep(0.05)

                # Step 4 – Finalise
                export_csv(conn, str(csv_path))
                job["status"] = "done"
                job["csv_path"] = str(csv_path)
                await log_and_broadcast(
                    f"Done. {job['leads']} lead(s) found out of {len(urls)} listings.",
                    event="log",
                )
                await _broadcast(job_id, {"status": "done"}, event="status")

            finally:
                await browser.close()
                conn.close()
                _persist_jobs_meta()

    except Exception as exc:
        logger.exception("Unexpected error in job %s", job_id)
        if job_id in JOBS:
            job["status"] = "error"
            job["log"].append(f"Unexpected error: {exc}")
            await _broadcast(job_id, {"status": "error", "message": str(exc)}, event="error")
        _persist_jobs_meta()


# ── Routes ────────────────────────────────────────────────────────────────────

# Health check — Render pings this to decide whether to route traffic
@app.get("/health", include_in_schema=False)
@app.head("/health", include_in_schema=False)
async def health():
    return {"status": "ok"}


@app.get("/")
@app.head("/")
async def root():
    return {
        "status": "ok",
        "message": "Firm Scraper API v2",
        "docs": "/docs",
        "endpoints": {
            "start_scrape":  "POST /api/scrape",
            "list_jobs":     "GET  /api/jobs",
            "job_detail":    "GET  /api/jobs/{job_id}",
            "job_stream":    "GET  /api/jobs/{job_id}/stream  (SSE)",
            "download_csv":  "GET  /api/jobs/{job_id}/csv",
            "delete_job":    "DELETE /api/jobs/{job_id}",
        },
    }


@app.post("/api/scrape", status_code=202)
async def start_scrape(req: ScrapeRequest, background_tasks: BackgroundTasks):
    """Start a new scrape job. Returns job_id immediately."""
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
    SSE_SUBSCRIBERS[job_id] = []
    background_tasks.add_task(run_scrape_task, job_id, req)
    _persist_jobs_meta()
    logger.info("Job %s created for query %r", job_id, req.query)
    return {"job_id": job_id}


@app.get("/api/jobs", response_model=list[JobSummary])
async def list_jobs():
    """List all jobs (lightweight, no results/log blobs)."""
    return [
        JobSummary(
            job_id=job["job_id"],
            status=job["status"],
            query=job["query"],
            limit=job["limit"],
            progress=job["progress"],
            total=job["total"],
            leads=job["leads"],
            csv_ready=bool(job.get("csv_path")),
        )
        for job in JOBS.values()
    ]


@app.get("/api/jobs/{job_id}", response_model=JobDetail)
async def get_job(job_id: str):
    """Full job detail including all scraped results and log."""
    job = _get_job_or_404(job_id)
    return JobDetail(
        job_id=job["job_id"],
        status=job["status"],
        query=job["query"],
        limit=job["limit"],
        progress=job["progress"],
        total=job["total"],
        leads=job["leads"],
        csv_ready=bool(job.get("csv_path")),
        log=job["log"],
        results=job["results"],
    )


@app.get("/api/jobs/{job_id}/stream")
async def stream_job(job_id: str, request: Request):
    """
    SSE endpoint – subscribe to live job events.

    Event types emitted:
      status   – { status: "running" | "done" | "error" }
      progress – { progress, total, leads }
      log      – { message }
      result   – Business object (each scraped listing)
      error    – { message }
      ping     – keepalive (every 15 s)
    """
    _get_job_or_404(job_id)

    queue: asyncio.Queue = asyncio.Queue(maxsize=512)
    SSE_SUBSCRIBERS.setdefault(job_id, []).append(queue)

    async def event_generator() -> AsyncIterator[str]:
        job = JOBS[job_id]

        # Immediately replay current state for late subscribers
        yield _sse_event({"status": job["status"]}, event="status")
        yield _sse_event(
            {"progress": job["progress"], "total": job["total"], "leads": job["leads"]},
            event="progress",
        )
        for msg in job["log"]:
            yield _sse_event({"message": msg}, event="log")
        for result in job["results"]:
            yield _sse_event(result, event="result")

        # If the job is already finished, close immediately
        if job["status"] in ("done", "error", "interrupted"):
            yield _sse_event({"status": job["status"]}, event="status")
            return

        # Stream live events
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event, data = await asyncio.wait_for(queue.get(), timeout=15)
                    yield _sse_event(data, event=event)
                    # Close stream when job finishes
                    if event == "status" and data.get("status") in ("done", "error"):
                        break
                except asyncio.TimeoutError:
                    yield _sse_event({}, event="ping")  # keepalive
        finally:
            subs = SSE_SUBSCRIBERS.get(job_id, [])
            if queue in subs:
                subs.remove(queue)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",   # disables Nginx buffering on Render
            "Connection": "keep-alive",
        },
    )


@app.get("/api/jobs/{job_id}/csv")
async def download_csv(job_id: str):
    """Download leads as CSV (only available after job completes)."""
    job = _get_job_or_404(job_id)

    csv_path_str = job.get("csv_path")
    if not csv_path_str:
        raise HTTPException(status_code=400, detail="CSV not ready yet – job still running.")

    csv_path = Path(csv_path_str)
    if not csv_path.exists():
        raise HTTPException(status_code=404, detail="CSV file missing on disk.")

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
    """Delete a job and its associated files."""
    _get_job_or_404(job_id)

    for suffix in (f"job_{job_id}.db", f"job_{job_id}_leads.csv"):
        p = DATA_DIR / suffix
        try:
            if p.exists():
                p.unlink()
        except Exception as exc:
            logger.warning("Could not delete %s: %s", p, exc)

    del JOBS[job_id]
    SSE_SUBSCRIBERS.pop(job_id, None)
    _persist_jobs_meta()
    return {"deleted": job_id}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_job_or_404(job_id: str) -> Dict[str, Any]:
    if job_id not in JOBS:
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found.")
    return JOBS[job_id]


# ── Entrypoint ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(
        "server:app",
        host="0.0.0.0",
        port=port,
        reload=False,
        log_level="info",
        # Longer timeouts to accommodate scraping jobs on Render
        timeout_keep_alive=120,
        timeout_graceful_shutdown=30,
    )
