import { analysis, annotateAnomalies, distanceKm, median, stalePrice } from './domain.ts'
import type { Fuel, LiveStationDetail, SearchArea, ServiceMode, StationResult, StationsResponse } from './types.ts'

export const MIMIT_LIVE_CACHE_SECONDS = 120
const DEFAULT_BASE_URL = 'https://carburanti.mise.gov.it/ospzApi/'
const MAX_BODY_BYTES = 2 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 12_000
const DETAIL_DELAY_MS = 200

const fuelIds: Record<Fuel, number> = { benzina: 1, gasolio: 2, metano: 3, gpl: 4 }
const fuelsById = new Map<number, Fuel>(Object.entries(fuelIds).map(([fuel, id]) => [id, fuel as Fuel]))

type Json = Record<string, unknown>
type FetchLike = typeof fetch

export interface MimitLiveCache {
  get(key: string, maxAgeSeconds: number): Promise<string | null>
  set(key: string, payload: string): Promise<void>
}

export interface MimitLiveClientOptions {
  fetch?: FetchLike
  cache?: MimitLiveCache
  baseUrl?: string
  now?: () => number
  timeoutMs?: number
  maxBytes?: number
  beforeUncachedRequest?: (key: string, kind: 'area' | 'detail') => Promise<void> | void
}

export interface MimitLiveRequestOptions {
  refresh?: boolean
}

export class LiveMimitError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'LiveMimitError'
    this.status = status
  }
}

class MemoryCache implements MimitLiveCache {
  private entries = new Map<string, { payload: string; createdAt: number }>()
  private now: () => number
  constructor(now: () => number) { this.now = now }
  async get(key: string, maxAgeSeconds: number) {
    const entry = this.entries.get(key)
    if (!entry || this.now() - entry.createdAt > maxAgeSeconds * 1000) return null
    return entry.payload
  }
  async set(key: string, payload: string) {
    this.entries.set(key, { payload, createdAt: this.now() })
    if (this.entries.size > 1000) {
      const stale = [...this.entries.entries()].sort((a, b) => b[1].createdAt - a[1].createdAt).slice(1000)
      for (const [oldKey] of stale) this.entries.delete(oldKey)
    }
  }
}

function fail(status: number, message: string): never {
  throw new LiveMimitError(status, message)
}

function asObj(value: unknown, message = 'La fonte live MIMIT ha restituito dati non validi.'): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(502, message)
  return value as Json
}

function asArray(value: unknown, message = 'La fonte live MIMIT ha restituito dati non validi.'): unknown[] {
  if (!Array.isArray(value)) fail(502, message)
  return value
}

function finiteNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN
  return Number.isFinite(n) ? n : null
}

function safeInteger(value: unknown): number | null {
  const n = finiteNumber(value)
  return n !== null && Number.isSafeInteger(n) && n > 0 ? n : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function canonicalNumber(value: number) {
  if (!Number.isFinite(value)) fail(400, 'Parametri non validi.')
  return String(Number(value))
}

export function liveAreaCacheKey(area: SearchArea) {
  return [
    'mimit-live:v1:area',
    `lat=${canonicalNumber(area.lat)}`,
    `lon=${canonicalNumber(area.lon)}`,
    `radius=${canonicalNumber(area.radius)}`,
    `fuel=${area.fuel}`,
    `service=${area.service}`,
  ].join(':')
}

export function liveDetailCacheKey(id: number) {
  if (!Number.isSafeInteger(id) || id <= 0) fail(400, 'Parametri non validi.')
  return `mimit-live:v1:detail:${id}`
}

function parseDate(value: unknown, now: number): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || parsed > now + 86_400_000) return null
  return new Date(parsed).toISOString()
}

function warning(stats: { invalidStations: number; invalidPrices: number; invalidDates: number; duplicates: number }) {
  const parts: string[] = []
  if (stats.invalidStations) parts.push(`${stats.invalidStations} impianti non validi`)
  if (stats.invalidPrices) parts.push(`${stats.invalidPrices} prezzi non validi`)
  if (stats.invalidDates) parts.push(`${stats.invalidDates} date non valide`)
  if (stats.duplicates) parts.push(`${stats.duplicates} duplicati obsoleti`)
  return parts.length ? `Fonte live MIMIT: esclusi ${parts.join(', ')}.` : null
}

function serviceMatches(service: ServiceMode, self: boolean) {
  return service === 'all' || self === (service === 'self')
}

