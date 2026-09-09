import { createMimitLiveClient } from '../shared/mimit-live.ts'
import type { MimitLiveCache } from '../shared/mimit-live.ts'
import type { SearchArea, StatusResponse } from '../shared/types.ts'

export interface Env {
  DB: D1Database
  APP_ORIGIN?: string
  APP_BASE_PATH?: string
  VAPID_PUBLIC_KEY: string
  JOB_TOKEN: string
  GEOCODER_URL?: string
  MIMIT_API_URL?: string
}

type Json = Record<string, unknown>
type SnapshotRow = {
  version: string
  status: string
  published: number
  created_at: string
  station_count: number
  price_count: number
  source_date: string
  last_refresh_at: string
  warning: string | null
  cells_json: string
}

const DEFAULT_ORIGIN = 'https://gianmarcotacchini92.github.io'
const DEFAULT_GEOCODER = 'https://photon.komoot.io/api/'
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
const CELL_RE = /^\d{1,3}_\d{1,3}$/
const VERSION_RE = /^[a-f0-9]{32}$/
const HEX64_RE = /^[a-f0-9]{64}$/
const MAX_PUBLIC_BODY = 16 * 1024
const MAX_INTERNAL_TILE_BODY = Math.floor(1.5 * 1024 * 1024)
const MAX_INTERNAL_BODY = 1024 * 1024
const WEEK_MS = 7 * 86_400_000

function appOrigin(env: Env) { return env.APP_ORIGIN || DEFAULT_ORIGIN }

function corsHeaders(request: Request, env: Env): HeadersInit {
  const origin = request.headers.get('Origin')
  const allowed = appOrigin(env)
  return origin === allowed ? {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Vary': 'Origin',
  } : { 'Vary': 'Origin' }
}

function withCors(response: Response, request: Request, env: Env) {
  const headers = new Headers(response.headers)
  for (const [key, value] of Object.entries(corsHeaders(request, env))) headers.set(key, value)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

function json(data: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } })
}

class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly details?: unknown) { super(message) }
}

function fail(status: number, message: string): never { throw new ApiError(status, message) }

async function readText(request: Request, maxBytes: number) {
  const len = request.headers.get('Content-Length')
  if (len && Number(len) > maxBytes) fail(413, 'Richiesta troppo grande.')
  if (!request.body) return ''
  const reader = request.body.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) {
        await reader.cancel()
        fail(413, 'Richiesta troppo grande.')
      }
      chunks.push(decoder.decode(value, { stream: true }))
    }
    chunks.push(decoder.decode())
    return chunks.join('')
  } finally { reader.releaseLock() }
}

async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  const text = await readText(request, maxBytes)
  try { return text ? JSON.parse(text) : {} } catch { fail(400, 'JSON non valido.') }
}

function asObj(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Parametri non validi.')
  return value as Json
}

function requireString(value: unknown, min: number, max: number) {
  if (typeof value !== 'string') fail(400, 'Parametri non validi.')
  const trimmed = value.trim()
  if (trimmed.length < min || trimmed.length > max) fail(400, 'Parametri non validi.')
  return trimmed
}

function numberIn(value: unknown, min: number, max: number) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < min || n > max) fail(400, 'Parametri non validi.')
  return n
}

function integerIn(value: unknown, min: number, max: number) {
  const n = numberIn(value, min, max)
  if (!Number.isInteger(n)) fail(400, 'Parametri non validi.')
  return n
}

function validateMonitor(input: unknown) {
  const obj = asObj(input)
  const fuel = obj.fuel
  const service = obj.service
  if (!['benzina', 'gasolio', 'gpl', 'metano'].includes(String(fuel))) fail(400, 'Parametri non validi.')
  if (!['self', 'servito', 'all'].includes(String(service))) fail(400, 'Parametri non validi.')
  return {
    lat: numberIn(obj.lat, 35, 48),
    lon: numberIn(obj.lon, 6, 19),
    radius: numberIn(obj.radius, 1, 30),
    fuel: fuel as string,
    service: service as string,
    label: requireString(obj.label, 1, 250),
  }
}

