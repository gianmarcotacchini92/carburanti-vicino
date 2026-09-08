import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'
import { createApp } from './app.ts'
import { createDataService } from './data.ts'
import { createPushService } from './push.ts'
import { openDatabase, setMetadata } from './storage.ts'

test('API: loading, parametri, prezzi, origine e ciclo monitoraggio autenticato', async () => {
  const db = openDatabase(':memory:')
  const push = createPushService(db, async () => ({ statusCode: 201, body: '', headers: {} }))
  const data = createDataService(db)
  const app = createApp(db, push, data.status)
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const headers = { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' }
  try {
    assert.equal((await fetch(`${url}/api/status`).then((r) => r.json()) as { ready: boolean }).ready, false)
    assert.equal((await fetch(`${url}/api/stations?lat=41.9&lon=12.5&radius=5&fuel=benzina&service=self`)).status, 503)
    assert.equal((await fetch(`${url}/api/stations?lat=999&lon=12.5&radius=5&fuel=benzina&service=self`)).status, 400)
    assert.equal((await fetch(`${url}/api/missing`)).status, 404)
    db.prepare('INSERT INTO stations VALUES(?,?,?,?,?,?,?,?)').run(1, 'Test', 'Test', 'Via test', 'Roma', 'RM', 41.9, 12.5)
    db.prepare('INSERT INTO prices VALUES(?,?,?,?,?)').run(1, 'benzina', 1, 1.789, new Date().toISOString())
    setMetadata(db, 'lastRefreshAt', new Date().toISOString())
    const prices = await fetch(`${url}/api/stations?lat=41.9&lon=12.5&radius=5&fuel=benzina&service=self`)
    assert.equal(prices.status, 200)
    assert.equal(prices.headers.get('cache-control'), 'no-store')
    const result = await prices.json() as { total: number; stations: { price: number }[] }
    assert.equal(result.total, 1)
    assert.equal(result.stations[0]!.price, 1.789)
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