function sortStations(stations: StationResult[]) {
  return stations.sort((a, b) => a.price - b.price || a.distanceKm - b.distanceKm || a.id - b.id)
}

export function parseLiveArea(input: unknown, area: SearchArea, fetchedAt = new Date().toISOString()): StationsResponse {
  const now = Date.parse(fetchedAt)
  if (!Number.isFinite(now)) fail(502, 'La fonte live MIMIT ha restituito una data di aggiornamento non valida.')
  const obj = asObj(input)
  if (obj.success !== true) fail(502, 'La fonte live MIMIT non ha completato la ricerca.')
  const results = asArray(obj.results)
  const fuelId = fuelIds[area.fuel]
  const stats = { invalidStations: 0, invalidPrices: 0, invalidDates: 0, duplicates: 0 }
  const rows = new Map<string, StationResult>()

  for (const rawStation of results) {
    if (!rawStation || typeof rawStation !== 'object' || Array.isArray(rawStation)) { stats.invalidStations++; continue }
    const station = rawStation as Json
    const id = safeInteger(station.id)
    const location = station.location && typeof station.location === 'object' && !Array.isArray(station.location) ? station.location as Json : null
    const lat = finiteNumber(location?.lat)
    const lon = finiteNumber(location?.lng)
    const reportedAt = parseDate(station.insertDate, now)
    const fuels = Array.isArray(station.fuels) ? station.fuels : null
    if (!id || lat === null || lon === null || lat < 35 || lat > 48 || lon < 6 || lon > 19 || !fuels) {
      stats.invalidStations++
      continue
    }
    if (!reportedAt) { stats.invalidDates++; continue }
    const computedDistance = distanceKm(area.lat, area.lon, lat, lon)
    if (computedDistance > area.radius) continue
    for (const rawFuel of fuels) {
      if (!rawFuel || typeof rawFuel !== 'object' || Array.isArray(rawFuel)) { stats.invalidPrices++; continue }
      const priceRow = rawFuel as Json
      if (finiteNumber(priceRow.fuelId) !== fuelId) continue
      const price = finiteNumber(priceRow.price)
      if (typeof priceRow.isSelf !== 'boolean' || price === null || price <= 0 || price > 100) {
        stats.invalidPrices++
        continue
      }
      if (!serviceMatches(area.service, priceRow.isSelf)) continue
      const key = `${id}:${priceRow.isSelf ? 1 : 0}`
      const current: StationResult = {
        id, name: text(station.name) || `Impianto ${id}`, brand: text(station.brand) || 'Pompa indipendente',
        address: text(station.address), town: '', province: '', lat, lon, distanceKm: computedDistance,
        price, self: priceRow.isSelf, unit: area.fuel === 'metano' ? 'kg' : 'L',
        reportedAt, reportedAtScope: 'station', isStale: stalePrice(reportedAt, now),
        isAnomaly: false, discountPercent: 0, peerMedian: null,
      }
      const previous = rows.get(key)
      if (previous) {
        if (previous.reportedAt === current.reportedAt && Math.abs(previous.price - current.price) > 0.000_001) {
          fail(502, 'La fonte live MIMIT ha restituito prezzi duplicati incoerenti.')
        }
        if (previous.reportedAt >= current.reportedAt) { stats.duplicates++; continue }
        stats.duplicates++
      }
      rows.set(key, current)
    }
  }

  const stations = sortStations(annotateAnomalies([...rows.values()]))
  const fresh = stations.filter((station) => !station.isStale).map((station) => station.price)
  return {
    stations, total: stations.length, medianPrice: median(fresh),
    cheapestPrice: fresh.length ? Math.min(...fresh) : null,
    updatedAt: fetchedAt, sourceDate: null, warning: warning(stats),
    dataSource: 'live', cacheMaxAgeSeconds: MIMIT_LIVE_CACHE_SECONDS, analysis,
  }
}