function allowedPushEndpoint(endpoint: string) {
  let url: URL
  try { url = new URL(endpoint) } catch { return false }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) return false
  return ['fcm.googleapis.com', 'fcm-x.googleapis.com', 'updates.push.services.mozilla.com', 'push.services.mozilla.com', 'web.push.apple.com']
    .includes(url.hostname) || url.hostname.endsWith('.notify.windows.com') || url.hostname.endsWith('.push.apple.com')
}

function base64UrlBytes(value: unknown, bytes: number) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) fail(400, 'Chiave push non valida.')
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4)
    const binary = atob(padded)
    if (binary.length !== bytes) fail(400, 'Chiave push non valida.')
  } catch (error) {
    if (error instanceof ApiError) throw error
    fail(400, 'Chiave push non valida.')
  }
  return value
}

function validateSubscription(input: unknown) {
  const obj = asObj(input)
  const endpoint = requireString(obj.endpoint, 1, 4096)
  if (!allowedPushEndpoint(endpoint)) fail(400, 'Servizio push non supportato. Usa Chrome, Edge, Firefox o Safari.')
  const keys = asObj(obj.keys)
  const out: Json = {
    endpoint,
    keys: { p256dh: base64UrlBytes(keys.p256dh, 65), auth: base64UrlBytes(keys.auth, 16) },
  }
  if ('expirationTime' in obj) {
    if (obj.expirationTime !== null && typeof obj.expirationTime !== 'number') fail(400, 'Parametri non validi.')
    out.expirationTime = obj.expirationTime
  }
  return out
}

function validateCreateSubscription(input: unknown) {
  const obj = asObj(input)
  return { subscription: validateSubscription(obj.subscription), monitor: validateMonitor(obj.monitor) }
}

function timingSafeEqualHex(a: string, b: string) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function bytesToHex(bytes: Uint8Array) { return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('') }

function randomHex(bytes: number) {
  const data = new Uint8Array(bytes)
  crypto.getRandomValues(data)
  return bytesToHex(data)
}

async function sha256Hex(value: string) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
}

function bearer(request: Request) {
  const h = request.headers.get('Authorization') || ''
  return h.startsWith('Bearer ') ? h.slice(7) : ''
}

function requireOrigin(request: Request, env: Env) {
  if (request.headers.get('Origin') !== appOrigin(env)) fail(403, 'Origine della richiesta non consentita. Controlla APP_ORIGIN.')
}

async function requireJob(request: Request, env: Env) {
  const token = bearer(request)
  if (!env.JOB_TOKEN || !token || token !== env.JOB_TOKEN) fail(401, 'Autorizzazione interna non valida.')
}

function clientIp(request: Request) {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || 'unknown'
}

async function rateLimitSubscriptionWrite(db: D1Database, request: Request) {
  const minute = Math.floor(Date.now() / 60_000)
  const key = `sub:${clientIp(request)}:${minute}`
  await db.prepare('INSERT OR IGNORE INTO limits(key,value) VALUES(?,0)').bind(key).run()
  const result = await db.prepare('UPDATE limits SET value = value + 1 WHERE key = ? AND value < 5').bind(key).run()
  if ((result.meta?.changes ?? 0) !== 1) fail(429, 'Troppe attivazioni. Riprova tra un minuto.')
}

async function rateLimitLiveSource(db: D1Database, request: Request, env: Env) {
  if (env.JOB_TOKEN && bearer(request) === env.JOB_TOKEN) return
  const minute = Math.floor(Date.now() / 60_000)
  const key = `live:${clientIp(request)}:${minute}`
  await db.prepare('INSERT OR IGNORE INTO limits(key,value) VALUES(?,0)').bind(key).run()
  const result = await db.prepare('UPDATE limits SET value = value + 1 WHERE key = ? AND value < 30').bind(key).run()
  if ((result.meta?.changes ?? 0) !== 1) fail(429, 'Troppe richieste alla fonte live. Riprova tra un minuto.')
}

function validateAreaParams(params: URLSearchParams): SearchArea {
  const fuel = params.get('fuel')
  const service = params.get('service')
  if (!['benzina', 'gasolio', 'gpl', 'metano'].includes(String(fuel))) fail(400, 'Parametri non validi.')
  if (!['self', 'servito', 'all'].includes(String(service))) fail(400, 'Parametri non validi.')
  return {
    lat: numberIn(params.get('lat'), 35, 48),
    lon: numberIn(params.get('lon'), 6, 19),
    radius: numberIn(params.get('radius'), 1, 30),
    fuel: fuel as SearchArea['fuel'],
    service: service as SearchArea['service'],
  }
}

