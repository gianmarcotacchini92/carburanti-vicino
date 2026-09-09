import assert from 'node:assert/strict'
import test from 'node:test'
import { unseenLiveAnomalies } from './live-monitor.ts'
import type { Monitor, StationsResponse } from '../shared/types.ts'

const area: Monitor = { lat: 41.9, lon: 12.4, radius: 5, fuel: 'benzina', service: 'self', label: 'Roma' }
const result = (): StationsResponse => ({
  stations: [], total: 0, medianPrice: null, cheapestPrice: null,
  sourceDate: null, updatedAt: new Date().toISOString(), warning: null, dataSource: 'live',
  analysis: { minimumPeers: 5, thresholdPercent: 25, freshnessDays: 7 },
})
const unexpectedDetail = async () => { throw new Error('Non deve consultare schede in questo caso') }

test('notification monitoring rejects daily data, invalid timestamps, expired and future results', async () => {
  for (const override of [
    { dataSource: 'daily' as const },
    { updatedAt: null },
    { updatedAt: 'invalid' },
    { updatedAt: new Date(Date.now() - 121_000).toISOString() },
    { updatedAt: new Date(Date.now() + 60_000).toISOString() },
  ]) {
    await assert.rejects(unseenLiveAnomalies({ ...result(), ...override }, area, new Set(), unexpectedDetail), /ricerca corrente/)
  }
})

test('a current area without preliminary anomalies does not query unnecessary details', async () => {
  assert.deepEqual(await unseenLiveAnomalies(result(), area, new Set(), unexpectedDetail), [])
})
