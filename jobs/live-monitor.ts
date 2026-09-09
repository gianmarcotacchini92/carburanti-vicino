import { confirmLiveAnomalies } from '../shared/mimit-live.ts'
import { priceFingerprint } from '../shared/push-message.ts'
import type { LiveStationDetail, Monitor, StationsResponse } from '../shared/types.ts'

export async function unseenLiveAnomalies(
  result: StationsResponse,
  monitor: Monitor,
  seen: ReadonlySet<string>,
  loadDetail: (id: number) => Promise<LiveStationDetail>,
) {
  const fetchedAt = Date.parse(result.updatedAt ?? '')
  const age = Date.now() - fetchedAt
  if (result.dataSource !== 'live' || !Number.isFinite(fetchedAt) || age < -5_000 || age > 120_000) {
    throw new Error('La fonte non ha restituito una ricerca corrente entro due minuti.')
  }
  if (!result.stations.some((station) => station.isAnomaly && !seen.has(priceFingerprint(station, monitor)))) return []
  return (await confirmLiveAnomalies(result, monitor, loadDetail))
    .filter((station) => !seen.has(priceFingerprint(station, monitor)))
}