function refreshParam(params: URLSearchParams) {
  const refresh = params.get('refresh')
  if (refresh === null) return false
  if (refresh === '1') return true
  fail(400, 'Parametri non validi.')
}

function liveStatus(): StatusResponse {
  return {
    ready: true, refreshing: false, lastRefreshAt: null, sourceDate: null,
    stationCount: 0, priceCount: 0, warning: null, dataSource: 'live',
  }
}

function liveCache(db: D1Database): MimitLiveCache {
  return {
    async get(key: string, maxAgeSeconds: number) {
      const row = await db.prepare('SELECT payload FROM mimit_cache WHERE key = ? AND created_at >= ?')
        .bind(key, Date.now() - maxAgeSeconds * 1000).first<{ payload: string }>()
      return row?.payload ?? null
    },
    async set(key: string, payload: string) {
      const now = Date.now()
      await db.batch([
        db.prepare('INSERT INTO mimit_cache(key,payload,created_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload, created_at=excluded.created_at')
          .bind(key, payload, now),
        db.prepare('DELETE FROM mimit_cache WHERE created_at < ?').bind(now - 24 * 3_600_000),
        db.prepare('DELETE FROM mimit_cache WHERE key IN (SELECT key FROM mimit_cache ORDER BY created_at DESC LIMIT -1 OFFSET 1000)'),
      ])
    },
  }
}

function liveClient(request: Request, env: Env) {
  return createMimitLiveClient({
    cache: liveCache(env.DB),
    baseUrl: env.MIMIT_API_URL,
    beforeUncachedRequest: () => rateLimitLiveSource(env.DB, request, env),
  })
}

async function handleLiveStations(request: Request, env: Env) {
  const url = new URL(request.url)
  const area = validateAreaParams(url.searchParams)
  return json(await liveClient(request, env).fetchStations(area, { refresh: refreshParam(url.searchParams) }))
}

async function handleLiveStationDetail(request: Request, env: Env, rawId: string) {
  const url = new URL(request.url)
  const id = integerIn(rawId, 1, 50_000_000)
  return json(await liveClient(request, env).fetchStation(id, { refresh: refreshParam(url.searchParams) }))
}

function snapshotResponse(row: SnapshotRow, warning = row.warning) {
  return {
    ready: true,
    refreshing: false,
    lastRefreshAt: row.last_refresh_at,
    sourceDate: row.source_date,
    stationCount: row.station_count,
    priceCount: row.price_count,
    warning,
    catalogVersion: row.version,
  }
}

function freshnessWarning(row: SnapshotRow | null, storedWarning?: string | null) {
  if (!row) return null
  const now = Date.now()
  if (now - Date.parse(row.last_refresh_at) > 36 * 3_600_000) return 'Copia locale dei prezzi vecchia di oltre 36 ore.'
  if (now - Date.parse(`${row.source_date}T00:00:00Z`) > 72 * 3_600_000) return 'Fonte ufficiale MIMIT vecchia di oltre 72 ore.'
  return storedWarning ?? row.warning
}

async function currentSnapshot(db: D1Database) {
  const meta = await db.prepare('SELECT value FROM metadata WHERE key = ?').bind('currentVersion').first<{ value: string }>()
  if (!meta) return null
  return await db.prepare('SELECT * FROM snapshots WHERE version = ? AND published = 1').bind(meta.value).first<SnapshotRow>()
}

async function handleStatus(env: Env) {
  void env
  return json(liveStatus())
}

async function handleCatalog(env: Env, version: string, cell: string) {
  if (!VERSION_RE.test(version) || !CELL_RE.test(cell)) fail(404, 'Risorsa non trovata.')
  const snap = await env.DB.prepare('SELECT version FROM snapshots WHERE version = ? AND published = 1').bind(version).first()
  if (!snap) fail(404, 'Catalogo non disponibile.')
  const row = await env.DB.prepare('SELECT payload FROM tiles WHERE version = ? AND cell = ?').bind(version, cell).first<{ payload: string }>()
  return new Response(row?.payload ?? '[]', {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=86400, immutable' },
  })
}