export function parseLiveDetail(input: unknown, requestedId?: number, fetchedAt = new Date().toISOString()): LiveStationDetail {
  const now = Date.parse(fetchedAt)
  if (!Number.isFinite(now)) fail(502, 'La fonte live MIMIT ha restituito una data di aggiornamento non valida.')
  const obj = asObj(input)
  const id = safeInteger(obj.id)
  if (!id || (requestedId !== undefined && id !== requestedId)) fail(502, 'La fonte live MIMIT ha restituito un dettaglio non valido.')
  const fuels = asArray(obj.fuels)
  const prices = new Map<string, LiveStationDetail['prices'][number]>()
  for (const rawFuel of fuels) {
    if (!rawFuel || typeof rawFuel !== 'object' || Array.isArray(rawFuel)) fail(502, 'La scheda live MIMIT contiene un prezzo non valido.')
    const row = rawFuel as Json
    const fuel = fuelsById.get(finiteNumber(row.fuelId) ?? -1)
    if (!fuel) continue
    const price = finiteNumber(row.price)
    const reportedAt = parseDate(row.insertDate, now)
    if (typeof row.isSelf !== 'boolean' || price === null || price <= 0 || price > 100 || !reportedAt) {
      fail(502, 'La scheda live MIMIT contiene un prezzo o una data non validi.')
    }
    const key = `${fuel}:${row.isSelf ? 1 : 0}`
    const current = { fuel, self: row.isSelf, price, reportedAt }
    const previous = prices.get(key)
    if (previous) {
      if (previous.reportedAt === current.reportedAt && Math.abs(previous.price - current.price) > 0.000_001) {
        fail(502, 'La fonte live MIMIT ha restituito prezzi duplicati incoerenti.')
      }
      if (previous.reportedAt >= current.reportedAt) continue
    }
    prices.set(key, current)
  }
  return {
    id,
    name: text(obj.name) || text(obj.nomeImpianto) || `Impianto ${id}`,
    address: text(obj.address),
    brand: text(obj.brand) || 'Pompa indipendente',
    updatedAt: fetchedAt,
    prices: [...prices.values()].sort((a, b) => a.fuel.localeCompare(b.fuel) || Number(b.self) - Number(a.self)),
  }
}

async function readBoundedText(response: Response, maxBytes: number) {
  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel()
    fail(502, 'La risposta live MIMIT supera il limite consentito.')
  }
  if (!response.body) fail(502, 'La fonte live MIMIT ha restituito una risposta vuota.')
  const reader = response.body.getReader()
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
        fail(502, 'La risposta live MIMIT supera il limite consentito.')
      }
      chunks.push(decoder.decode(value, { stream: true }))
    }
    chunks.push(decoder.decode())
    return chunks.join('')
  } finally { reader.releaseLock() }
}

function endpoint(baseUrl: string, path: string) {
  return new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
}

async function fetchJson(fetchImpl: FetchLike, url: URL, init: RequestInit, timeoutMs: number, maxBytes: number) {
  let response: Response
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch {
    fail(502, 'La fonte live MIMIT non risponde.')
  }
  if (!response.ok) {
    await response.body?.cancel()
    fail(502, 'La fonte live MIMIT non risponde.')
  }
  const body = await readBoundedText(response, maxBytes)
  if (!body.trim()) fail(502, 'La fonte live MIMIT ha restituito una risposta vuota.')
  try { return JSON.parse(body) as unknown } catch { fail(502, 'La fonte live MIMIT ha restituito JSON non valido.') }
}

async function cached<T>(
  cache: MimitLiveCache | undefined,
  key: string,
  refresh: boolean | undefined,
  load: () => Promise<T>,
) {
  if (!refresh && cache) {
    const payload = await cache.get(key, MIMIT_LIVE_CACHE_SECONDS)
    if (payload) {
      try { return JSON.parse(payload) as T } catch { console.warn('Cache MIMIT danneggiata: nuova consultazione obbligatoria.') }
    }
  }
  const value = await load()
  if (cache) await cache.set(key, JSON.stringify(value))
  return value
}

export function createMimitLiveClient(options: MimitLiveClientOptions = {}) {
  const now = options.now ?? (() => Date.now())
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  const cache = options.cache ?? new MemoryCache(now)
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? MAX_BODY_BYTES

  async function fetchStations(area: SearchArea, requestOptions: MimitLiveRequestOptions = {}) {
    const key = liveAreaCacheKey(area)
    return await cached(cache, key, requestOptions.refresh, async () => {
      await options.beforeUncachedRequest?.(key, 'area')
      const fuelId = fuelIds[area.fuel]
      const data = await fetchJson(fetchImpl, endpoint(baseUrl, 'search/zone'), {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'Pieno/1.0 (fuel-price-map)' },
        body: JSON.stringify({ points: [{ lat: area.lat, lng: area.lon }], radius: area.radius, fuelType: `${fuelId}-x`, priceOrder: 'asc' }),
      }, timeoutMs, maxBytes)
      return parseLiveArea(data, area, new Date(now()).toISOString())
    })
  }

  async function fetchStation(id: number, requestOptions: MimitLiveRequestOptions = {}) {
    const key = liveDetailCacheKey(id)
    return await cached(cache, key, requestOptions.refresh, async () => {
      await options.beforeUncachedRequest?.(key, 'detail')
      const data = await fetchJson(fetchImpl, endpoint(baseUrl, `registry/servicearea/${id}`), {
        headers: { Accept: 'application/json', 'User-Agent': 'Pieno/1.0 (fuel-price-map)' },
      }, timeoutMs, maxBytes)
      return parseLiveDetail(data, id, new Date(now()).toISOString())
    })
  }

  return { fetchStations, fetchStation }
}

