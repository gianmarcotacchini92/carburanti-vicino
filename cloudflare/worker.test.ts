import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import worker, { allowedPushEndpoint } from './worker.ts'
import type { Env } from './worker.ts'

class D1Stmt {
  private params: unknown[] = []
  constructor(private db: DatabaseSync, private sql: string) {}
  bind(...params: unknown[]) { this.params = params; return this }
  first<T = unknown>() { return Promise.resolve(this.db.prepare(this.sql).get(...this.params) as T | null) }
  all<T = unknown>() { return Promise.resolve({ results: this.db.prepare(this.sql).all(...this.params) as T[] }) }
  run() {
    const result = this.db.prepare(this.sql).run(...this.params) as { changes?: number }
    return Promise.resolve({ meta: { changes: result.changes ?? 0 } })
  }
}

class MockD1 {
  db = new DatabaseSync(':memory:')
  constructor() {
    this.db.exec(readFileSync(new URL('./migrations/0001_initial.sql', import.meta.url), 'utf8'))
  }
  prepare(sql: string) { return new D1Stmt(this.db, sql) }
  async batch<T>(statements: { run(): Promise<T> }[]) { return Promise.all(statements.map((s) => s.run())) }
  close() { this.db.close() }
}

function env() {
  const mock = new MockD1()
  return {
    mock,
    env: {
      DB: mock as unknown as D1Database,
      APP_ORIGIN: 'http://localhost:5173',
      APP_BASE_PATH: '/carburanti-vicino/',
      VAPID_PUBLIC_KEY: b64(65),
      JOB_TOKEN: 'job-secret',
      GEOCODER_URL: 'https://photon.test/api/',
    } satisfies Env,
  }
}

function b64(bytes: number) { return Buffer.alloc(bytes, 7).toString('base64url') }
function api(path: string, init?: RequestInit) { return new Request(`https://worker.test${path}`, init) }
function auth() { return { Authorization: 'Bearer job-secret' } }
async function fetchWorker(request: Request, e: Env) { return worker.fetch(request, e) }

const snapshot = {
  ready: true,
  refreshing: false,
  lastRefreshAt: new Date().toISOString(),
  sourceDate: new Date().toISOString().slice(0, 10),
  stationCount: 1,
  priceCount: 1,
  warning: null,
  catalogVersion: 'a'.repeat(32),
  cells: ['41_12', '42_12'],
}

