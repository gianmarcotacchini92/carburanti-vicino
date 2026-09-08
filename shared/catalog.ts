import { analysis, annotateAnomalies, areaBounds, distanceKm, median, stalePrice } from './domain.ts'
import type { CatalogStation, SearchArea, StationResult, StationsResponse, StatusResponse } from './types.ts'

export const cellFor = (lat: number, lon: number) => `${Math.floor(lat * 4)}_${Math.floor(lon * 4)}`

export function cellsFor(area: SearchArea): string[] {
  const bounds = areaBounds(area)
  const cells: string[] = []
  for (let y = Math.floor(bounds.south * 4); y <= Math.floor(bounds.north * 4); y++) {
    for (let x = Math.floor(bounds.west * 4); x <= Math.floor(bounds.east * 4); x++) cells.push(`${y}_${x}`)
  }
  return cells
}

export function searchCatalog(catalog: CatalogStation[], area: SearchArea, status: StatusResponse): StationsResponse {
  const stations: StationResult[] = []
  const now = Date.now()
  for (const station of catalog) {
    const distance = distanceKm(area.lat, area.lon, station.lat, station.lon)
    if (distance > area.radius) continue
    for (const price of station.prices) {
      if (price.fuel !== area.fuel || (area.service !== 'all' && price.self !== (area.service === 'self'))) continue
      stations.push({
        id: station.id, name: station.name, brand: station.brand, address: station.address,
        town: station.town, province: station.province, lat: station.lat, lon: station.lon,
        price: price.price, self: price.self, reportedAt: price.reportedAt,
        unit: area.fuel === 'metano' ? 'kg' : 'L', distanceKm: distance,
        isStale: stalePrice(price.reportedAt, now), isAnomaly: false, discountPercent: 0, peerMedian: null,
      })
    }
  }
  const annotated = annotateAnomalies(stations).sort((a, b) => a.price - b.price || a.distanceKm - b.distanceKm)
  const fresh = annotated.filter((station) => !station.isStale).map((station) => station.price)
  return {
    stations: annotated, total: annotated.length, medianPrice: median(fresh),
    cheapestPrice: fresh.length ? Math.min(...fresh) : null, sourceDate: status.sourceDate,
    updatedAt: status.lastRefreshAt, warning: status.warning, analysis,
  }
}
