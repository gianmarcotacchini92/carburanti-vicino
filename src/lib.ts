import type { CatalogStation, Fuel, SearchArea, ServiceMode, StationResult, StationsResponse, StatusResponse } from '../shared/types'
import { cellsFor, searchCatalog } from '../shared/catalog'

export const appBase = import.meta.env.BASE_URL
const apiOrigin = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
export const cloudCatalog = import.meta.env.VITE_CATALOG_MODE === 'true'

export const FUELS: { value: Fuel; label: string }[] = [
  { value: 'benzina', label: 'Benzina' },
  { value: 'gasolio', label: 'Gasolio' },
  { value: 'gpl', label: 'GPL' },
  { value: 'metano', label: 'Metano' },
]
export const RADII = [1, 3, 5, 10, 20, 30]
export const DEFAULT_AREA: SearchArea = {
  lat: 41.9028, lon: 12.4964, radius: 5, fuel: 'benzina', service: 'self',
}
export const priceFormat = (price: number) =>
  price.toLocaleString('it-IT', { minimumFractionDigits: 3, maximumFractionDigits: 3 })
export const moneyFormat = (value: number) =>
  value.toLocaleString('it-IT', { style: 'currency', currency: 'EUR' })
export const distanceFormat = (km: number) =>
  km < 1 ? `${Math.round(km * 1000)} m` : `${km.toLocaleString('it-IT', { maximumFractionDigits: 1 })} km`
export const dateFormat = (value: string | null, time = false) => {
  if (!value) return 'non disponibile'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'non disponibile'
  return new Intl.DateTimeFormat('it-IT', {
    day: '2-digit', month: 'short', year: 'numeric', ...(time ? { hour: '2-digit', minute: '2-digit' } : {}),
    ...(/^\d{4}-\d{2}-\d{2}$/.test(value) ? { timeZone: 'UTC' } : {}),
  }).format(date)
}
export const snapshotLabel = (sourceDate: string | null) => {
  const date = dateFormat(sourceDate)
  return date === 'non disponibile' ? 'Data di riferimento non disponibile' : `Dati riferiti alle 08:00 del ${date}`
}
export const fuelLabel = (fuel: Fuel) => FUELS.find((item) => item.value === fuel)?.label ?? fuel
export const serviceLabel = (service: ServiceMode) =>
  ({ all: 'Self e servito', self: 'Self service', servito: 'Servito' })[service]
export const unitFor = (fuel: Fuel) => fuel === 'metano' ? 'kg' : 'L'
export const stationKey = (station: Pick<StationResult, 'id' | 'self'>) => `${station.id}-${station.self ? '1' : '0'}`
export const areaQuery = (area: SearchArea) => new URLSearchParams({
  lat: String(area.lat), lon: String(area.lon), radius: String(area.radius),
  fuel: area.fuel, service: area.service,
}).toString()

export function initialSearch() {
  const params = new URLSearchParams(window.location.search)
  const lat = Number(params.get('lat'))
  const lon = Number(params.get('lon'))
  const hasCoordinates = params.has('lat') && params.has('lon')
    && params.get('lat')?.trim() !== '' && params.get('lon')?.trim() !== ''
    && Number.isFinite(lat) && Number.isFinite(lon)
    && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
  const fuel = params.get('fuel') as Fuel
  const service = params.get('service') as ServiceMode
  const radius = Number(params.get('radius'))
  const stationId = params.has('station') && /^\d+$/.test(params.get('station') ?? '')
    ? Number(params.get('station')) : null
  const stationSelf = params.get('stationSelf')
  return {
    area: {
      ...DEFAULT_AREA,
      ...(hasCoordinates ? { lat, lon } : {}),
      ...(FUELS.some((item) => item.value === fuel) ? { fuel } : {}),
      ...(['self', 'servito', 'all'].includes(service) ? { service } : {}),
      ...(RADII.includes(radius) ? { radius } : {}),
    },
    label: hasCoordinates ? 'Zona dal link condiviso' : 'Roma · zona iniziale',
    stationId,
    stationKey: stationId !== null && (stationSelf === '0' || stationSelf === '1')
      ? `${stationId}-${stationSelf}` : null,
  }
}

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const controller = new AbortController()
  const cancel = () => controller.abort()
  options.signal?.addEventListener('abort', cancel, { once: true })
  if (options.signal?.aborted) controller.abort()
  const timeout = window.setTimeout(cancel, 25000)
  try {
    const response = await fetch(`${apiOrigin}${path}`, {
      ...options, signal: controller.signal,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    })
    if (!response.ok) {
      let detail = ''
      try {
        const body: unknown = await response.json()
        if (typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string') {
          detail = body.error
        }
      } catch { /* A proxy error may not contain JSON. */ }
      throw new ApiError(detail || `Il servizio non risponde correttamente (${response.status}).`, response.status)
    }
    if (response.status === 204) return undefined as T
    return await response.json() as T
  } catch (reason) {
    if (controller.signal.aborted && !options.signal?.aborted) {
      throw new Error('Il server impiega troppo tempo a rispondere. Riprova tra poco.')
    }
    if (reason instanceof TypeError) {
      throw new Error('Non è possibile contattare il server. Controlla la connessione e riprova.')
    }
    throw reason
  } finally {
    window.clearTimeout(timeout)
    options.signal?.removeEventListener('abort', cancel)
  }
}

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Si è verificato un errore. Riprova tra poco.'

export async function fetchStations(area: SearchArea, signal: AbortSignal): Promise<StationsResponse> {
  if (!cloudCatalog) return api<StationsResponse>(`/api/stations?${areaQuery(area)}`, { signal })
  const status = await api<StatusResponse>('/api/status', { signal })
  if (!status.ready || !status.catalogVersion) throw new Error('Il catalogo ufficiale non e ancora disponibile.')
  const tiles = await Promise.all(cellsFor(area).map((cell) =>
    api<CatalogStation[]>(`/api/catalog/${encodeURIComponent(status.catalogVersion!)}/${cell}`, { signal })))
  if (signal.aborted) throw new DOMException('Ricerca annullata', 'AbortError')
  return searchCatalog(tiles.flat(), area, status)
}