test('CORS preflight and protected internal routes are separated', async () => {
  const { mock, env: e } = env()
  try {
    const preflight = await fetchWorker(api('/api/status', { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173' } }), e)
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:5173')
    assert.equal(preflight.headers.get('vary'), 'Origin')
    const denied = await fetchWorker(api('/api/push/subscriptions', { method: 'POST', headers: { Origin: 'https://evil.test' } }), e)
    assert.equal(denied.status, 403)
    const internal = await fetchWorker(api('/internal/snapshot', { headers: { Origin: 'http://localhost:5173' } }), e)
    assert.equal(internal.status, 401)
    assert.equal(internal.headers.get('access-control-allow-origin'), null)
  } finally { mock.close() }
})

test('catalog snapshot commit is atomic and serves raw immutable tiles', async () => {
  const { mock, env: e } = env()
  try {
    let res = await fetchWorker(api('/api/status'), e)
    assert.equal(res.status, 200)
    assert.equal((await res.json() as { ready: boolean }).ready, false)
    res = await fetchWorker(api('/internal/snapshot/begin', {
      method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify({ snapshot }),
    }), e)
    assert.equal(res.status, 201)
    assert.equal((await fetchWorker(api(`/internal/snapshot/${snapshot.catalogVersion}/commit`, { method: 'POST', headers: auth() }), e)).status, 409)
    assert.equal((await fetchWorker(api(`/internal/snapshot/${snapshot.catalogVersion}/tiles/41_12`, { method: 'PUT', headers: auth(), body: '[{"id":1,"prices":[]}]' }), e)).status, 200)
    assert.equal((await fetchWorker(api(`/internal/snapshot/${snapshot.catalogVersion}/tiles/42_12`, { method: 'PUT', headers: auth(), body: '[]' }), e)).status, 200)
    assert.equal((await fetchWorker(api(`/internal/snapshot/${snapshot.catalogVersion}/commit`, { method: 'POST', headers: auth() }), e)).status, 200)
    const status = await fetchWorker(api('/api/status'), e).then((r) => r.json()) as { ready: boolean; catalogVersion: string }
    assert.equal(status.ready, true)
    assert.equal(status.catalogVersion, snapshot.catalogVersion)
    const tile = await fetchWorker(api(`/api/catalog/${snapshot.catalogVersion}/41_12`, { headers: { Origin: 'http://localhost:5173' } }), e)
    assert.equal(tile.status, 200)
    assert.equal(tile.headers.get('cache-control'), 'public, max-age=86400, immutable')
    assert.match(tile.headers.get('content-type')!, /application\/json/)
    assert.equal(await tile.text(), '[{"id":1,"prices":[]}]')
    assert.equal(await (await fetchWorker(api(`/api/catalog/${snapshot.catalogVersion}/99_99`), e)).text(), '[]')
    assert.equal((await fetchWorker(api(`/api/catalog/${'b'.repeat(32)}/41_12`), e)).status, 404)
    const older = { ...snapshot, catalogVersion: 'c'.repeat(32), sourceDate: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10) }
    assert.equal((await fetchWorker(api('/internal/snapshot/begin', {
      method: 'POST', headers: auth(), body: JSON.stringify({ snapshot: older }),
    }), e)).status, 201)
    for (const cell of older.cells) {
      await fetchWorker(api(`/internal/snapshot/${older.catalogVersion}/tiles/${cell}`, { method: 'PUT', headers: auth(), body: '[]' }), e)
    }
    assert.equal((await fetchWorker(api(`/internal/snapshot/${older.catalogVersion}/commit`, { method: 'POST', headers: auth() }), e)).status, 409)
    const unchanged = await fetchWorker(api('/api/status'), e).then((r) => r.json()) as { catalogVersion: string }
    assert.equal(unchanged.catalogVersion, snapshot.catalogVersion)
  } finally { mock.close() }
})

test('push subscriptions validate gateways, token auth, duplicates and monitor acks', async () => {
  const { mock, env: e } = env()
  try {
    assert.equal(allowedPushEndpoint('https://fcm.googleapis.com/fcm/send/test'), true)
    assert.equal(allowedPushEndpoint('https://push.services.mozilla.com/x'), true)
    assert.equal(allowedPushEndpoint('https://web.push.apple.com/x'), true)
    assert.equal(allowedPushEndpoint('https://a.notify.windows.com/x'), true)
    assert.equal(allowedPushEndpoint('http://fcm.googleapis.com/x'), false)
    assert.equal(allowedPushEndpoint('https://fcm.googleapis.com.evil.test/x'), false)
    const headers = { Origin: 'http://localhost:5173', 'Content-Type': 'application/json' }
    const body = {
      subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/api-test', keys: { p256dh: b64(65), auth: b64(16) } },
      monitor: { lat: 41.9, lon: 12.5, radius: 5, fuel: 'benzina', service: 'self', label: 'Test' },
    }
    const created = await fetchWorker(api('/api/push/subscriptions', { method: 'POST', headers, body: JSON.stringify(body) }), e)
    assert.equal(created.status, 201)
    const credentials = await created.json() as { id: string; token: string }
    assert.match(credentials.id, /^[0-9a-f-]{36}$/)
    assert.match(credentials.token, /^[a-f0-9]{64}$/)
    assert.equal((await fetchWorker(api('/api/push/subscriptions', { method: 'POST', headers, body: JSON.stringify(body) }), e)).status, 409)
    const url = `/api/push/subscriptions/${credentials.id}`
    assert.equal((await fetchWorker(api(url), e)).status, 401)
    assert.equal((await fetchWorker(api(url, { headers: { Authorization: `Bearer ${'0'.repeat(64)}` } }), e)).status, 403)
    let res = await fetchWorker(api(url, { headers: { Authorization: `Bearer ${credentials.token}` } }), e)
    assert.equal(res.status, 200)
    assert.deepEqual((await res.json() as { monitor: unknown }).monitor, body.monitor)
    const changed = { ...body.monitor, radius: 10 }
    res = await fetchWorker(api(url, { method: 'PUT', headers: { ...headers, Authorization: `Bearer ${credentials.token}` }, body: JSON.stringify({ monitor: changed }) }), e)
    assert.equal(res.status, 200)
    await mock.prepare('INSERT OR IGNORE INTO push_sent(subscription_id,fingerprint,sent_at) VALUES(?,?,?)').bind(credentials.id, 'fp1', new Date().toISOString()).run()
    const monitors = await fetchWorker(api('/internal/monitors?limit=25', { headers: auth() }), e).then((r) => r.json()) as { monitors: { id: string; monitor: string; sent: string }[] }
    assert.equal(monitors.monitors.length, 1)
    assert.equal(monitors.monitors[0]!.id, credentials.id)
    assert.deepEqual(JSON.parse(monitors.monitors[0]!.sent), ['fp1'])
    assert.equal((await fetchWorker(api(`/internal/monitors/${credentials.id}/ack`, {
      method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify({ monitor: JSON.stringify(changed), fingerprints: ['fp2', 'fp3'] }),
    }), e)).status, 200)
    assert.equal((await fetchWorker(api(`/internal/monitors/${credentials.id}/ack`, {
      method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify({ monitor: JSON.stringify(body.monitor), fingerprints: ['late'] }),
    }), e)).status, 409)
    assert.equal((await fetchWorker(api(url, { method: 'DELETE', headers: { ...headers, Authorization: `Bearer ${credentials.token}` } }), e)).status, 204)
    assert.equal((await fetchWorker(api(url, { method: 'DELETE', headers }), e)).status, 204)
  } finally { mock.close() }
})

test('geocode uses cache and rejects concurrent upstream calls with global throttle', async () => {
  const { mock, env: e } = env()
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return new Response(JSON.stringify({ features: [{ geometry: { coordinates: [12.5, 41.9] }, properties: { countrycode: 'IT', name: 'Roma', state: 'Lazio' } }] }), { status: 200 })
  }) as typeof fetch
  try {
    const headers = { Origin: 'http://localhost:5173' }
    let res = await fetchWorker(api('/api/geocode?q=Roma', { headers }), e)
    assert.equal(res.status, 200)
    assert.deepEqual((await res.json() as { results: unknown[] }).results, [{ lat: 41.9, lon: 12.5, label: 'Roma, Lazio' }])
    assert.equal(calls, 1)
    res = await fetchWorker(api('/api/geocode?q=roma', { headers }), e)
    assert.equal(res.status, 200)
    assert.equal(calls, 1)
    res = await fetchWorker(api('/api/geocode?q=Milano', { headers }), e)
    assert.equal(res.status, 429)
    assert.equal(calls, 1)
    assert.equal((await fetchWorker(api('/api/geocode?q=Torino', { headers: { Origin: 'https://evil.test' } }), e)).status, 403)
  } finally {
    globalThis.fetch = originalFetch
    mock.close()
  }
})

test('public request body is bounded even without a Content-Length header', async () => {
  const { mock, env: e } = env()
  try {
    const response = await fetchWorker(api('/api/push/subscriptions', {
      method: 'POST', headers: { Origin: 'http://localhost:5173' }, body: 'x'.repeat(17 * 1024),
    }), e)
    assert.equal(response.status, 413)
  } finally { mock.close() }
})
