import { useState, useEffect, useRef, useCallback } from 'react'

const API = ''  // proxied via vite → http://localhost:8000

// ── tiny API helpers ──────────────────────────────────────────────────────────
async function apiPost(path, body) {
  const r = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}
async function apiGet(path) {
  const r = await fetch(API + path)
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}
async function apiDelete(path) {
  const r = await fetch(API + path, { method: 'DELETE' })
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

// ── STATUS badge ──────────────────────────────────────────────────────────────
const STATUS_COLOR = {
  pending: 'var(--warn)',
  running: 'var(--accent)',
  done:    'var(--success)',
  error:   'var(--danger)',
}
const STATUS_PL = { pending: 'oczekuje', running: 'skanuje', done: 'gotowe', error: 'błąd' }

function Badge({ status }) {
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 9px',
      borderRadius: '20px',
      fontSize: '11px',
      fontWeight: 500,
      letterSpacing: '.06em',
      textTransform: 'uppercase',
      color: STATUS_COLOR[status] || 'var(--muted)',
      border: `1px solid ${STATUS_COLOR[status] || 'var(--muted)'}`,
      animation: status === 'running' ? 'pulse 1.6s ease infinite' : 'none',
    }}>
      {STATUS_PL[status] || status}
    </span>
  )
}

// ── PROGRESS BAR ──────────────────────────────────────────────────────────────
function ProgressBar({ value, max }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{
        flex: 1, height: 4, background: 'var(--border)',
        borderRadius: 2, overflow: 'hidden',
      }}>
        <div style={{
          height: '100%', width: `${pct}%`,
          background: 'linear-gradient(90deg, var(--accent2), var(--accent))',
          borderRadius: 2,
          transition: 'width .4s ease',
          boxShadow: '0 0 8px var(--accent)',
        }} />
      </div>
      <span style={{ color: 'var(--muted)', fontSize: 12, minWidth: 40 }}>{pct}%</span>
    </div>
  )
}

// ── LOG PANEL ─────────────────────────────────────────────────────────────────
function LogPanel({ lines }) {
  const ref = useRef()
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [lines])
  return (
    <div ref={ref} style={{
      background: 'var(--bg)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius)',
      padding: '12px 14px',
      height: 160,
      overflowY: 'auto',
      fontFamily: 'var(--font-mono)',
      fontSize: 12,
      lineHeight: 1.7,
    }}>
      {lines.length === 0
        ? <span style={{ color: 'var(--muted)' }}>— czekam na dane —</span>
        : lines.map((l, i) => (
          <div key={i} style={{
            color: l.includes('LEAD') ? 'var(--accent)'
                 : l.includes('Błąd') ? 'var(--danger)'
                 : l.includes('Gotowe') ? 'var(--success)'
                 : 'var(--text)',
            animation: 'slideIn .2s ease',
          }}>
            <span style={{ color: 'var(--muted)', marginRight: 8 }}>&rsaquo;</span>{l}
          </div>
        ))
      }
    </div>
  )
}

