import type { Fuel, SearchArea, StationResult } from './types.ts'

export const analysis = { minimumPeers: 5, thresholdPercent: 25, freshnessDays: 7 }
const DAY = 86_400_000
const italianDateFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
})

export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180
  const a = Math.sin((lat2 - lat1) * rad / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lon2 - lon1) * rad / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)))
}

export function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

export function normalizeFuel(value: string): Fuel | null {
  const fuels: Record<string, Fuel> = { benzina: 'benzina', gasolio: 'gasolio', gpl: 'gpl', metano: 'metano' }
  return fuels[value.trim().toLowerCase()] ?? null
}

export function stalePrice(reportedAt: string, now = Date.now()): boolean {
  const age = now - Date.parse(reportedAt)
  return !Number.isFinite(age) || age > analysis.freshnessDays * DAY || age < -DAY
}

export function annotateAnomalies(stations: StationResult[]): StationResult[] {
  const groups = new Map<boolean, { prices: number[]; positions: Map<number, number[]> }>()
  for (const self of [false, true]) {
    const fresh = stations.filter((station) => station.self === self && !station.isStale).sort((a, b) => a.price - b.price)
    const positions = new Map<number, number[]>()
    fresh.forEach((station, index) => {
      const indices = positions.get(station.id) ?? []
      indices.push(index)
      positions.set(station.id, indices)
    })
    groups.set(self, { prices: fresh.map((station) => station.price), positions })
  }
  return stations.map((station) => {
    const group = groups.get(station.self)!
    const excluded = group.positions.get(station.id) ?? []
    const peerCount = group.prices.length - excluded.length
    // Read ranks from the sorted group without sorting a new peer array per station.
    const priceAt = (rank: number) => {
      let index = rank
      for (const position of excluded) {
        if (position <= index) index++
        else break
      }
      return group.prices[index]!
    }
    const middle = Math.floor(peerCount / 2)
    const peerMedian = peerCount < analysis.minimumPeers ? null
      : peerCount % 2 ? priceAt(middle) : (priceAt(middle - 1) + priceAt(middle)) / 2
    const discountPercent = peerMedian ? (1 - station.price / peerMedian) * 100 : 0
    return {
      ...station,
      peerMedian,
      discountPercent,
      isAnomaly: !station.isStale && peerMedian !== null &&
        station.price <= peerMedian * (1 - analysis.thresholdPercent / 100),
    }
  })
}

export function areaBounds(area: SearchArea) {
  const latitudeDelta = area.radius / 110.5
  const longitudeDelta = area.radius / (110.5 * Math.cos(area.lat * Math.PI / 180))
  return {
    south: area.lat - latitudeDelta, north: area.lat + latitudeDelta,
    west: area.lon - longitudeDelta, east: area.lon + longitudeDelta,
  }
}

// The source supplies no offset; interpret its civil timestamps as Europe/Rome.
export function italianTimestamp(input: string): string | null {
  const european = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(input.trim())
  const iso = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(input.trim())
  if (!european && !iso) return null
  const fields = european ? european.slice(1) : [iso![3]!, iso![2]!, iso![1]!, ...iso!.slice(4)]
  const [day, month, year, hour, minute, second] = fields.map(Number)
  const wall = Date.UTC(year!, month! - 1, day!, hour!, minute!, second!)
  if (!Number.isFinite(wall)) return null
  let instant = wall
  for (let i = 0; i < 2; i++) {
    const parts = Object.fromEntries(italianDateFormatter.formatToParts(instant).map((part) => [part.type, part.value]))
    const formatted = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!)
    instant = wall - (formatted - instant)
  }
  const result = new Date(instant)
  const parts = Object.fromEntries(italianDateFormatter.formatToParts(result).map((part) => [part.type, part.value]))
  if (+parts.day! !== day || +parts.month! !== month || +parts.year! !== year ||
    +parts.hour! !== hour || +parts.minute! !== minute || +parts.second! !== second) return null
  return result.toISOString()
}