function photonPlaces(data: unknown) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail(502, 'Il servizio di ricerca indirizzi ha restituito dati non validi.')
  const obj = data as Json
  if (!Array.isArray(obj.features)) fail(502, 'Il servizio di ricerca indirizzi ha restituito dati non validi.')
  return obj.features.flatMap((feature) => {
    if (!feature || typeof feature !== 'object') return []
    const f = feature as Json
    const geometry = f.geometry as Json | undefined
    const props = f.properties as Json | undefined
    const coordinates = geometry?.coordinates
    if (!Array.isArray(coordinates) || coordinates.length < 2 || !props) return []
    if (String(props.countrycode || '').toUpperCase() !== 'IT') return []
    const lon = Number(coordinates[0])
    const lat = Number(coordinates[1])
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 35 || lat > 48 || lon < 6 || lon > 19) return []
    const street = [props.street, props.housenumber].filter((v) => typeof v === 'string' && v).join(' ')
    const parts = [props.name, street, props.postcode, props.city || props.district, props.state]
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
    const label = [...new Set(parts)].join(', ')
    return label ? [{ lat, lon, label }] : []
  })
}

async function acquireGeocodeSlot(db: D1Database) {
  const now = Date.now()
  await db.prepare('INSERT OR IGNORE INTO limits(key,value) VALUES(?,0)').bind('geocode_next').run()
  const result = await db.prepare('UPDATE limits SET value = ? WHERE key = ? AND value <= ?').bind(now + 1100, 'geocode_next', now).run()
  return (result.meta?.changes ?? 0) === 1
}

