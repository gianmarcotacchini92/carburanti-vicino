import assert from 'node:assert/strict'
import { test } from 'node:test'
import { annotateAnomalies, distanceKm, italianTimestamp, median, normalizeFuel, stalePrice } from './domain.ts'
import type { StationResult } from '../shared/types.ts'

function station(id: number, price: number, extra: Partial<StationResult> = {}): StationResult {
  return {
    id, name: 'Stazione di test', brand: 'Test', address: 'Indirizzo di test', town: 'Roma',
    province: 'RM', lat: 41.9, lon: 12.5, price, self: true, unit: 'L',
    reportedAt: new Date().toISOString(), isStale: false, distanceKm: 1,
    isAnomaly: false, discountPercent: 0, peerMedian: null, ...extra,
  }
}

test('mediana e distanza geografica', () => {
  assert.equal(median([]), null)
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 2, 3]), 2.5)
  assert.equal(distanceKm(41.9, 12.5, 41.9, 12.5), 0)
  assert.ok(Math.abs(distanceKm(41.9, 12.5, 45.46, 9.19) - 477) < 5)
})

test('segnala almeno 25% sotto la mediana di cinque ALTRI impianti', () => {
  const stations = [station(1, 1.5), ...[2, 3, 4, 5, 6].map((id) => station(id, 2))]
  const result = annotateAnomalies(stations)
  assert.equal(result[0]!.isAnomaly, true)
  assert.equal(result[0]!.peerMedian, 2)
  assert.equal(result[0]!.discountPercent, 25)
  assert.equal(result[1]!.isAnomaly, false)
  assert.equal(annotateAnomalies(stations.slice(0, 5))[0]!.isAnomaly, false)
})

test('esclude dati vecchi, stesso impianto e diversa modalita', () => {
  const peers = [2, 3, 4, 5].map((id) => station(id, 2))
  assert.equal(annotateAnomalies([station(1, 0.5), ...peers, station(6, 2, { isStale: true })])[0]!.isAnomaly, false)
  assert.equal(annotateAnomalies([station(1, 0.5), ...peers, station(6, 2, { self: false })])[0]!.isAnomaly, false)
  assert.equal(annotateAnomalies([station(1, 0.5), ...peers, station(1, 2)])[0]!.isAnomaly, false)
  assert.equal(annotateAnomalies([station(1, 0.5, { isStale: true }), ...peers, station(6, 2)])[0]!.isAnomaly, false)
})

test('mediane per gruppi numerosi corrispondono al confronto diretto senza mescolare servizi', () => {
  const stations = Array.from({ length: 250 }, (_, index) =>
    station(Math.floor(index / 2), 0.5 + (index % 31) / 10, { self: index % 3 !== 0, isStale: index % 17 === 0 }))
  for (const result of annotateAnomalies(stations)) {
    const peers = stations.filter((other) => other.id !== result.id && other.self === result.self && !other.isStale)
    assert.equal(result.peerMedian, peers.length >= 5 ? median(peers.map((other) => other.price)) : null)
  }
})

test('freschezza entro sette giorni e carburanti standard senza premium', () => {
  const now = Date.parse('2026-09-07T12:00:00Z')
  assert.equal(stalePrice('2026-09-01T12:00:00Z', now), false)
  assert.equal(stalePrice('2026-08-30T12:00:00Z', now), true)
  assert.equal(stalePrice('invalid', now), true)
  assert.equal(stalePrice('2026-09-10T12:00:00Z', now), true)
  assert.equal(normalizeFuel(' GPL '), 'gpl')
  assert.equal(normalizeFuel('Gasolio Premium'), null)
})

test('timestamp MIMIT interpretati in Europe/Rome con ora legale e date non valide', () => {
  assert.equal(italianTimestamp('07/09/2026 08:00:00'), '2026-09-07T06:00:00.000Z')
  assert.equal(italianTimestamp('2026-09-07 08:00:00'), '2026-09-07T06:00:00.000Z')
  assert.equal(italianTimestamp('07/01/2026 08:00:00'), '2026-01-07T07:00:00.000Z')
  assert.equal(italianTimestamp('31/02/2026 08:00:00'), null)
  assert.equal(italianTimestamp('29/03/2026 02:30:00'), null)
  assert.equal(italianTimestamp('non valido'), null)
})
