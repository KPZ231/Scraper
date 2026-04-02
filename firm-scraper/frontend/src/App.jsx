import { useState, useEffect, useRef, useCallback } from 'react'

const API = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ? '' : 'https://scraper-bdxt.onrender.com'

// ─────────────────────────────────────────────────────────────────────────────
//  DATA
// ─────────────────────────────────────────────────────────────────────────────

const BRANCH_CITIES = {
  mechanik:    ['Warszawa', 'Kraków', 'Wrocław', 'Gdańsk', 'Poznań', 'Łódź', 'Katowice', 'Rybnik'],
  dentysta:    ['Warszawa', 'Kraków', 'Wrocław', 'Gdańsk', 'Poznań', 'Łódź', 'Szczecin', 'Bydgoszcz'],
  hydraulik:   ['Warszawa', 'Kraków', 'Wrocław', 'Gdańsk', 'Poznań', 'Łódź', 'Lublin', 'Białystok'],
  fryzjer:     ['Warszawa', 'Kraków', 'Wrocław', 'Gdańsk', 'Poznań', 'Łódź', 'Toruń', 'Rzeszów'],
  restauracja: ['Warszawa', 'Kraków', 'Wrocław', 'Gdańsk', 'Poznań', 'Łódź', 'Zakopane', 'Sopot'],
  prawnik:     ['Warszawa', 'Kraków', 'Wrocław', 'Gdańsk', 'Poznań', 'Łódź', 'Katowice', 'Lublin'],
  księgowy:    ['Warszawa', 'Kraków', 'Wrocław', 'Gdańsk', 'Poznań', 'Łódź', 'Bydgoszcz', 'Toruń'],
  elektryk:    ['Warszawa', 'Kraków', 'Wrocław', 'Gdańsk', 'Poznań', 'Łódź', 'Szczecin', 'Gdynia'],
}

const TEMPLATES = [
  'mechanik samochodowy Warszawa',
  'dentysta Kraków',
  'hydraulik Wrocław',
  'fryzjer Gdańsk',
  'restauracja Poznań',
  'prawnik Łódź',
  'elektryk Katowice',
  'księgowy Rybnik',
]