async function handleGeocode(request: Request, env: Env) {
  const origin = request.headers.get('Origin')
  if (origin && origin !== appOrigin(env)) fail(403, 'Origine della richiesta non consentita. Controlla APP_ORIGIN.')
  const url = new URL(request.url)
  const q = requireString(url.searchParams.get('q'), 3, 200)
  const key = q.toLocaleLowerCase('it-IT').trim()
  const cached = await env.DB.prepare('SELECT response FROM geocode_cache WHERE query = ? AND created_at > ?').bind(key, Date.now() - WEEK_MS).first<{ response: string }>()
  if (cached) return json({ results: JSON.parse(cached.response) })
  if (!await acquireGeocodeSlot(env.DB)) fail(429, 'Troppe ricerche di indirizzi. Riprova tra qualche secondo.')
  const upstream = new URL(env.GEOCODER_URL || DEFAULT_GEOCODER)
  upstream.search = new URLSearchParams({ q, limit: '6', bbox: '6.0,35.0,19.0,48.0' }).toString()
  let data: unknown
  try {
    const res = await fetch(upstream, {
      headers: { Accept: 'application/json', 'User-Agent': 'Pieno/1.0 (fuel-price-map)' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    data = await res.json()
  } catch (error) {
    console.error('Geocodifica non disponibile:', error instanceof Error ? error.message : 'errore remoto')
    fail(502, 'Il servizio di ricerca indirizzi non risponde. Riprova o usa la posizione GPS.')
  }
  const places = photonPlaces(data)
  await env.DB.batch([
    env.DB.prepare('INSERT INTO geocode_cache(query,response,created_at) VALUES(?,?,?) ON CONFLICT(query) DO UPDATE SET response=excluded.response, created_at=excluded.created_at').bind(key, JSON.stringify(places), Date.now()),
    env.DB.prepare('DELETE FROM geocode_cache WHERE query IN (SELECT query FROM geocode_cache ORDER BY created_at DESC LIMIT -1 OFFSET 1000)'),
    env.DB.prepare('DELETE FROM geocode_cache WHERE created_at < ?').bind(Date.now() - WEEK_MS),
  ])
  return json({ results: places })
}

async function authorizeSubscription(db: D1Database, id: string, request: Request) {
  const token = bearer(request)
  if (!HEX64_RE.test(token)) fail(401, 'Autorizzazione notifiche non valida.')
  const row = await db.prepare('SELECT id, token_hash, monitor FROM subscriptions WHERE id = ?').bind(id).first<{ id: string; token_hash: string; monitor: string }>()
  if (!row) fail(404, 'Monitoraggio non trovato. Attiva nuovamente le notifiche.')
  const tokenHash = await sha256Hex(token)
  if (!timingSafeEqualHex(tokenHash, row.token_hash)) fail(403, 'Non puoi modificare questo monitoraggio.')
  return row
}

async function createSubscription(request: Request, env: Env) {
  requireOrigin(request, env)
  await rateLimitSubscriptionWrite(env.DB, request)
  const body = validateCreateSubscription(await readJson(request, MAX_PUBLIC_BODY))
  const duplicate = await env.DB.prepare('SELECT id FROM subscriptions WHERE endpoint = ?').bind(String(body.subscription.endpoint)).first()
  if (duplicate) fail(409, 'Questo browser ha gia un monitoraggio. Ripristina la sottoscrizione per attivarlo nuovamente.')
  const count = await env.DB.prepare('SELECT COUNT(*) AS total FROM subscriptions').first<{ total: number }>()
  if ((count?.total ?? 0) >= 1000) fail(503, 'Limite monitoraggi raggiunto. Contatta il gestore del servizio.')
  const token = randomHex(32)
  const id = crypto.randomUUID()
  await env.DB.prepare('INSERT INTO subscriptions(id,token_hash,endpoint,subscription,monitor,created_at) VALUES(?,?,?,?,?,?)')
    .bind(id, await sha256Hex(token), String(body.subscription.endpoint), JSON.stringify(body.subscription), JSON.stringify(body.monitor), new Date().toISOString()).run()
  return json({ id, token }, 201)
}

async function getSubscription(request: Request, env: Env, id: string) {
  const row = await authorizeSubscription(env.DB, id, request)
  return json({ monitor: JSON.parse(row.monitor) })
}

async function putSubscription(request: Request, env: Env, id: string) {
  requireOrigin(request, env)
  const row = await authorizeSubscription(env.DB, id, request)
  const obj = asObj(await readJson(request, MAX_PUBLIC_BODY))
  const monitor = validateMonitor(obj.monitor)
  const serialized = JSON.stringify(monitor)
  if (serialized !== row.monitor) {
    await env.DB.batch([
      env.DB.prepare('UPDATE subscriptions SET monitor = ? WHERE id = ?').bind(serialized, id),
      env.DB.prepare('DELETE FROM push_sent WHERE subscription_id = ?').bind(id),
    ])
  }
  return json({ monitor })
}

async function deleteSubscription(request: Request, env: Env, id: string) {
  requireOrigin(request, env)
  const exists = await env.DB.prepare('SELECT id FROM subscriptions WHERE id = ?').bind(id).first()
  if (!exists) return new Response(null, { status: 204, headers: JSON_HEADERS })
  await authorizeSubscription(env.DB, id, request)
  await env.DB.batch([
    env.DB.prepare('DELETE FROM push_sent WHERE subscription_id = ?').bind(id),
    env.DB.prepare('DELETE FROM subscriptions WHERE id = ?').bind(id),
  ])
  return new Response(null, { status: 204, headers: JSON_HEADERS })
}

function validateSnapshot(input: unknown) {
  const obj = asObj(asObj(input).snapshot)
  const version = requireString(obj.catalogVersion, 32, 32)
  if (!VERSION_RE.test(version)) fail(400, 'Versione catalogo non valida.')
  const cells = obj.cells
  if (!Array.isArray(cells) || cells.length < 1 || cells.length > 2000 || !cells.every((c) => typeof c === 'string' && CELL_RE.test(c))) fail(400, 'Celle catalogo non valide.')
  const uniqueCells = [...new Set(cells)]
  if (uniqueCells.length !== cells.length) fail(400, 'Celle catalogo duplicate.')
  const sourceDate = requireString(obj.sourceDate, 10, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sourceDate) || !Number.isFinite(Date.parse(`${sourceDate}T00:00:00Z`))) fail(400, 'Data fonte non valida.')
  const lastRefreshAt = requireString(obj.lastRefreshAt, 10, 80)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(lastRefreshAt) || !Number.isFinite(Date.parse(lastRefreshAt))) fail(400, 'Aggiornamento non valido.')
  const stationCount = integerIn(obj.stationCount, 1, 50_000_000)
  const priceCount = integerIn(obj.priceCount, 1, 50_000_000)
  return { version, cells, stationCount, priceCount, sourceDate, lastRefreshAt }
}

async function internalSnapshot(env: Env) {
  const row = await currentSnapshot(env.DB)
  if (!row) fail(404, 'Catalogo non disponibile.')
  const warning = await env.DB.prepare('SELECT value FROM metadata WHERE key = ?').bind('warning').first<{ value: string }>()
  return json({ ...snapshotResponse(row, freshnessWarning(row, warning?.value)), cells: JSON.parse(row.cells_json) })
}

async function beginSnapshot(request: Request, env: Env) {
  const s = validateSnapshot(await readJson(request, MAX_INTERNAL_BODY))
  const existing = await env.DB.prepare('SELECT version FROM snapshots WHERE version = ?').bind(s.version).first()
  if (existing) fail(409, 'Snapshot gia presente.')
  await env.DB.prepare('INSERT INTO snapshots(version,status,published,created_at,station_count,price_count,source_date,last_refresh_at,cells_json) VALUES(?,?,?,?,?,?,?,?,?)')
    .bind(s.version, 'pending', 0, new Date().toISOString(), s.stationCount, s.priceCount, s.sourceDate, s.lastRefreshAt, JSON.stringify(s.cells)).run()
  return json({ ok: true }, 201)
}

async function putTile(request: Request, env: Env, version: string, cell: string) {
  if (!VERSION_RE.test(version) || !CELL_RE.test(cell)) fail(404, 'Risorsa non trovata.')
  const snap = await env.DB.prepare('SELECT cells_json FROM snapshots WHERE version = ? AND published = 0').bind(version).first<{ cells_json: string }>()
  if (!snap) fail(404, 'Snapshot non pronto.')
  if (!(JSON.parse(snap.cells_json) as string[]).includes(cell)) fail(400, 'Cella non prevista nello snapshot.')
  const body = await readText(request, MAX_INTERNAL_TILE_BODY)
  const trimmed = body.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) fail(400, 'Tile catalogo non valido.')
  try { JSON.parse(trimmed) } catch { fail(400, 'Tile catalogo non valido.') }
  await env.DB.prepare('INSERT INTO tiles(version,cell,payload) VALUES(?,?,?) ON CONFLICT(version,cell) DO UPDATE SET payload=excluded.payload')
    .bind(version, cell, trimmed).run()
  return json({ ok: true })
}