// ── RESULTS TABLE ─────────────────────────────────────────────────────────────
function ResultsTable({ results, filter }) {
  const rows = filter === 'leads'
    ? results.filter(r => r.is_lead)
    : filter === 'with_site'
    ? results.filter(r => !r.is_lead)
    : results

  if (rows.length === 0)
    return <p style={{ color: 'var(--muted)', padding: '20px 0' }}>Brak wyników.</p>

  const cols = [
    { key: 'name',     label: 'Nazwa' },
    { key: 'category', label: 'Kategoria' },
    { key: 'rating',   label: 'Ocena' },
    { key: 'phone',    label: 'Telefon' },
    { key: 'email',    label: 'E-mail' },
    { key: 'website',  label: 'Strona WWW' },
    { key: 'address',  label: 'Adres' },
  ]

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            {cols.map(c => (
              <th key={c.key} style={{
                textAlign: 'left',
                padding: '8px 12px',
                borderBottom: '1px solid var(--border)',
                color: 'var(--muted)',
                fontWeight: 500,
                fontSize: 11,
                letterSpacing: '.08em',
                textTransform: 'uppercase',
                whiteSpace: 'nowrap',
              }}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{
              background: row.is_lead
                ? 'rgba(0,229,255,.04)'
                : 'transparent',
              borderBottom: '1px solid var(--border)',
              animation: 'fadeIn .3s ease',
            }}>
              {cols.map(c => (
                <td key={c.key} style={{ padding: '9px 12px', verticalAlign: 'middle' }}>
                  {c.key === 'website' && row.website
                    ? <a href={row.website} target="_blank" rel="noreferrer"
                         style={{ color: 'var(--accent2)' }}>
                        {row.website.replace(/^https?:\/\//, '').slice(0, 30)}
                      </a>
                    : c.key === 'email' && row.email
                    ? <a href={`mailto:${row.email}`} style={{ color: 'var(--accent)' }}>
                        {row.email}
                      </a>
                    : c.key === 'name'
                    ? <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {row.is_lead && (
                          <span title="Lead – brak strony WWW" style={{
                            display: 'inline-block', width: 7, height: 7,
                            borderRadius: '50%', background: 'var(--accent)',
                            flexShrink: 0, boxShadow: '0 0 6px var(--accent)',
                          }} />
                        )}
                        <a href={row.maps_url} target="_blank" rel="noreferrer"
                           style={{ color: 'var(--text)' }}>
                          {row[c.key] || <span style={{ color: 'var(--muted)' }}>—</span>}
                        </a>
                      </span>
                    : row[c.key]
                    ? <span>{row[c.key]}</span>
                    : <span style={{ color: 'var(--muted)' }}>—</span>
                  }
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── JOB CARD ──────────────────────────────────────────────────────────────────
function JobCard({ job, onDelete, active, onClick }) {
  const [filter, setFilter] = useState('all')

  const pct = job.total > 0 ? Math.round((job.progress / job.total) * 100) : 0

  return (
    <div
      onClick={onClick}
      style={{
        border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
        borderRadius: 8,
        overflow: 'hidden',
        background: 'var(--surface)',
        cursor: active ? 'default' : 'pointer',
        transition: 'border-color .2s, box-shadow .2s',
        boxShadow: active ? 'var(--glow)' : 'none',
        animation: 'fadeIn .3s ease',
      }}
    >
      {/* Header */}
      <div style={{
        padding: '14px 18px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        borderBottom: active ? '1px solid var(--border)' : 'none',
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'var(--font-head)', fontWeight: 700, fontSize: 15 }}>
              {job.query}
            </span>
            <Badge status={job.status} />
          </div>
          <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 2 }}>
            ID: {job.job_id} · limit: {job.limit} · leads: <span style={{ color: 'var(--accent)' }}>{job.leads}</span>
            {job.total > 0 && ` · ${job.progress}/${job.total} firm`}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          {job.status === 'done' && (
            <a
              href={`/api/jobs/${job.job_id}/csv`}
              download
              onClick={e => e.stopPropagation()}
              style={{
                padding: '6px 14px',
                background: 'transparent',
                border: '1px solid var(--success)',
                color: 'var(--success)',
                borderRadius: 'var(--radius)',
                fontSize: 12,
                fontFamily: 'var(--font-mono)',
                cursor: 'pointer',
                textDecoration: 'none',
                display: 'inline-block',
              }}
            >
              ↓ CSV
            </a>
          )}
          <button
            onClick={e => { e.stopPropagation(); onDelete(job.job_id) }}
            style={{
              padding: '6px 12px',
              background: 'transparent',
              border: '1px solid var(--border)',
              color: 'var(--muted)',
              borderRadius: 'var(--radius)',
              fontSize: 12,
              transition: 'border-color .2s, color .2s',
            }}
            onMouseEnter={e => { e.target.style.borderColor = 'var(--danger)'; e.target.style.color = 'var(--danger)' }}
            onMouseLeave={e => { e.target.style.borderColor = 'var(--border)'; e.target.style.color = 'var(--muted)' }}
          >
            ✕
          </button>
        </div>
      </div>

      {/* Expanded body */}
      {active && (
        <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Progress */}
          {(job.status === 'running' || job.status === 'done') && job.total > 0 && (
            <ProgressBar value={job.progress} max={job.total} />
          )}

          {/* Log */}
          <LogPanel lines={job.log} />

          {/* Filter + table */}
          {job.results.length > 0 && (
            <>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--muted)', fontSize: 12 }}>Filtr:</span>
                {['all', 'leads', 'with_site'].map(f => (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    style={{
                      padding: '4px 12px',
                      borderRadius: 20,
                      border: `1px solid ${filter === f ? 'var(--accent)' : 'var(--border)'}`,
                      background: filter === f ? 'rgba(0,229,255,.1)' : 'transparent',
                      color: filter === f ? 'var(--accent)' : 'var(--muted)',
                      fontSize: 12,
                      cursor: 'pointer',
                      transition: 'all .2s',
                    }}
                  >
                    {f === 'all'       ? `Wszystkie (${job.results.length})`
                     : f === 'leads'   ? `Leady – brak WWW (${job.results.filter(r => r.is_lead).length})`
                     : `Z WWW (${job.results.filter(r => !r.is_lead).length})`
                    }
                  </button>
                ))}
              </div>
              <ResultsTable results={job.results} filter={filter} />
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── SEARCH FORM ───────────────────────────────────────────────────────────────
function SearchForm({ onSubmit, loading }) {
  const [query, setQuery]       = useState('')
  const [limit, setLimit]       = useState(50)
  const [headless, setHeadless] = useState(true)
  const [proxy, setProxy]       = useState('')
  const [advanced, setAdvanced] = useState(false)

  function handleSubmit(e) {
    e.preventDefault()
    if (!query.trim()) return
    onSubmit({ query: query.trim(), limit, headless, proxy: proxy || null })
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Main row */}
      <div style={{ display: 'flex', gap: 10 }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <span style={{
            position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)',
            color: 'var(--muted)', fontSize: 15, pointerEvents: 'none',
          }}>⌕</span>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder='np. "mechanik samochodowy Rybnik"'
            style={{ width: '100%', paddingLeft: 36 }}
            disabled={loading}
          />
        </div>

        <input
          type="number" min={1} max={500} value={limit}
          onChange={e => setLimit(Number(e.target.value))}
          style={{ width: 90 }}
          disabled={loading}
          title="Limit firm"
        />

        <button
          type="submit"
          disabled={loading || !query.trim()}
          style={{
            padding: '10px 24px',
            background: loading
              ? 'var(--surface2)'
              : 'linear-gradient(135deg, var(--accent2), var(--accent))',
            border: 'none',
            borderRadius: 'var(--radius)',
            color: loading ? 'var(--muted)' : '#000',
            fontWeight: 700,
            fontSize: 14,
            letterSpacing: '.04em',
            fontFamily: 'var(--font-head)',
            transition: 'opacity .2s',
            opacity: loading ? .5 : 1,
            whiteSpace: 'nowrap',
          }}
        >
          {loading
            ? <span style={{ display: 'inline-block', animation: 'spin 1s linear infinite' }}>◌</span>
            : '▶ Skanuj'
          }
        </button>
      </div>

      {/* Advanced toggle */}
      <div>
        <button
          type="button"
          onClick={() => setAdvanced(v => !v)}
          style={{
            background: 'none', border: 'none',
            color: 'var(--muted)', fontSize: 12,
            padding: 0, cursor: 'pointer',
          }}
        >
          {advanced ? '▾' : '▸'} Zaawansowane
        </button>
      </div>

      {advanced && (
        <div style={{
          display: 'flex', gap: 12, flexWrap: 'wrap',
          padding: '12px 14px',
          background: 'var(--surface2)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          animation: 'fadeIn .2s ease',
        }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
            <input
              type="checkbox"
              checked={headless}
              onChange={e => setHeadless(e.target.checked)}
              style={{ width: 'auto', accentColor: 'var(--accent)' }}
            />
            Headless (bez okna przeglądarki)
          </label>
          <input
            value={proxy}
            onChange={e => setProxy(e.target.value)}
            placeholder="Proxy: http://user:pass@host:port"
            style={{ flex: 1, minWidth: 220 }}
          />
        </div>
      )}
    </form>
  )
}

// ── STATS BAR ─────────────────────────────────────────────────────────────────
function StatsBar({ jobs }) {
  const total  = jobs.reduce((s, j) => s + j.results.length, 0)
  const leads  = jobs.reduce((s, j) => s + j.leads, 0)
  const active = jobs.filter(j => j.status === 'running').length

  return (
    <div style={{
      display: 'flex', gap: 24, flexWrap: 'wrap',
      borderBottom: '1px solid var(--border)',
      paddingBottom: 16, marginBottom: 24,
    }}>
      {[
        { label: 'Zadania', value: jobs.length, color: 'var(--text)' },
        { label: 'Aktywne', value: active,      color: 'var(--warn)' },
        { label: 'Firmy',   value: total,        color: 'var(--text)' },
        { label: 'Leady',   value: leads,        color: 'var(--accent)' },
      ].map(s => (
        <div key={s.label}>
          <div style={{ color: 'var(--muted)', fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase' }}>
            {s.label}
          </div>
          <div style={{
            fontFamily: 'var(--font-head)', fontSize: 26, fontWeight: 800,
            color: s.color, lineHeight: 1.1,
          }}>
            {s.value}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── BACKGROUND GRID ───────────────────────────────────────────────────────────
function GridBg() {
  return (
    <div style={{
      position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0,
      backgroundImage: `
        linear-gradient(rgba(0,229,255,.025) 1px, transparent 1px),
        linear-gradient(90deg, rgba(0,229,255,.025) 1px, transparent 1px)
      `,
      backgroundSize: '48px 48px',
    }} />
  )
}

// ── APP ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [jobs, setJobs]     = useState([])
  const [activeId, setActiveId] = useState(null)
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState(null)
  const pollerRef = useRef(null)

  // Poll all running jobs every 2 s
  const pollJobs = useCallback(async () => {
    setJobs(prev => {
      const running = prev.filter(j => j.status === 'pending' || j.status === 'running')
      if (running.length === 0) return prev
      return prev  // actual fetch below
    })

    setJobs(prev => {
      const running = prev.filter(j => j.status === 'pending' || j.status === 'running')
      if (running.length === 0) return prev

      Promise.all(running.map(j => apiGet(`/api/jobs/${j.job_id}`))).then(updated => {
        setJobs(current =>
          current.map(j => {
            const u = updated.find(x => x.job_id === j.job_id)
            return u ? u : j
          })
        )
      }).catch(() => {})
      return prev
    })
  }, [])

  useEffect(() => {
    pollerRef.current = setInterval(pollJobs, 2000)
    return () => clearInterval(pollerRef.current)
  }, [pollJobs])

  async function handleSubmit(params) {
    setError(null)
    setLoading(true)
    try {
      const { job_id } = await apiPost('/api/scrape', params)
      const job = await apiGet(`/api/jobs/${job_id}`)
      setJobs(prev => [job, ...prev])
      setActiveId(job_id)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleDelete(job_id) {
    try {
      await apiDelete(`/api/jobs/${job_id}`)
      setJobs(prev => prev.filter(j => j.job_id !== job_id))
      if (activeId === job_id) setActiveId(null)
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <>
      <GridBg />
      <div style={{ position: 'relative', zIndex: 1, minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>

        {/* NAV */}
        <header style={{
          borderBottom: '1px solid var(--border)',
          padding: '0 32px',
          display: 'flex',
          alignItems: 'center',
          height: 58,
          background: 'rgba(10,10,15,.85)',
          backdropFilter: 'blur(12px)',
          position: 'sticky', top: 0, zIndex: 10,
        }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span style={{
              fontFamily: 'var(--font-head)',
              fontWeight: 800,
              fontSize: 20,
              letterSpacing: '-.01em',
            }}>
              <span style={{ color: 'var(--accent)' }}>Firm</span>
              <span style={{ color: 'var(--text)' }}>Scraper</span>
            </span>
            <span style={{
              fontSize: 10, color: 'var(--muted)',
              border: '1px solid var(--border)', borderRadius: 3,
              padding: '1px 6px', letterSpacing: '.08em',
            }}>
              v2.0
            </span>
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            Google Maps Lead Generator
          </div>
        </header>

        {/* MAIN */}
        <main style={{ flex: 1, padding: '32px', maxWidth: 1100, margin: '0 auto', width: '100%' }}>

          {/* Search card */}
          <div style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: '24px',
            marginBottom: 28,
          }}>
            <div style={{
              fontFamily: 'var(--font-head)',
              fontWeight: 700, fontSize: 13,
              color: 'var(--muted)', letterSpacing: '.1em',
              textTransform: 'uppercase', marginBottom: 14,
            }}>
              Nowe skanowanie
            </div>
            <SearchForm onSubmit={handleSubmit} loading={loading} />
            {error && (
              <div style={{
                marginTop: 12, padding: '10px 14px',
                background: 'rgba(255,61,113,.1)',
                border: '1px solid var(--danger)',
                borderRadius: 'var(--radius)',
                color: 'var(--danger)', fontSize: 13,
              }}>
                ⚠ {error}
              </div>
            )}
          </div>

          {/* Stats */}
          {jobs.length > 0 && <StatsBar jobs={jobs} />}

          {/* Job list */}
          {jobs.length === 0
            ? (
              <div style={{
                textAlign: 'center', padding: '64px 0',
                color: 'var(--muted)',
              }}>
                <div style={{ fontSize: 40, marginBottom: 12 }}>⌕</div>
                <div style={{ fontFamily: 'var(--font-head)', fontSize: 18, marginBottom: 6 }}>
                  Brak zadań
                </div>
                <div style={{ fontSize: 13 }}>
                  Wpisz frazę powyżej i kliknij „Skanuj", aby rozpocząć zbieranie danych.
                </div>
              </div>
            )
            : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {jobs.map(job => (
                  <JobCard
                    key={job.job_id}
                    job={job}
                    active={activeId === job.job_id}
                    onClick={() => setActiveId(id => id === job.job_id ? null : job.job_id)}
                    onDelete={handleDelete}
                  />
                ))}
              </div>
            )
          }
        </main>

        {/* FOOTER */}
        <footer style={{
          borderTop: '1px solid var(--border)',
          padding: '14px 32px',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          color: 'var(--muted)', fontSize: 12,
        }}>
          <span>FirmScraper © {new Date().getFullYear()}</span>
          <span>Backend: <span style={{ color: 'var(--accent)' }}>FastAPI</span> · Scraper: <span style={{ color: 'var(--accent)' }}>Playwright</span></span>
        </footer>
      </div>
    </>
  )
}
