import { annotateAnomalies, median, stalePrice } from './domain.ts'
import type { Fuel, LiveStationDetail, StationsResponse } from './types.ts'

export function applyLiveDetail(result: StationsResponse, detail: LiveStationDetail, fuel: Fuel): StationsResponse {
  const stations = result.stations.flatMap((station) => {
    if (station.id !== detail.id) return [station]
    const price = detail.prices.find((entry) => entry.fuel === fuel && entry.self === station.self)
    if (!price) return []
    return [{
      ...station, name: detail.name, brand: detail.brand, address: detail.address, town: '', province: '',
      price: price.price, reportedAt: price.reportedAt, reportedAtScope: 'price' as const,
      isStale: stalePrice(price.reportedAt),
    }]
  })
  const fresh = stations.filter((station) => !station.isStale).map((station) => station.price)
  return {
    ...result, stations: annotateAnomalies(stations), total: stations.length,
    cheapestPrice: fresh.length ? Math.min(...fresh) : null, medianPrice: median(fresh),
  }
}
