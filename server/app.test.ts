import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'
import { createApp } from './app.ts'
import { createPushService } from './push.ts'
import { openDatabase } from './storage.ts'
import type { LiveStationDetail, StatusResponse, StationsResponse } from '../shared/types.ts'

test('API: loading, parametri, prezzi, origine e ciclo monitoraggio autenticato', async () => {
  const db = openDatabase(':memory:')
  const updatedAt = new Date().toISOString()
  const liveResult: StationsResponse = {
    stations: [{
      id: 1, name: 'Test', brand: 'Test', address: 'Via test', town: '', province: '',
      lat: 41.9, lon: 12.5, distanceKm: 0, price: 1.789, self: true, unit: 'L',
      reportedAt: updatedAt, reportedAtScope: 'station', isStale: false, isAnomaly: false,
      discountPercent: 0, peerMedian: null,
    }],
    total: 1, medianPrice: 1.789, cheapestPrice: 1.789, updatedAt, sourceDate: null,
    warning: null, dataSource: 'live', cacheMaxAgeSeconds: 120,
    analysis: { minimumPeers: 5, thresholdPercent: 25, freshnessDays: 7 },
  }
  const detail: LiveStationDetail = {
    id: 1, name: 'Test', brand: 'Test', address: 'Via test', updatedAt,
    prices: [{ fuel: 'benzina', self: true, price: 1.789, reportedAt: updatedAt }],
  }
  const liveClient = { fetchStations: async () => liveResult, fetchStation: async () => detail }
  const push = createPushService(db, async () => ({ statusCode: 201, body: '', headers: {} }), liveClient)
  const status = (): StatusResponse => ({
    ready: true, refreshing: false, lastRefreshAt: null, sourceDate: null,
    stationCount: 0, priceCount: 0, warning: null, dataSource: 'live',
  })
  const app = createApp(db, push, status, liveClient)
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const headers = { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' }
  try {
    const statusBody = await fetch(`${url}/api/status`).then((r) => r.json()) as { ready: boolean; dataSource: string; sourceDate: string | null }
    assert.equal(statusBody.ready, true)
    assert.equal(statusBody.dataSource, 'live')
    assert.equal(statusBody.sourceDate, null)
    assert.equal((await fetch(`${url}/api/stations?lat=999&lon=12.5&radius=5&fuel=benzina&service=self`)).status, 400)
    assert.equal((await fetch(`${url}/api/missing`)).status, 404)
    db.prepare('INSERT INTO stations VALUES(?,?,?,?,?,?,?,?)').run(1, 'Old CSV', 'Old', 'Via old', 'Roma', 'RM', 41.9, 12.5)
    db.prepare('INSERT INTO prices VALUES(?,?,?,?,?)').run(1, 'benzina', 1, 9.999, '2026-01-01T00:00:00.000Z')
    const prices = await fetch(`${url}/api/stations?lat=41.9&lon=12.5&radius=5&fuel=benzina&service=self`)
    assert.equal(prices.status, 200)
    assert.equal(prices.headers.get('cache-control'), 'no-store')
    const result = await prices.json() as { total: number; dataSource: string; sourceDate: string | null; stations: { price: number }[] }
    assert.equal(result.total, 1)
    assert.equal(result.dataSource, 'live')
    assert.equal(result.sourceDate, null)
    assert.equal(result.stations[0]!.price, 1.789)
    const detailResult = await fetch(`${url}/api/stations/1`)
    assert.equal(detailResult.status, 200)
    assert.equal((await detailResult.json() as LiveStationDetail).prices[0]!.reportedAt, updatedAt)
    const body = {
      subscription: {
        endpoint: 'https://fcm.googleapis.com/fcm/send/api-test',
        keys: { p256dh: push.publicKey, auth: randomBytes(16).toString('base64url') },
      },
      monitor: { lat: 41.9, lon: 12.5, radius: 5, fuel: 'benzina', service: 'self', label: 'Test' },
    }
    assert.equal((await fetch(`${url}/api/push/subscriptions`, {
      method: 'POST', headers: { ...headers, Origin: 'https://untrusted.example' }, body: JSON.stringify(body),
    })).status, 403)
    const created = await fetch(`${url}/api/push/subscriptions`, { method: 'POST', headers, body: JSON.stringify(body) })
    assert.equal(created.status, 201)
    const credentials = await created.json() as { id: string; token: string }
    const monitorUrl = `${url}/api/push/subscriptions/${credentials.id}`
    assert.equal((await fetch(monitorUrl)).status, 401)
    const authorized = { ...headers, Authorization: `Bearer ${credentials.token}` }
    assert.equal((await fetch(monitorUrl, { headers: authorized })).status, 200)
    assert.equal((await fetch(monitorUrl, {
      method: 'PUT', headers: authorized, body: JSON.stringify({ monitor: { ...body.monitor, radius: 10 } }),
    })).status, 200)
    assert.equal((await fetch(monitorUrl, { method: 'DELETE', headers: authorized })).status, 204)
    assert.equal((await fetch(monitorUrl, { headers: authorized })).status, 404)
  } finally {
    server.close()
    await once(server, 'close')
    db.close()
  }
})
