/**
 * Firm Scraper – API Layer
 * ========================
 * Production-ready API client with retry logic for Render cold starts,
 * timeout handling, and structured error responses.
 *
 * All backend URLs are resolved from VITE_API_URL env variable.
 * In development, Vite proxy handles /api routes (VITE_API_URL is empty).
 */

// ── Base URL ────────────────────────────────────────────────────────────────
const BASE_URL = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '')

// ── Config ──────────────────────────────────────────────────────────────────
const DEFAULT_TIMEOUT_MS = 30_000
const RETRY_COUNT = 3
const RETRY_DELAY_MS = 2_000 // initial delay — doubles each retry (exponential backoff)
const WAKE_UP_TIMEOUT_MS = 60_000 // Render free tier can take up to 60s to wake

// ── Custom Error Class ──────────────────────────────────────────────────────
export class ApiError extends Error {
  /**
   * @param {string} message  — human-readable message
   * @param {number} status   — HTTP status code (0 = network/timeout)
   * @param {string} code     — machine-readable code
   * @param {*}      details  — raw response body if available
   */
  constructor(message, status = 0, code = 'UNKNOWN', details = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

// ── Error Classification ────────────────────────────────────────────────────
function classifyError(error) {
  if (error instanceof ApiError) return error

  // Network errors (backend offline, DNS failure, CORS block)
  if (error instanceof TypeError && error.message.includes('fetch')) {
    return new ApiError(
      'Nie można połączyć się z serwerem. Backend może być offline lub blokowany przez CORS.',
      0,
      'NETWORK_ERROR'
    )
  }

  // AbortController timeout
  if (error.name === 'AbortError') {
    return new ApiError(
      'Żądanie przekroczyło limit czasu. Spróbuj ponownie.',
      0,
      'TIMEOUT'
    )
  }

  return new ApiError(error.message || 'Nieznany błąd', 0, 'UNKNOWN')
}

function classifyHttpError(status, body) {
  const message =
    typeof body === 'string' ? body
    : body?.detail ? String(body.detail)
    : `Błąd HTTP ${status}`

  const codeMap = {
    400: 'BAD_REQUEST',
    401: 'UNAUTHORIZED',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    422: 'VALIDATION_ERROR',
    429: 'RATE_LIMITED',
    500: 'SERVER_ERROR',
    502: 'BAD_GATEWAY',
    503: 'SERVICE_UNAVAILABLE',
  }

  return new ApiError(
    message,
    status,
    codeMap[status] || 'HTTP_ERROR',
    body
  )
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function shouldRetry(error) {
  // Retry on network failures + 5xx server errors (Render cold start / overload)
  if (error.code === 'NETWORK_ERROR') return true
  if (error.code === 'TIMEOUT') return true
  if (error.status >= 500) return true
  return false
}

// ── Core Fetch Wrapper ──────────────────────────────────────────────────────
/**
 * Low-level fetch with timeout support.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    })
    return response
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * High-level request with automatic retry & error handling.
 *
 * @param {string} path          — e.g. "/api/scrape"
 * @param {RequestInit} options  — fetch options
 * @param {object} config        — { retries, timeoutMs, isWakeUp }
 * @returns {Promise<Response>}
 */
async function request(path, options = {}, config = {}) {
  const {
    retries = RETRY_COUNT,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = config

  const url = `${BASE_URL}${path}`
  let lastError

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchWithTimeout(url, options, timeoutMs)

      // Success range
      if (response.ok) return response

      // Parse error body
      let body
      try {
        body = await response.json()
      } catch {
        body = await response.text().catch(() => null)
      }

      lastError = classifyHttpError(response.status, body)

      // Only retry on retryable errors
      if (!shouldRetry(lastError) || attempt === retries) {
        throw lastError
      }
    } catch (error) {
      if (error instanceof ApiError) {
        lastError = error
        if (!shouldRetry(error) || attempt === retries) throw error
      } else {
        lastError = classifyError(error)
        if (!shouldRetry(lastError) || attempt === retries) throw lastError
      }
    }

    // Exponential backoff before next attempt
    const delay = RETRY_DELAY_MS * Math.pow(2, attempt)
    console.warn(
      `[api] Attempt ${attempt + 1}/${retries + 1} failed. Retrying in ${delay}ms...`,
      lastError?.message
    )
    await sleep(delay)
  }

  throw lastError
}

// ── JSON Helpers ────────────────────────────────────────────────────────────
async function parseJson(response) {
  try {
    return await response.json()
  } catch {
    throw new ApiError(
      'Nieprawidłowa odpowiedź JSON z serwera.',
      response.status,
      'INVALID_JSON'
    )
  }
}

// ── Public API Methods ──────────────────────────────────────────────────────

/**
 * Wake up the Render backend (free tier sleeps after 15 min of inactivity).
 * Hits the root `/` endpoint with a generous timeout.
 *
 * @returns {Promise<{status: string, message: string}>}
 */
export async function wakeUpBackend() {
  const response = await request('/', {}, {
    retries: 2,
    timeoutMs: WAKE_UP_TIMEOUT_MS,
  })
  return parseJson(response)
}

/**
 * Check if the backend is alive.
 * @returns {Promise<boolean>}
 */
export async function healthCheck() {
  try {
    await request('/', {}, { retries: 0, timeoutMs: 10_000 })
    return true
  } catch {
    return false
  }
}

/**
 * Start a new scrape job.
 *
 * @param {{ query: string, limit?: number, headless?: boolean, proxy?: string|null }} params
 * @returns {Promise<{ job_id: string }>}
 */
export async function startScrape(params) {
  const response = await request('/api/scrape', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  }, {
    // First request may need to wake up the server
    timeoutMs: WAKE_UP_TIMEOUT_MS,
  })
  return parseJson(response)
}

/**
 * Get the list of all jobs (lightweight — without results/log).
 *
 * @returns {Promise<Array<{ job_id, status, query, limit, progress, total, leads }>>}
 */
export async function getJobs() {
  const response = await request('/api/jobs', {}, { retries: 1 })
  return parseJson(response)
}

/**
 * Get a single job with full details (results + log).
 *
 * @param {string} jobId
 * @returns {Promise<object>}
 */
export async function getJob(jobId) {
  const response = await request(`/api/jobs/${jobId}`, {}, { retries: 1 })
  return parseJson(response)
}

/**
 * Download the CSV for a completed job.
 *
 * @param {string} jobId
 * @returns {void} — triggers a browser download
 */
export async function downloadCsv(jobId) {
  const url = `${BASE_URL}/api/jobs/${jobId}/csv`
  const response = await fetchWithTimeout(url, {}, DEFAULT_TIMEOUT_MS)

  if (!response.ok) {
    let body
    try { body = await response.json() } catch { body = null }
    throw classifyHttpError(response.status, body)
  }

  // Trigger download by creating an object URL from the CSV blob
  const blob = await response.blob()
  const blobUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = blobUrl
  anchor.download = `leads_${jobId}.csv`
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(blobUrl)
}

/**
 * Delete a job and its associated files.
 *
 * @param {string} jobId
 * @returns {Promise<{ deleted: string }>}
 */
export async function deleteJob(jobId) {
  const response = await request(`/api/jobs/${jobId}`, {
    method: 'DELETE',
  })
  return parseJson(response)
}

// ── Connection Status Utility ───────────────────────────────────────────────

/**
 * Returns a human-readable connection status object.
 *
 * @param {ApiError|Error|null} error
 * @returns {{ online: boolean, message: string, retriable: boolean }}
 */
export function getConnectionStatus(error) {
  if (!error) return { online: true, message: 'Połączono z serwerem', retriable: false }

  if (error instanceof ApiError) {
    switch (error.code) {
      case 'NETWORK_ERROR':
        return { online: false, message: 'Backend offline — sprawdź połączenie lub CORS', retriable: true }
      case 'TIMEOUT':
        return { online: false, message: 'Serwer nie odpowiada (timeout)', retriable: true }
      case 'SERVICE_UNAVAILABLE':
      case 'BAD_GATEWAY':
        return { online: false, message: 'Serwer chwilowo niedostępny (Render sleeping?)', retriable: true }
      case 'RATE_LIMITED':
        return { online: true, message: 'Zbyt wiele żądań — poczekaj chwilę', retriable: true }
      default:
        return { online: true, message: error.message, retriable: false }
    }
  }

  return { online: false, message: error.message || 'Nieznany błąd', retriable: true }
}