async function cleanupPublished(env: Env) {
  const rows = await env.DB.prepare('SELECT version FROM snapshots WHERE published = 1 ORDER BY created_at DESC LIMIT -1 OFFSET 2').all<{ version: string }>()
  const stale = rows.results ?? []
  if (stale.length) {
    await env.DB.batch(stale.flatMap((r) => [
      env.DB.prepare('DELETE FROM tiles WHERE version = ?').bind(r.version),
      env.DB.prepare('DELETE FROM snapshots WHERE version = ?').bind(r.version),
    ]))
  }
}

async function cleanupAbandoned(env: Env) {
  const cutoff = new Date(Date.now() - 24 * 3_600_000).toISOString()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM tiles WHERE version IN (SELECT version FROM snapshots WHERE published = 0 AND created_at < ?)').bind(cutoff),
    env.DB.prepare('DELETE FROM snapshots WHERE published = 0 AND created_at < ?').bind(cutoff),
  ])
}

async function commitSnapshot(env: Env, version: string) {
  if (!VERSION_RE.test(version)) fail(404, 'Risorsa non trovata.')
  const snap = await env.DB.prepare('SELECT * FROM snapshots WHERE version = ? AND published = 0').bind(version).first<SnapshotRow>()
  if (!snap) fail(404, 'Snapshot non pronto.')
  const current = await currentSnapshot(env.DB)
  if (current && snap.source_date < current.source_date) fail(409, 'Il catalogo ricevuto e piu vecchio di quello pubblicato.')
  if (Date.now() - Date.parse(`${snap.source_date}T00:00:00Z`) > 72 * 3_600_000) fail(400, 'Fonte ufficiale troppo vecchia per la pubblicazione.')
  const expected = (JSON.parse(snap.cells_json) as string[]).length
  const count = await env.DB.prepare('SELECT COUNT(*) AS total FROM tiles WHERE version = ?').bind(version).first<{ total: number }>()
  if ((count?.total ?? 0) !== expected) fail(409, 'Snapshot incompleto.')
  await env.DB.batch([
    env.DB.prepare('UPDATE snapshots SET published = 1, status = ? WHERE version = ? AND published = 0').bind('published', version),
    env.DB.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind('currentVersion', version),
    env.DB.prepare('DELETE FROM metadata WHERE key = ?').bind('warning'),
  ])
  await cleanupPublished(env)
  await cleanupAbandoned(env)
  return json({ ok: true })
}

