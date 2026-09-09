import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  confirmLiveAnomalies,
  createMimitLiveClient,
  LiveMimitError,
  parseLiveArea,
  parseLiveDetail,
} from '../shared/mimit-live.ts'
import type { SearchArea } from '../shared/types.ts'

const area: SearchArea = { lat: 41.9, lon: 12.5, radius: 5, fuel: 'benzina', service: 'self' }
const fetchedAt = '2026-09-09T10:00:00.000Z'

function station(id: number, price: number, insertDate = '2026-09-08T21:47:11+02:00') {
  return {
    id, name: `Station ${id}`, brand: 'Brand', address: null,
    location: { lat: 41.9, lng: 12.5 }, insertDate,
    fuels: [{ fuelId: 1, price, isSelf: true }, { fuelId: 20, price: 9.999, isSelf: true }],
  }
}

test('live area maps official shape, fuel ids, service modes, coordinates and aggregate date scope', () => {
  const result = parseLiveArea({
    success: true,
    results: [{
      id: 10, name: 'Metano test', brand: 'PompeBianche', location: { lat: 41.91, lng: 12.49 },
      insertDate: '2026-09-08T21:47:11+02:00',
      fuels: [
        { fuelId: 3, price: 1.12, isSelf: true },
        { fuelId: 3, price: 1.22, isSelf: false },
        { fuelId: 1, price: 1.7, isSelf: false },
      ],
    }],
  }, { ...area, fuel: 'metano', service: 'servito' }, fetchedAt)
  assert.equal(result.dataSource, 'live')
  assert.equal(result.sourceDate, null)
  assert.equal(result.updatedAt, fetchedAt)
  assert.equal(result.total, 1)
  assert.equal(result.stations[0]!.unit, 'kg')
  assert.equal(result.stations[0]!.self, false)
  assert.equal(result.stations[0]!.price, 1.22)
  assert.equal(result.stations[0]!.lon, 12.49)
  assert.equal(result.stations[0]!.reportedAt, '2026-09-08T19:47:11.000Z')
  assert.equal(result.stations[0]!.reportedAtScope, 'station')
})

test('live client caches for two minutes, refresh bypasses cache, and expired failures do not fall back', async () => {
  let now = Date.parse(fetchedAt)
  let calls = 0
  let fail = false
  const client = createMimitLiveClient({
    now: () => now,
    fetch: (async (_url, init) => {
      calls++
      const body = JSON.parse(String(init?.body))
      assert.equal(body.points[0].lng, area.lon)
      if (fail) return new Response('unavailable', { status: 503 })
      return new Response(JSON.stringify({ success: true, results: [station(1, 1.7)] }))
    }) as typeof fetch,
  })
  assert.equal((await client.fetchStations(area)).stations[0]!.price, 1.7)
  fail = true
  assert.equal((await client.fetchStations(area)).stations[0]!.price, 1.7)
  assert.equal(calls, 1)
  await assert.rejects(client.fetchStations(area, { refresh: true }), LiveMimitError)
  now += 121_000
  await assert.rejects(client.fetchStations(area), LiveMimitError)
  assert.equal(calls, 3)
})

test('live parser rejects unsuccessful or malformed source payloads', () => {
  assert.throws(() => parseLiveArea({ success: false, results: [] }, area, fetchedAt), LiveMimitError)
  assert.throws(() => parseLiveArea({ success: true, results: {} }, area, fetchedAt), LiveMimitError)
  assert.throws(() => parseLiveDetail({ id: 1, fuels: {} }, 1, fetchedAt), LiveMimitError)
})

test('detail uses exact per-price dates and rejects invalid prices without claiming removal', () => {
  const detail = parseLiveDetail({
    id: 50963, name: 'Area detail', brand: 'Brand', address: 'Via live',
    fuels: [
      { fuelId: 1, price: 2.119, isSelf: true, insertDate: '2026-09-09T06:10:42Z' },
    ],
  }, 50963, fetchedAt)
  assert.equal(detail.updatedAt, fetchedAt)
  assert.deepEqual(detail.prices, [{ fuel: 'benzina', self: true, price: 2.119, reportedAt: '2026-09-09T06:10:42.000Z' }])
  assert.throws(() => parseLiveDetail({
    id: 1, fuels: [{ fuelId: 1, price: 1.7, isSelf: true, insertDate: 'not-a-date' }],
  }, 1, fetchedAt), LiveMimitError)
})

test('live confirmation stops alert when candidate current price changed', async () => {
  const preliminary = parseLiveArea({
    success: true,
    results: [station(1, 0.5), station(2, 2), station(3, 2), station(4, 2), station(5, 2), station(6, 2)],
  }, area, fetchedAt)
  assert.equal(preliminary.stations.find((s) => s.id === 1)!.isAnomaly, true)
  const confirmed = await confirmLiveAnomalies(preliminary, area, async (id) => parseLiveDetail({
    id, name: `Station ${id}`, brand: 'Brand', address: '',
    fuels: [{ fuelId: 1, price: id === 1 ? 0.6 : 2, isSelf: true, insertDate: '2026-09-09T06:10:42Z' }],
  }, id, fetchedAt))
  assert.deepEqual(confirmed, [])
})

test('anomaly verification uses per-price freshness and rechecks candidate after peers', async () => {
  const now = new Date().toISOString()
  const preliminary = parseLiveArea({
    success: true,
    results: [station(1, 0.5, now), ...[2, 3, 4, 5, 6].map((id) => station(id, 2, now))],
  }, area, now)
  const load = (staleId?: number, changeOnRecheck = false) => {
    let candidateCalls = 0
    return async (id: number) => {
      if (id === 1) candidateCalls++
      return parseLiveDetail({
        id, fuels: [{
          fuelId: 1, price: id === 1 ? (changeOnRecheck && candidateCalls > 1 ? 1.9 : 0.5) : 2, isSelf: true,
          insertDate: id === staleId ? new Date(Date.now() - 8 * 86_400_000).toISOString() : now,
        }],
      }, id, now)
    }
  }
  assert.deepEqual((await confirmLiveAnomalies(preliminary, area, load())).map((item) => item.id), [1])
  assert.deepEqual(await confirmLiveAnomalies(preliminary, area, load(2)), [])
  assert.deepEqual(await confirmLiveAnomalies(preliminary, area, load(undefined, true)), [])
  await assert.rejects(confirmLiveAnomalies(preliminary, area, async () => { throw new Error('upstream failed') }), /upstream failed/)
})
