/**
 * Firm Scraper API Client
 * -----------------------
 * Drop-in TypeScript/JS client for the Firm Scraper backend.
 * Works in browser (React/Next.js) and Node.js.
 *
 * Usage:
 *   const client = new FirmScraperClient("https://your-render-url.onrender.com");
 *   const { job_id } = await client.startScrape({ query: "naprawa samochodów Warszawa", limit: 50 });
 *   client.streamJob(job_id, {
 *     onProgress: (p) => console.log(p),
 *     onResult:   (biz) => console.log(biz),
 *     onDone:     () => console.log("Done!"),
 *   });
 */

export interface ScrapeRequest {
  query: string;
  limit?: number;       // default 100, max 500
  headless?: boolean;   // default true
  proxy?: string;       // optional "http://user:pass@host:port"
}

export interface JobSummary {
  job_id: string;
  status: "pending" | "running" | "done" | "error" | "interrupted";
  query: string;
  limit: number;
  progress: number;
  total: number;
  leads: number;
  csv_ready: boolean;
}

export interface JobDetail extends JobSummary {
  log: string[];
  results: Business[];
}

export interface Business {
  name: string;
  address: string;
  phone: string;
  email: string;
  website: string;
  rating: string;
  reviews: string;
  category: string;
  maps_url: string;
  is_lead: boolean;
}

export interface StreamCallbacks {
  onStatus?:   (status: JobSummary["status"]) => void;
  onProgress?: (data: { progress: number; total: number; leads: number }) => void;
  onLog?:      (message: string) => void;
  onResult?:   (business: Business) => void;
  onError?:    (message: string) => void;
  onDone?:     () => void;
}

// ── Client ────────────────────────────────────────────────────────────────────

export class FirmScraperClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    // Strip trailing slash
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  /** Start a new scrape job. Returns job_id. */
  async startScrape(req: ScrapeRequest): Promise<{ job_id: string }> {
    const res = await fetch(`${this.baseUrl}/api/scrape`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`startScrape failed (${res.status}): ${err.detail ?? res.statusText}`);
    }
    return res.json();
  }

  /** Get all jobs (lightweight summary). */
  async listJobs(): Promise<JobSummary[]> {
    const res = await fetch(`${this.baseUrl}/api/jobs`);
    if (!res.ok) throw new Error(`listJobs failed: ${res.statusText}`);
    return res.json();
  }

  /** Get full job detail including results and log. */
  async getJob(jobId: string): Promise<JobDetail> {
    const res = await fetch(`${this.baseUrl}/api/jobs/${jobId}`);
    if (!res.ok) throw new Error(`getJob failed: ${res.statusText}`);
    return res.json();
  }

  /**
   * Subscribe to real-time job events via SSE.
   * Returns a cleanup function — call it to close the stream.
   *
   * @example
   * const unsub = client.streamJob("abc123", {
   *   onProgress: ({ progress, total }) => setProgress(progress / total),
   *   onResult: (biz) => setResults(prev => [...prev, biz]),
   *   onDone: () => console.log("Scrape complete"),
   * });
   * // Later: unsub(); // closes EventSource
   */
  streamJob(jobId: string, callbacks: StreamCallbacks): () => void {
    const url = `${this.baseUrl}/api/jobs/${jobId}/stream`;
    const es = new EventSource(url);

    es.addEventListener("status", (e: MessageEvent) => {
      const { status } = JSON.parse(e.data);
      callbacks.onStatus?.(status);
      if (status === "done") {
        callbacks.onDone?.();
        es.close();
      } else if (status === "error") {
        es.close();
      }
    });

    es.addEventListener("progress", (e: MessageEvent) => {
      callbacks.onProgress?.(JSON.parse(e.data));
    });

    es.addEventListener("log", (e: MessageEvent) => {
      const { message } = JSON.parse(e.data);
      callbacks.onLog?.(message);
    });

    es.addEventListener("result", (e: MessageEvent) => {
      callbacks.onResult?.(JSON.parse(e.data));
    });

    es.addEventListener("error", (e: MessageEvent) => {
      try {
        const { message } = JSON.parse((e as any).data ?? "{}");
        callbacks.onError?.(message ?? "Unknown error");
      } catch {
        callbacks.onError?.("Stream error");
      }
      es.close();
    });

    es.onerror = () => {
      // EventSource auto-reconnects on network glitch; only close on explicit error events above.
      callbacks.onLog?.("[stream] Connection interrupted, reconnecting…");
    };

    return () => es.close();
  }

  /** Download leads CSV as a Blob (browser) or Buffer (Node). */
  async downloadCsv(jobId: string): Promise<Blob> {
    const res = await fetch(`${this.baseUrl}/api/jobs/${jobId}/csv`);
    if (!res.ok) throw new Error(`downloadCsv failed: ${res.statusText}`);
    return res.blob();
  }

  /** Trigger CSV download in the browser. */
  triggerCsvDownload(jobId: string): void {
    const a = document.createElement("a");
    a.href = `${this.baseUrl}/api/jobs/${jobId}/csv`;
    a.download = `leads_${jobId}.csv`;
    a.click();
  }

  /** Delete a job and its files. */
  async deleteJob(jobId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/jobs/${jobId}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`deleteJob failed: ${res.statusText}`);
  }

  /** Ping the server (health check). */
  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }
}

// ── React hook (optional) ─────────────────────────────────────────────────────
// Paste into your React app if you want a ready-to-use hook.

/*
import { useState, useEffect, useRef, useCallback } from "react";

export function useScrapeJob(client: FirmScraperClient) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<JobSummary["status"]>("pending");
  const [progress, setProgress] = useState({ progress: 0, total: 0, leads: 0 });
  const [results, setResults] = useState<Business[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const unsubRef = useRef<(() => void) | null>(null);

  const start = useCallback(async (req: ScrapeRequest) => {
    const { job_id } = await client.startScrape(req);
    setJobId(job_id);
    setResults([]);
    setLog([]);
    setStatus("pending");

    unsubRef.current = client.streamJob(job_id, {
      onStatus:   (s) => setStatus(s),
      onProgress: (p) => setProgress(p),
      onResult:   (biz) => setResults((prev) => [...prev, biz]),
      onLog:      (msg) => setLog((prev) => [...prev, msg]),
    });
  }, [client]);

  const stop = useCallback(() => {
    unsubRef.current?.();
    if (jobId) client.deleteJob(jobId);
  }, [client, jobId]);

  useEffect(() => () => { unsubRef.current?.(); }, []);

  return { jobId, status, progress, results, log, start, stop };
}
*/