// ─────────────────────────────────────────────────────────────────────────────
//  API HELPERS
// ─────────────────────────────────────────────────────────────────────────────
async function apiPost(path, body) {
  const r = await fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
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

// ─────────────────────────────────────────────────────────────────────────────
//  XLSX EXPORT  (pure JS – no library needed)
// ─────────────────────────────────────────────────────────────────────────────
function exportXlsx(results, filename = 'leads.xlsx') {
  const leads = results.filter(r => r.is_lead)
  const cols    = ['name','address','phone','email','rating','reviews','category','maps_url']
  const headers = ['Nazwa','Adres','Telefon','E-mail','Ocena','Opinie','Kategoria','Google Maps URL']
  const esc = v => String(v || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
  const rows = [headers, ...leads.map(r => cols.map(c => r[c] || ''))]
  const xmlRows = rows.map(row =>
    `<Row>${row.map(cell => `<Cell><Data ss:Type="String">${esc(cell)}</Data></Cell>`).join('')}</Row>`
  ).join('')
  const xml = `<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Worksheet ss:Name="Leady"><Table>${xmlRows}</Table></Worksheet></Workbook>`
  const blob = new Blob([xml], { type: 'application/vnd.ms-excel;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

// ─────────────────────────────────────────────────────────────────────────────
//  TOAST SYSTEM
// ─────────────────────────────────────────────────────────────────────────────
function ToastContainer({ toasts, onRemove }) {
  return (
    <div style={{ position:'fixed', bottom:24, right:24, zIndex:1000, display:'flex', flexDirection:'column', gap:8, alignItems:'flex-end' }}>
      {toasts.map(t => (
        <div key={t.id} onClick={() => onRemove(t.id)} style={{
          padding:'10px 16px', borderRadius:8,
          background: t.type === 'success' ? 'rgba(0,224,150,.15)' : t.type === 'error' ? 'rgba(255,61,113,.15)' : 'rgba(0,229,255,.12)',
          border: `1px solid ${t.type === 'success' ? 'var(--success)' : t.type === 'error' ? 'var(--danger)' : 'var(--accent)'}`,
          color: t.type === 'success' ? 'var(--success)' : t.type === 'error' ? 'var(--danger)' : 'var(--accent)',
          fontSize:13, cursor:'pointer', maxWidth:340,
          animation:'fadeIn .25s ease', backdropFilter:'blur(8px)',
        }}>
          {t.type === 'success' ? '✓ ' : t.type === 'error' ? '⚠ ' : 'ℹ '}{t.msg}
        </div>
      ))}
    </div>
  )
}
function useToasts() {
  const [toasts, setToasts] = useState([])
  const add = useCallback((msg, type = 'info', ms = 4000) => {
    const id = Date.now()
    setToasts(p => [...p, { id, msg, type }])
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), ms)
  }, [])
  const remove = useCallback(id => setToasts(p => p.filter(t => t.id !== id)), [])
  return { toasts, add, remove }
}

// ─────────────────────────────────────────────────────────────────────────────
//  COPY BUTTON
// ─────────────────────────────────────────────────────────────────────────────
function CopyBtn({ value }) {
  const [copied, setCopied] = useState(false)
  if (!value) return null
  return (
    <button
      title="Kopiuj"
      onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
      style={{ background:'none', border:'none', cursor:'pointer', color: copied ? 'var(--success)' : 'var(--muted)', fontSize:12, padding:'0 4px', lineHeight:1, transition:'color .2s' }}
    >
      {copied ? '✓' : '⎘'}
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
//  BADGE
// ─────────────────────────────────────────────────────────────────────────────
const STATUS_COLOR = { pending:'var(--warn)', running:'var(--accent)', done:'var(--success)', error:'var(--danger)' }
const STATUS_PL    = { pending:'oczekuje', running:'skanuje', done:'gotowe', error:'błąd' }
function Badge({ status }) {
  return (
    <span style={{
      display:'inline-block', padding:'2px 9px', borderRadius:20,
      fontSize:11, fontWeight:500, letterSpacing:'.06em', textTransform:'uppercase',
      color: STATUS_COLOR[status] || 'var(--muted)',
      border: `1px solid ${STATUS_COLOR[status] || 'var(--muted)'}`,
      animation: status === 'running' ? 'pulse 1.6s ease infinite' : 'none',
    }}>
      {STATUS_PL[status] || status}
    </span>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
//  PROGRESS BAR
// ─────────────────────────────────────────────────────────────────────────────
function ProgressBar({ value, max }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0
  return (
    <div style={{ display:'flex', alignItems:'center', gap:10 }}>
      <div style={{ flex:1, height:4, background:'var(--border)', borderRadius:2, overflow:'hidden' }}>
        <div style={{ height:'100%', width:`${pct}%`, background:'linear-gradient(90deg, var(--accent2), var(--accent))', borderRadius:2, transition:'width .4s ease', boxShadow:'0 0 8px var(--accent)' }} />
      </div>
      <span style={{ color:'var(--muted)', fontSize:12, minWidth:40 }}>{pct}%</span>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
//  LOG PANEL
// ─────────────────────────────────────────────────────────────────────────────
function LogPanel({ lines }) {
  const ref = useRef()
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight }, [lines])
  return (
    <div ref={ref} style={{ background:'var(--bg)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'12px 14px', height:150, overflowY:'auto', fontFamily:'var(--font-mono)', fontSize:12, lineHeight:1.7 }}>
      {lines.length === 0
        ? <span style={{ color:'var(--muted)' }}>— czekam na dane —</span>
        : lines.map((l, i) => (
          <div key={i} style={{ color: l.includes('LEAD') ? 'var(--accent)' : l.includes('Błąd') ? 'var(--danger)' : l.includes('Gotowe') ? 'var(--success)' : 'var(--text)', animation:'slideIn .2s ease' }}>
            <span style={{ color:'var(--muted)', marginRight:8 }}>&rsaquo;</span>{l}
          </div>
        ))
      }
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
//  RESULTS TABLE  (sort + search + copy)
// ─────────────────────────────────────────────────────────────────────────────
const COLS = [
  { key:'name',     label:'Nazwa' },
  { key:'category', label:'Kategoria' },
  { key:'rating',   label:'Ocena',   sortable:true },
  { key:'reviews',  label:'Opinie',  sortable:true },
  { key:'phone',    label:'Telefon', copyable:true },
  { key:'email',    label:'E-mail',  copyable:true },
  { key:'website',  label:'Strona WWW' },
  { key:'address',  label:'Adres' },
]

function ResultsTable({ results, leadFilter }) {
  const [search,  setSearch]  = useState('')
  const [sortKey, setSortKey] = useState(null)
  const [sortDir, setSortDir] = useState(-1)

  let rows = leadFilter === 'leads'     ? results.filter(r => r.is_lead)
           : leadFilter === 'with_site' ? results.filter(r => !r.is_lead)
           : results

  if (search.trim()) {
    const q = search.toLowerCase()
    rows = rows.filter(r => COLS.some(c => String(r[c.key] || '').toLowerCase().includes(q)))
  }
  if (sortKey) {
    rows = [...rows].sort((a, b) => {
      const av = parseFloat(String(a[sortKey]).replace(/\D/g,'')) || 0
      const bv = parseFloat(String(b[sortKey]).replace(/\D/g,'')) || 0
      return (av - bv) * sortDir
    })
  }

  function toggleSort(key) {
    if (sortKey === key) setSortDir(d => -d)
    else { setSortKey(key); setSortDir(-1) }
  }

  return (
    <div>
      <div style={{ position:'relative', marginBottom:10 }}>
        <span style={{ position:'absolute', left:12, top:'50%', transform:'translateY(-50%)', color:'var(--muted)', fontSize:13, pointerEvents:'none' }}>⌕</span>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Szukaj w wynikach…" style={{ width:'100%', paddingLeft:32 }} />
      </div>
      {rows.length === 0
        ? <p style={{ color:'var(--muted)', padding:'16px 0' }}>Brak wyników{search ? ` dla „${search}"` : ''}.</p>
        : (
          <div style={{ overflowX:'auto' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
              <thead>
                <tr>
                  {COLS.map(c => (
                    <th key={c.key} onClick={() => c.sortable && toggleSort(c.key)} style={{
                      textAlign:'left', padding:'8px 12px', borderBottom:'1px solid var(--border)',
                      color: sortKey === c.key ? 'var(--accent)' : 'var(--muted)',
                      fontWeight:500, fontSize:11, letterSpacing:'.08em', textTransform:'uppercase',
                      whiteSpace:'nowrap', cursor: c.sortable ? 'pointer' : 'default', userSelect:'none',
                    }}>
                      {c.label}
                      {c.sortable && <span style={{ marginLeft:4, opacity: sortKey === c.key ? 1 : 0.3 }}>{sortKey === c.key ? (sortDir === -1 ? '↓' : '↑') : '↕'}</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i} style={{ background: row.is_lead ? 'rgba(0,229,255,.04)' : 'transparent', borderBottom:'1px solid var(--border)', animation:'fadeIn .3s ease' }}>
                    {COLS.map(c => (
                      <td key={c.key} style={{ padding:'8px 12px', verticalAlign:'middle' }}>
                        {c.key === 'website' && row.website
                          ? <a href={row.website} target="_blank" rel="noreferrer" style={{ color:'var(--accent2)' }}>{row.website.replace(/^https?:\/\//,'').slice(0,28)}</a>
                          : c.key === 'email' && row.email
                          ? <span style={{ display:'flex', alignItems:'center', gap:4 }}><a href={`mailto:${row.email}`} style={{ color:'var(--accent)' }}>{row.email}</a><CopyBtn value={row.email} /></span>
                          : c.key === 'phone' && row.phone
                          ? <span style={{ display:'flex', alignItems:'center', gap:4 }}><span>{row.phone}</span><CopyBtn value={row.phone} /></span>
                          : c.key === 'name'
                          ? <span style={{ display:'flex', alignItems:'center', gap:8 }}>
                              {row.is_lead && <span title="Lead – brak strony WWW" style={{ display:'inline-block', width:7, height:7, borderRadius:'50%', background:'var(--accent)', flexShrink:0, boxShadow:'0 0 6px var(--accent)' }} />}
                              <a href={row.maps_url} target="_blank" rel="noreferrer" style={{ color:'var(--text)' }}>{row.name || <span style={{ color:'var(--muted)' }}>—</span>}</a>
                            </span>
                          : row[c.key] ? <span>{row[c.key]}</span> : <span style={{ color:'var(--muted)' }}>—</span>
                        }
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ color:'var(--muted)', fontSize:12, padding:'8px 4px' }}>
              {rows.length} {rows.length === 1 ? 'wynik' : 'wyników'}{search && ` · filtr: „${search}"`}
            </div>
          </div>
        )
      }
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
//  JOB CARD
// ─────────────────────────────────────────────────────────────────────────────
function JobCard({ job, onDelete, active, onClick }) {
  const [filter, setFilter] = useState('all')
  return (
    <div onClick={onClick} style={{
      border:`1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
      borderRadius:8, overflow:'hidden', background:'var(--surface)',
      cursor: active ? 'default' : 'pointer',
      transition:'border-color .2s, box-shadow .2s',
      boxShadow: active ? 'var(--glow)' : 'none',
      animation:'fadeIn .3s ease',
    }}>
      {/* Header */}
      <div style={{ padding:'14px 18px', display:'flex', alignItems:'center', gap:12, borderBottom: active ? '1px solid var(--border)' : 'none' }}>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
            <span style={{ fontFamily:'var(--font-head)', fontWeight:700, fontSize:15 }}>{job.query}</span>
            <Badge status={job.status} />
          </div>
          <div style={{ color:'var(--muted)', fontSize:12, marginTop:2 }}>
            ID: {job.job_id} · limit: {job.limit} · leady: <span style={{ color:'var(--accent)' }}>{job.leads}</span>
            {job.total > 0 && ` · ${job.progress}/${job.total} firm`}
          </div>
        </div>
        <div style={{ display:'flex', gap:8, flexShrink:0 }} onClick={e => e.stopPropagation()}>
          {job.status === 'done' && <>
            <a href={`/api/jobs/${job.job_id}/csv`} download style={{ padding:'6px 14px', background:'transparent', border:'1px solid var(--success)', color:'var(--success)', borderRadius:'var(--radius)', fontSize:12, fontFamily:'var(--font-mono)', cursor:'pointer', textDecoration:'none', display:'inline-block' }}>↓ CSV</a>
            <button onClick={() => exportXlsx(job.results, `leads_${job.job_id}.xlsx`)} style={{ padding:'6px 14px', background:'transparent', border:'1px solid var(--accent2)', color:'var(--accent2)', borderRadius:'var(--radius)', fontSize:12, cursor:'pointer' }}>↓ XLSX</button>
          </>}
          <button onClick={() => onDelete(job.job_id)}
            style={{ padding:'6px 12px', background:'transparent', border:'1px solid var(--border)', color:'var(--muted)', borderRadius:'var(--radius)', fontSize:12, transition:'border-color .2s, color .2s' }}
            onMouseEnter={e => { e.target.style.borderColor='var(--danger)'; e.target.style.color='var(--danger)' }}
            onMouseLeave={e => { e.target.style.borderColor='var(--border)'; e.target.style.color='var(--muted)' }}
          >✕</button>
        </div>
      </div>
      {/* Body */}
      {active && (
        <div style={{ padding:'16px 18px', display:'flex', flexDirection:'column', gap:14 }}>
          {(job.status === 'running' || job.status === 'done') && job.total > 0 && <ProgressBar value={job.progress} max={job.total} />}
          <LogPanel lines={job.log} />
          {job.results.length > 0 && (
            <>
              <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
                <span style={{ color:'var(--muted)', fontSize:12 }}>Pokaż:</span>
                {[
                  { id:'all',       label:`Wszystkie (${job.results.length})` },
                  { id:'leads',     label:`Leady – brak WWW (${job.results.filter(r=>r.is_lead).length})` },
                  { id:'with_site', label:`Z WWW (${job.results.filter(r=>!r.is_lead).length})` },
                ].map(f => (
                  <button key={f.id} onClick={() => setFilter(f.id)} style={{
                    padding:'4px 12px', borderRadius:20,
                    border:`1px solid ${filter===f.id ? 'var(--accent)' : 'var(--border)'}`,
                    background: filter===f.id ? 'rgba(0,229,255,.1)' : 'transparent',
                    color: filter===f.id ? 'var(--accent)' : 'var(--muted)',
                    fontSize:12, cursor:'pointer', transition:'all .2s',
                  }}>{f.label}</button>
                ))}
              </div>
              <ResultsTable results={job.results} leadFilter={filter} />
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
//  FAVOURITES  (localStorage)
// ─────────────────────────────────────────────────────────────────────────────
const LS_KEY = 'firmscraper_favs'
function useFavourites() {
  const [favs, setFavs] = useState(() => {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]') } catch { return [] }
  })
  const save = fs => { setFavs(fs); localStorage.setItem(LS_KEY, JSON.stringify(fs)) }
  const add  = (name, query) => save([{ name, query, id: Date.now() }, ...favs.filter(f => f.query !== query)])
  const remove = id => save(favs.filter(f => f.id !== id))
  return { favs, add, remove }
}

// ─────────────────────────────────────────────────────────────────────────────
//  SEARCH FORM
// ─────────────────────────────────────────────────────────────────────────────
function SearchForm({ onSubmit, loading, favs, onAddFav, onRemoveFav }) {
  const [query,    setQuery]    = useState('')
  const [limit,    setLimit]    = useState(50)
  const [headless, setHeadless] = useState(true)
  const [proxy,    setProxy]    = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [showFavModal, setShowFavModal] = useState(false)
  const [favName,  setFavName]  = useState('')

  const citySuggestions = (() => {
    const word = query.trim().toLowerCase().split(' ')[0]
    return BRANCH_CITIES[word] || []
  })()

  function applySuggestion(city) {
    const words = query.trim().split(' ')
    const withoutCities = words.filter(w => !Object.values(BRANCH_CITIES).flat().includes(w))
    setQuery([...withoutCities, city].join(' '))
  }

  function handleSubmit() {
    if (!query.trim() || loading) return
    onSubmit({ query: query.trim(), limit, headless, proxy: proxy || null })
  }

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Enter' && !['INPUT','TEXTAREA'].includes(document.activeElement?.tagName) === false) return
      if (e.key === 'Enter' && document.activeElement?.type !== 'button') {
        if (query.trim() && !loading && !showFavModal) handleSubmit()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [query, loading, showFavModal])

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
      {/* Templates */}
      <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
        {TEMPLATES.map(t => (
          <button key={t} onClick={() => setQuery(t)} style={{ padding:'3px 10px', borderRadius:20, fontSize:11, border:'1px solid var(--border)', background:'transparent', color:'var(--muted)', cursor:'pointer', transition:'all .15s' }}
            onMouseEnter={e => { e.target.style.borderColor='var(--accent)'; e.target.style.color='var(--accent)' }}
            onMouseLeave={e => { e.target.style.borderColor='var(--border)'; e.target.style.color='var(--muted)' }}
          >{t}</button>
        ))}
      </div>

      {/* Main row */}
      <div style={{ display:'flex', gap:10 }}>
        <div style={{ position:'relative', flex:1 }}>
          <span style={{ position:'absolute', left:13, top:'50%', transform:'translateY(-50%)', color:'var(--muted)', fontSize:15, pointerEvents:'none' }}>⌕</span>
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder='np. "mechanik samochodowy Rybnik"' style={{ width:'100%', paddingLeft:36 }} disabled={loading} />
        </div>
        <input type="number" min={1} max={500} value={limit} onChange={e => setLimit(Number(e.target.value))} style={{ width:90 }} disabled={loading} title="Limit firm" />
        <button onClick={handleSubmit} disabled={loading || !query.trim()} style={{
          padding:'10px 24px', background: loading ? 'var(--surface2)' : 'linear-gradient(135deg, var(--accent2), var(--accent))',
          border:'none', borderRadius:'var(--radius)', color: loading ? 'var(--muted)' : '#000',
          fontWeight:700, fontSize:14, letterSpacing:'.04em', fontFamily:'var(--font-head)',
          opacity: loading ? .5 : 1, whiteSpace:'nowrap', cursor: loading ? 'not-allowed' : 'pointer',
        }}>
          {loading ? <span style={{ display:'inline-block', animation:'spin 1s linear infinite' }}>◌</span> : '▶ Skanuj'}
        </button>
      </div>

      {/* City autocomplete */}
      {citySuggestions.length > 0 && (
        <div style={{ display:'flex', gap:6, flexWrap:'wrap', alignItems:'center' }}>
          <span style={{ color:'var(--muted)', fontSize:11 }}>Miasto:</span>
          {citySuggestions.map(city => (
            <button key={city} onClick={() => applySuggestion(city)} style={{ padding:'2px 10px', borderRadius:20, fontSize:11, border:'1px solid var(--accent2)', background:'rgba(123,47,255,.08)', color:'var(--accent2)', cursor:'pointer', transition:'all .15s' }}
              onMouseEnter={e => { e.target.style.background='rgba(123,47,255,.22)' }}
              onMouseLeave={e => { e.target.style.background='rgba(123,47,255,.08)' }}
            >{city}</button>
          ))}
        </div>
      )}

      {/* Favourites */}
      {favs.length > 0 && (
        <div style={{ display:'flex', gap:6, flexWrap:'wrap', alignItems:'center' }}>
          <span style={{ color:'var(--muted)', fontSize:11 }}>★ Ulubione:</span>
          {favs.map(f => (
            <span key={f.id} style={{ display:'inline-flex', alignItems:'center' }}>
              <button onClick={() => setQuery(f.query)} style={{ padding:'2px 10px', borderRadius:'20px 0 0 20px', fontSize:11, border:'1px solid var(--warn)', borderRight:'none', background:'rgba(255,170,0,.08)', color:'var(--warn)', cursor:'pointer' }}>{f.name}</button>
              <button onClick={() => onRemoveFav(f.id)} style={{ padding:'2px 7px', borderRadius:'0 20px 20px 0', fontSize:10, border:'1px solid var(--warn)', borderLeft:'none', background:'rgba(255,170,0,.08)', color:'var(--warn)', cursor:'pointer' }}>✕</button>
            </span>
          ))}
        </div>
      )}

      {/* Bottom toolbar */}
      <div style={{ display:'flex', gap:14, alignItems:'center', flexWrap:'wrap' }}>
        <button type="button" onClick={() => setAdvanced(v => !v)} style={{ background:'none', border:'none', color:'var(--muted)', fontSize:12, padding:0, cursor:'pointer' }}>
          {advanced ? '▾' : '▸'} Zaawansowane
        </button>
        {query.trim() && (
          showFavModal
            ? <span style={{ display:'inline-flex', gap:6, alignItems:'center' }}>
                <input value={favName} onChange={e => setFavName(e.target.value)} placeholder="Nazwa ulubionego…" style={{ padding:'4px 10px', fontSize:12, width:170 }} autoFocus
                  onKeyDown={e => {
                    if (e.key === 'Enter' && favName.trim()) { onAddFav(favName.trim(), query.trim()); setFavName(''); setShowFavModal(false) }
                    if (e.key === 'Escape') setShowFavModal(false)
                  }}
                />
                <button onClick={() => { if (favName.trim()) { onAddFav(favName.trim(), query.trim()); setFavName(''); setShowFavModal(false) } }} style={{ padding:'4px 10px', fontSize:12, borderRadius:'var(--radius)', background:'var(--warn)', border:'none', color:'#000', cursor:'pointer', fontWeight:600 }}>Zapisz</button>
                <button onClick={() => setShowFavModal(false)} style={{ padding:'4px 8px', fontSize:12, borderRadius:'var(--radius)', background:'transparent', border:'1px solid var(--border)', color:'var(--muted)', cursor:'pointer' }}>✕</button>
              </span>
            : <button onClick={() => setShowFavModal(true)} style={{ background:'none', border:'none', color:'var(--warn)', fontSize:12, padding:0, cursor:'pointer' }}>★ Zapisz jako ulubione</button>
        )}
      </div>

      {advanced && (
        <div style={{ display:'flex', gap:12, flexWrap:'wrap', padding:'12px 14px', background:'var(--surface2)', border:'1px solid var(--border)', borderRadius:'var(--radius)', animation:'fadeIn .2s ease' }}>
          <label style={{ display:'flex', alignItems:'center', gap:8, cursor:'pointer', fontSize:13 }}>
            <input type="checkbox" checked={headless} onChange={e => setHeadless(e.target.checked)} style={{ width:'auto', accentColor:'var(--accent)' }} />
            Headless (bez okna przeglądarki)
          </label>
          <input value={proxy} onChange={e => setProxy(e.target.value)} placeholder="Proxy: http://user:pass@host:port" style={{ flex:1, minWidth:220 }} />
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
//  STATS BAR
// ─────────────────────────────────────────────────────────────────────────────
function StatsBar({ jobs }) {
  const total  = jobs.reduce((s,j) => s + j.results.length, 0)
  const leads  = jobs.reduce((s,j) => s + j.leads, 0)
  const active = jobs.filter(j => j.status === 'running').length
  return (
    <div style={{ display:'flex', gap:24, flexWrap:'wrap', borderBottom:'1px solid var(--border)', paddingBottom:16, marginBottom:24 }}>
      {[
        { label:'Zadania', value:jobs.length, color:'var(--text)' },
        { label:'Aktywne', value:active,      color:'var(--warn)' },
        { label:'Firmy',   value:total,        color:'var(--text)' },
        { label:'Leady',   value:leads,        color:'var(--accent)' },
      ].map(s => (
        <div key={s.label}>
          <div style={{ color:'var(--muted)', fontSize:11, letterSpacing:'.1em', textTransform:'uppercase' }}>{s.label}</div>
          <div style={{ fontFamily:'var(--font-head)', fontSize:26, fontWeight:800, color:s.color, lineHeight:1.1 }}>{s.value}</div>
        </div>
      ))}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
//  GRID BG
// ─────────────────────────────────────────────────────────────────────────────
function GridBg() {
  return (
    <div style={{ position:'fixed', inset:0, pointerEvents:'none', zIndex:0, backgroundImage:`linear-gradient(rgba(0,229,255,.025) 1px, transparent 1px),linear-gradient(90deg, rgba(0,229,255,.025) 1px, transparent 1px)`, backgroundSize:'48px 48px' }} />
  )
}

// ─────────────────────────────────────────────────────────────────────────────
//  APP
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
//  COOKIES UTILS
// ─────────────────────────────────────────────────────────────────────────────
const COOKIE_NAME = 'firmscraper_tos_accepted'
const setCookie = (name, value, days = 365) => {
  const d = new Date()
  d.setTime(d.getTime() + (days * 24 * 60 * 60 * 1000))
  document.cookie = `${name}=${value};expires=${d.toUTCString()};path=/`
}
const getCookie = (name) => {
  const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'))
  return match ? match[2] : null
}

// ─────────────────────────────────────────────────────────────────────────────
//  TERMS GATE
// ─────────────────────────────────────────────────────────────────────────────
function TermsGate({ onAccept }) {
  const [scrolled, setScrolled] = useState(false)
  const [phrase, setPhrase] = useState('')
  const scrollRef = useRef()
  const SECRET = "KPZsProductions"

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const isAtBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 10
    if (isAtBottom) setScrolled(true)
  }

  const isAccepted = scrolled && phrase === SECRET

  return (
    <div style={{
      position:'fixed', inset:0, zIndex:9999, background:'var(--bg)',
      display:'flex', alignItems:'center', justifyContent:'center', padding:20,
      backgroundImage:'radial-gradient(circle at 50% 50%, rgba(123,47,255,.05), transparent 70%)'
    }}>
      <div style={{
        maxWidth:600, width:'100%', background:'var(--surface)', border:'1px solid var(--border)',
        borderRadius:12, padding:'32px', boxShadow:'0 20px 50px rgba(0,0,0,.5)',
        display:'flex', flexDirection:'column', gap:20, animation:'fadeIn .5s ease'
      }}>
        <div style={{ textAlign:'center' }}>
          <h1 style={{ fontFamily:'var(--font-head)', fontSize:28, fontWeight:900, marginBottom:8 }}>
            <span style={{ color:'var(--accent)' }}>KPZs</span>Productions
          </h1>
          <div style={{ color:'var(--muted)', fontSize:12, textTransform:'uppercase', letterSpacing:'.2em' }}>Security Access Control</div>
        </div>

        <div style={{ fontSize:13, lineHeight:1.6, color:'var(--text)' }}>
          <p style={{ marginBottom:12, fontWeight:700, color:'var(--accent)' }}>
            ⚠ To narzędzie jest przeznaczone wyłącznie dla członków grupy KPZsProductions.
          </p>
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            style={{
              height:200, overflowY:'auto', background:'var(--bg)', padding:16,
              borderRadius:4, border:'1px solid var(--border)', fontSize:12, color:'var(--muted)'
            }}
          >
            <h4 style={{ color:'var(--text)', marginBottom:8 }}>WARUNKI UŻYTKOWANIA (ToS)</h4>
            <ol style={{ paddingLeft:16 }}>
              <li style={{ marginBottom:8 }}>Narzędzie służy do zbierania publicznie dostępnych danych z Google Maps.</li>
              <li style={{ marginBottom:8 }}>Użytkownik zobowiązuje się do przestrzegania <b>Google Maps Platform Terms of Service</b>.</li>
              <li style={{ marginBottom:8 }}>Wykorzystanie komercyjne przez osoby trzecie lub podmioty spoza KPZsProductions jest surowo zabronione i może naruszać zasady Google.</li>
              <li style={{ marginBottom:8 }}>KPZsProductions nie bierze odpowiedzialności za ewentualne blokady kont lub inne restrykcje nałożone przez Google w wyniku nadużywania narzędzia.</li>
              <li style={{ marginBottom:8 }}>Zabrania się odsprzedaży danych pozyskanych za pomocą tego skryptu bez wyraźnej zgody admistracji KPZs.</li>
              <li style={{ marginBottom:8 }}>Akceptując te warunki, potwierdzasz, że jesteś świadomy ryzyka związanego z automatyzacją przeglądarki.</li>
            </ol>
            <p style={{ marginTop:10 }}><i>Przewiń do samego dołu, aby odblokować akceptację.</i></p>
          </div>
        </div>

        <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
          <label style={{ fontSize:11, color:'var(--muted)', textTransform:'uppercase' }}>Weryfikacja tożsamości (Hasło):</label>
          <input
            type="password"
            value={phrase}
            onChange={e => setPhrase(e.target.value)}
            placeholder="Wpisz tajną frazę..."
            style={{ width:'100%', borderColor: phrase === SECRET ? 'var(--success)' : 'var(--border)' }}
          />
        </div>

        <button
          disabled={!isAccepted}
          onClick={() => onAccept()}
          style={{
            padding:'14px', borderRadius:8, border:'none',
            background: isAccepted ? 'linear-gradient(135deg, var(--accent2), var(--accent))' : 'var(--surface2)',
            color: isAccepted ? '#000' : 'var(--muted)',
            fontWeight:800, cursor: isAccepted ? 'pointer' : 'not-allowed',
            transition:'all .3s ease', boxShadow: isAccepted ? '0 0 20px rgba(0,229,255,.3)' : 'none'
          }}
        >
          {!scrolled ? 'PRZEWIŃ REGULAMIN' : phrase !== SECRET ? 'ZŁA FRAZA' : 'WEJDŹ DO SYSTEMU'}
        </button>

        {phrase !== '' && phrase !== SECRET && <div style={{ color:'var(--danger)', fontSize:11, textAlign:'center' }}>Niepoprawna fraza członka KPZs.</div>}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
//  APP
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const [jobs,     setJobs]     = useState([])
  const [activeId, setActiveId] = useState(null)
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState(null)
  const [accepted, setAccepted] = useState(() => !!getCookie(COOKIE_NAME))
  
  const pollerRef    = useRef(null)
  const prevStatuses = useRef({})
  const { toasts, add: addToast, remove: removeToast } = useToasts()
  const { favs, add: addFav, remove: removeFav }       = useFavourites()

  const pollJobs = useCallback(async () => {
    setJobs(prev => {
      const running = prev.filter(j => j.status === 'pending' || j.status === 'running')
      if (running.length === 0) return prev
      Promise.all(running.map(j => apiGet(`/api/jobs/${j.job_id}`))).then(updated => {
        setJobs(current => current.map(j => {
          const u = updated.find(x => x.job_id === j.job_id)
          if (!u) return j
          const prev = prevStatuses.current[j.job_id]
          if (prev && prev !== u.status) {
            if (u.status === 'done')  addToast(`„${u.query}" — gotowe! ${u.leads} leadów.`, 'success')
            if (u.status === 'error') addToast(`„${u.query}" — błąd scrapera.`, 'error')
          }
          prevStatuses.current[j.job_id] = u.status
          return u
        }))
      }).catch(() => {})
      return prev
    })
  }, [addToast])

  useEffect(() => {
    if (!accepted) return
    pollerRef.current = setInterval(pollJobs, 2000)
    return () => clearInterval(pollerRef.current)
  }, [pollJobs, accepted])

  async function handleSubmit(params) {
    setError(null); setLoading(true)
    try {
      const { job_id } = await apiPost('/api/scrape', params)
      const job = await apiGet(`/api/jobs/${job_id}`)
      prevStatuses.current[job_id] = 'pending'
      setJobs(prev => [job, ...prev])
      setActiveId(job_id)
      addToast(`Skanowanie „${params.query}" uruchomione.`, 'info')
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  async function handleDelete(job_id) {
    try {
      await apiDelete(`/api/jobs/${job_id}`)
      setJobs(prev => prev.filter(j => j.job_id !== job_id))
      if (activeId === job_id) setActiveId(null)
      delete prevStatuses.current[job_id]
    } catch (e) { setError(e.message) }
  }

  const handleAccept = () => {
    setCookie(COOKIE_NAME, 'true')
    setAccepted(true)
  }

  if (!accepted) return <><GridBg /><TermsGate onAccept={handleAccept} /></>

  return (
    <>
      <GridBg />
      <ToastContainer toasts={toasts} onRemove={removeToast} />
      <div style={{ position:'relative', zIndex:1, minHeight:'100vh', display:'flex', flexDirection:'column' }}>
        <header style={{ borderBottom:'1px solid var(--border)', padding:'0 32px', display:'flex', alignItems:'center', height:58, background:'rgba(10,10,15,.85)', backdropFilter:'blur(12px)', position:'sticky', top:0, zIndex:10 }}>
          <div style={{ display:'flex', alignItems:'baseline', gap:10 }}>
            <span style={{ fontFamily:'var(--font-head)', fontWeight:800, fontSize:20, letterSpacing:'-.01em' }}>
              <span style={{ color:'var(--accent)' }}>Firm</span><span style={{ color:'var(--text)' }}>Scraper</span>
            </span>
            <span style={{ fontSize:10, color:'var(--muted)', border:'1px solid var(--border)', borderRadius:3, padding:'1px 6px', letterSpacing:'.08em' }}>v3.0</span>
          </div>
          <div style={{ flex:1 }} />
          <div style={{ fontSize:12, color:'var(--muted)' }}>Google Maps Lead Generator</div>
        </header>

        <main style={{ flex:1, padding:'32px', maxWidth:1150, margin:'0 auto', width:'100%' }}>
          <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:10, padding:'24px', marginBottom:28 }}>
            <div style={{ fontFamily:'var(--font-head)', fontWeight:700, fontSize:13, color:'var(--muted)', letterSpacing:'.1em', textTransform:'uppercase', marginBottom:14 }}>Nowe skanowanie</div>
            <SearchForm onSubmit={handleSubmit} loading={loading} favs={favs} onAddFav={addFav} onRemoveFav={removeFav} />
            {error && <div style={{ marginTop:12, padding:'10px 14px', background:'rgba(255,61,113,.1)', border:'1px solid var(--danger)', borderRadius:'var(--radius)', color:'var(--danger)', fontSize:13 }}>⚠ {error}</div>}
          </div>

          {jobs.length > 0 && <StatsBar jobs={jobs} />}

          {jobs.length === 0
            ? <div style={{ textAlign:'center', padding:'64px 0', color:'var(--muted)' }}>
                <div style={{ fontSize:40, marginBottom:12 }}>⌕</div>
                <div style={{ fontFamily:'var(--font-head)', fontSize:18, marginBottom:6 }}>Brak zadań</div>
                <div style={{ fontSize:13 }}>Wpisz frazę powyżej i kliknij „Skanuj", aby rozpocząć zbieranie danych.</div>
              </div>
            : <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                {jobs.map(job => (
                  <JobCard key={job.job_id} job={job} active={activeId === job.job_id}
                    onClick={() => setActiveId(id => id === job.job_id ? null : job.job_id)}
                    onDelete={handleDelete}
                  />
                ))}
              </div>
          }
        </main>

        <footer style={{ borderTop:'1px solid var(--border)', padding:'14px 32px', display:'flex', justifyContent:'space-between', alignItems:'center', color:'var(--muted)', fontSize:12 }}>
          <span>FirmScraper © {new Date().getFullYear()}</span>
          <span>Backend: <span style={{ color:'var(--accent)' }}>FastAPI</span> · Scraper: <span style={{ color:'var(--accent)' }}>Playwright</span></span>
        </footer>
      </div>
    </>
  )
}