function safeFailureMessage(input: unknown) {
  const raw = asObj(input).error
  if (typeof raw !== 'string' || raw.length > 2000) fail(400, 'Parametri non validi.')
  return 'Aggiornamento catalogo non riuscito; resta disponibile la copia precedente.'
}

async function failureSnapshot(request: Request, env: Env) {
  await env.DB.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .bind('warning', safeFailureMessage(await readJson(request, MAX_INTERNAL_BODY))).run()
  return json({ ok: true })
}

async function cleanup(env: Env) {
  const oldCache = Date.now() - WEEK_MS
  const oldSent = new Date(Date.now() - 90 * 86_400_000).toISOString()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM geocode_cache WHERE created_at < ?').bind(oldCache),
    env.DB.prepare('DELETE FROM push_sent WHERE sent_at < ?').bind(oldSent),
    env.DB.prepare('DELETE FROM tiles WHERE version IN (SELECT version FROM snapshots WHERE published = 0 AND created_at < ?)').bind(new Date(Date.now() - 24 * 3_600_000).toISOString()),
    env.DB.prepare('DELETE FROM snapshots WHERE published = 0 AND created_at < ?').bind(new Date(Date.now() - 24 * 3_600_000).toISOString()),
    env.DB.prepare('DELETE FROM limits WHERE key LIKE ? OR key LIKE ?').bind('sub:%', 'live:%'),
    env.DB.prepare('DELETE FROM mimit_cache WHERE created_at < ?').bind(Date.now() - 24 * 3_600_000),
    env.DB.prepare('DELETE FROM mimit_cache WHERE key IN (SELECT key FROM mimit_cache ORDER BY created_at DESC LIMIT -1 OFFSET 1000)'),
  ])
  await cleanupPublished(env)
  return json({ ok: true })
}

async function monitors(request: Request, env: Env) {
  const url = new URL(request.url)
  const after = url.searchParams.get('after') || ''
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 25), 1), 25)
  const rows = await env.DB.prepare(`SELECT s.id, s.subscription, s.monitor,
    COALESCE((SELECT json_group_array(p.fingerprint) FROM push_sent p WHERE p.subscription_id = s.id), '[]') AS sent
    FROM subscriptions s WHERE s.id > ? ORDER BY s.id LIMIT ?`).bind(after, limit).all<{ id: string; subscription: string; monitor: string; sent: string }>()
  const list = rows.results ?? []
  return json({ monitors: list, nextCursor: list.length === limit ? list[list.length - 1]!.id : null })
}

async function ackMonitor(request: Request, env: Env, id: string) {
  const body = asObj(await readJson(request, MAX_INTERNAL_BODY))
  const monitor = requireString(body.monitor, 1, 16_000)
  const fps = body.fingerprints
  if (!Array.isArray(fps) || fps.length > 2000 || !fps.every((v) => typeof v === 'string' && v.length > 0 && v.length <= 500)) fail(400, 'Parametri non validi.')
  const row = await env.DB.prepare('SELECT monitor FROM subscriptions WHERE id = ?').bind(id).first<{ monitor: string }>()
  if (!row || row.monitor !== monitor) fail(409, 'Monitoraggio modificato.')
  const now = new Date().toISOString()
  for (let i = 0; i < fps.length; i += 45) {
    await env.DB.batch(fps.slice(i, i + 45).map((fp) => env.DB.prepare(`INSERT OR IGNORE INTO push_sent(subscription_id,fingerprint,sent_at)
      SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM subscriptions WHERE id = ? AND monitor = ?)`).
      bind(id, fp, now, id, monitor)))
  }
  return json({ ok: true })
}

