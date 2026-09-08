import type { Monitor, StationResult } from './types.ts'

export const priceFingerprint = (station: StationResult, monitor: Monitor) =>
  `${station.id}:${monitor.fuel}:${station.self}:${station.price.toFixed(3)}`

export function pushMessage(id: string, monitor: Monitor, stations: StationResult[], appPath = '/') {
  const first = stations[0]
  if (!first) throw new Error('Impossibile creare una notifica senza prezzi anomali.')
  const query = new URLSearchParams({
    lat: String(monitor.lat), lon: String(monitor.lon), radius: String(monitor.radius),
    fuel: monitor.fuel, service: monitor.service, station: String(first.id),
    stationSelf: first.self ? '1' : '0',
  })
  const price = first.price.toLocaleString('it-IT', { minimumFractionDigits: 3, maximumFractionDigits: 3 })
  return {
    title: 'Pieno · possibile prezzo anomalo',
    body: `${first.brand || first.name}: ${price} EUR/${first.unit}, ${Math.round(first.discountPercent)}% sotto la mediana. ${stations.length > 1 ? `Altri ${stations.length - 1} prezzi anomali. ` : ''}Verifica alla pompa: potrebbe essere un errore.`,
    tag: `pieno-${id}`,
    url: `${appPath}?${query}`,
  }
}