const defaultClient = createMimitLiveClient()

export function fetchLiveStations(area: SearchArea, options?: MimitLiveRequestOptions): Promise<StationsResponse> {
  return defaultClient.fetchStations(area, options)
}

export function fetchLiveStation(id: number, options?: MimitLiveRequestOptions): Promise<LiveStationDetail> {
  return defaultClient.fetchStation(id, options)
}

function stationKey(station: Pick<StationResult, 'id' | 'self'>) {
  return `${station.id}:${station.self ? 1 : 0}`
}

function detailPrice(detail: LiveStationDetail, fuel: Fuel, self: boolean) {
  return detail.prices.find((price) => price.fuel === fuel && price.self === self) ?? null
}

function applyDetailPrice(station: StationResult, detail: LiveStationDetail, fuel: Fuel): StationResult | null {
  const price = detailPrice(detail, fuel, station.self)
  if (!price) return null
  return {
    ...station,
    name: detail.name,
    brand: detail.brand,
    address: detail.address,
    town: '',
    province: '',
    price: price.price,
    reportedAt: price.reportedAt,
    reportedAtScope: 'price',
    isStale: stalePrice(price.reportedAt),
    isAnomaly: false,
    discountPercent: 0,
    peerMedian: null,
  }
}

async function loadDetails(
  ids: number[],
  known: Map<number, LiveStationDetail>,
  loadDetail: (id: number) => Promise<LiveStationDetail>,
) {
  for (const id of ids) {
    if (known.has(id)) continue
    if (known.size) await new Promise((resolve) => setTimeout(resolve, DETAIL_DELAY_MS))
    const detail = await loadDetail(id)
    if (detail.id !== id) fail(502, 'La fonte live MIMIT ha restituito il dettaglio di un altro impianto.')
    known.set(id, detail)
  }
}

export async function confirmLiveAnomalies(
  result: StationsResponse,
  area: SearchArea,
  loadDetail: (id: number) => Promise<LiveStationDetail>,
): Promise<StationResult[]> {
  const preliminary = result.stations.filter((station) => station.isAnomaly)
  if (!preliminary.length) return []

  const details = new Map<number, LiveStationDetail>()
  await loadDetails([...new Set(preliminary.map((station) => station.id))], details, loadDetail)

  const unchanged = new Set<string>()
  const modes = new Set<boolean>()
  const preliminaryByKey = new Map(preliminary.map((station) => [stationKey(station), station]))
  for (const station of preliminary) {
    const current = applyDetailPrice(station, details.get(station.id)!, area.fuel)
    if (current && !current.isStale && Math.abs(current.price - station.price) <= 0.000_001) {
      unchanged.add(stationKey(station))
      modes.add(station.self)
    }
  }
  if (!unchanged.size) return []

  const peers = result.stations.filter((station) => modes.has(station.self))
  const remainingIds = [...new Set(peers.map((station) => station.id).filter((id) => !details.has(id)))]
  await loadDetails(remainingIds, details, loadDetail)

  // Peer verification can take minutes in dense areas: confirm candidate prices again before sending.
  const candidateIds = [...new Set(preliminary.filter((station) => unchanged.has(stationKey(station))).map((station) => station.id))]
  for (const id of candidateIds) details.delete(id)
  await loadDetails(candidateIds, details, loadDetail)

  const currentStations = peers.flatMap((station) => {
    const detail = details.get(station.id)
    const current = detail ? applyDetailPrice(station, detail, area.fuel) : null
    return current ? [current] : []
  })
  const annotated = sortStations(annotateAnomalies(currentStations))
  return annotated.filter((station) => {
    const key = stationKey(station)
    const original = preliminaryByKey.get(key)
    return !!original && unchanged.has(key) && station.isAnomaly && Math.abs(station.price - original.price) <= 0.000_001
  })
}