async function deleteMonitor(env: Env, id: string) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM push_sent WHERE subscription_id = ?').bind(id),
    env.DB.prepare('DELETE FROM subscriptions WHERE id = ?').bind(id),
  ])
  return new Response(null, { status: 204, headers: JSON_HEADERS })
}

async function routeInternal(request: Request, env: Env, path: string) {
  await requireJob(request, env)
  if (request.method === 'GET' && path === '/internal/snapshot') return internalSnapshot(env)
  if (request.method === 'POST' && path === '/internal/snapshot/begin') return beginSnapshot(request, env)
  if (request.method === 'POST' && path === '/internal/snapshot/failure') return failureSnapshot(request, env)
  if (request.method === 'POST' && path === '/internal/cleanup') return cleanup(env)
  if (request.method === 'GET' && path === '/internal/monitors') return monitors(request, env)
  let match = path.match(/^\/internal\/snapshot\/([^/]+)\/tiles\/([^/]+)$/)
  if (request.method === 'PUT' && match) return putTile(request, env, match[1]!, match[2]!)
  match = path.match(/^\/internal\/snapshot\/([^/]+)\/commit$/)
  if (request.method === 'POST' && match) return commitSnapshot(env, match[1]!)
  match = path.match(/^\/internal\/monitors\/([^/]+)\/ack$/)
  if (match && request.method === 'POST') return ackMonitor(request, env, decodeURIComponent(match[1]!))
  match = path.match(/^\/internal\/monitors\/([^/]+)$/)
  if (match && request.method === 'DELETE') return deleteMonitor(env, decodeURIComponent(match[1]!))
  fail(404, 'Risorsa non trovata.')
}

async function routeApi(request: Request, env: Env, path: string) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request, env) })
  if (['POST', 'PUT', 'DELETE'].includes(request.method)) requireOrigin(request, env)
  if (request.method === 'GET' && path === '/api/status') return handleStatus(env)
  if (request.method === 'GET' && path === '/api/stations') return handleLiveStations(request, env)
  if (request.method === 'GET' && path === '/api/geocode') return handleGeocode(request, env)
  if (request.method === 'GET' && path === '/api/push/public-key') return json({ publicKey: env.VAPID_PUBLIC_KEY })
  if (request.method === 'POST' && path === '/api/push/subscriptions') return createSubscription(request, env)
  let match = path.match(/^\/api\/catalog\/([^/]+)\/([^/]+)$/)
  if (request.method === 'GET' && match) return handleCatalog(env, match[1]!, match[2]!)
  match = path.match(/^\/api\/stations\/([^/]+)$/)
  if (request.method === 'GET' && match) return handleLiveStationDetail(request, env, decodeURIComponent(match[1]!))
  match = path.match(/^\/api\/push\/subscriptions\/([^/]+)$/)
  if (match) {
    const id = decodeURIComponent(match[1]!)
    if (request.method === 'GET') return getSubscription(request, env, id)
    if (request.method === 'PUT') return putSubscription(request, env, id)
    if (request.method === 'DELETE') return deleteSubscription(request, env, id)
  }
  fail(404, 'Risorsa non trovata.')
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  try {
    if (path.startsWith('/internal/')) return await routeInternal(request, env, path)
    if (path.startsWith('/api/')) return withCors(await routeApi(request, env, path), request, env)
    return withCors(json({ error: 'Risorsa non trovata.' }, 404), request, env)
  } catch (error) {
    if (error instanceof ApiError) return path.startsWith('/internal/') ? json({ error: error.message, details: error.details }, error.status) : withCors(json({ error: error.message, details: error.details }, error.status), request, env)
    if (error instanceof Error && 'status' in error && typeof error.status === 'number') {
      const res = json({ error: error.message }, error.status)
      return path.startsWith('/internal/') ? res : withCors(res, request, env)
    }
    console.error('Errore API:', error instanceof Error ? error.message : 'errore sconosciuto')
    const res = json({ error: 'Errore del server. Riprova tra poco.' }, 500)
    return path.startsWith('/internal/') ? res : withCors(res, request, env)
  }
}

export default { fetch: handle }
export { allowedPushEndpoint, validateMonitor, validateSubscription }
