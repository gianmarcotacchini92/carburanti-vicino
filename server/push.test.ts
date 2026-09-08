import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import webpush from 'web-push'
import { createPushService } from './push.ts'
import { openDatabase, setMetadata } from './storage.ts'
import { allowedPushEndpoint } from './validation.ts'

const monitor = { lat: 41.9, lon: 12.5, radius: 5, fuel: 'benzina', service: 'self', label: 'Zona test' }
const subscription = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/test-only',
  keys: { p256dh: webpush.generateVAPIDKeys().publicKey, auth: randomBytes(16).toString('base64url') },
}

function fixture() {
  const db = openDatabase(':memory:')
  for (let id = 1; id <= 6; id++) {
    db.prepare('INSERT INTO stations VALUES(?,?,?,?,?,?,?,?)').run(id, `Test ${id}`, 'Test', 'Via test', 'Roma', 'RM', 41.9, 12.5)
    db.prepare('INSERT INTO prices VALUES(?,?,?,?,?)').run(id, 'benzina', 1, id === 1 ? 0.5 : 2, new Date().toISOString())
  }
  setMetadata(db, 'lastRefreshAt', new Date().toISOString())
  return db
}

test('endpoint push accetta solo gateway HTTPS conosciuti', () => {
  assert.equal(allowedPushEndpoint(subscription.endpoint), true)
  assert.equal(allowedPushEndpoint('https://web.push.apple.com/test'), true)
  assert.equal(allowedPushEndpoint('https://a.notify.windows.com/test'), true)
  for (const endpoint of ['http://fcm.googleapis.com/test', 'https://127.0.0.1/test', 'https://fcm.googleapis.com.evil.test/x', 'https://evil.test/?url=https://fcm.googleapis.com', 'https://fcm.googleapis.com:8443/test', 'https://user:pass@fcm.googleapis.com/test']) {
    assert.equal(allowedPushEndpoint(endpoint), false, endpoint)
  }
})

test('sottoscrizioni protette da token; push deduplicate e nuove variazioni inviate', async () => {
  const db = fixture()
  const payloads: string[] = []
  const push = createPushService(db, async (_subscription, payload) => {
    payloads.push(String(payload))
    return { statusCode: 201, body: '', headers: {} }
  })
  const credentials = push.add({ subscription, monitor })
  const auth = `Bearer ${credentials.token}`
  assert.deepEqual(push.get(credentials.id, auth).monitor, monitor)
  assert.throws(() => push.get(credentials.id, undefined), /Autorizzazione/)
  assert.throws(() => push.update(credentials.id, `Bearer ${'0'.repeat(64)}`, { monitor }), /Non puoi/)
  assert.throws(() => push.add({ subscription, monitor }), /gia un monitoraggio/)
  await push.scan()
  await push.scan()
  assert.equal(payloads.length, 1)
  const payload = JSON.parse(payloads[0]!) as { body: string; url: string }
  assert.match(payload.body, /possibile|errore/)
  assert.match(payload.url, /fuel=benzina/)
  assert.match(payload.url, /stationSelf=1/)
  db.prepare('UPDATE prices SET price = 0.6 WHERE station_id = 1').run()
  await push.scan()
  assert.equal(payloads.length, 2)
  push.remove(credentials.id, auth)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_sent').get()!.n, 0)
  await push.scan()
  assert.equal(payloads.length, 2)
  db.close()
})

test('fallimenti di consegna non segnati come successo e copia vecchia sospende avvisi', async () => {
  const db = fixture()
  let attempts = 0
  const push = createPushService(db, async () => {
    attempts++
    throw new webpush.WebPushError('temporary test error', 503, {}, '', subscription.endpoint)
  })
  push.add({ subscription, monitor })
  await push.scan()
  await push.scan()
  assert.equal(attempts, 2)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_sent').get()!.n, 0)
  setMetadata(db, 'lastRefreshAt', new Date(Date.now() - 48 * 3_600_000).toISOString())
  await push.scan()
  assert.equal(attempts, 2)
  db.close()
})

test('gateway 410 elimina sottoscrizione scaduta', async () => {
  const db = fixture()
  const push = createPushService(db, async () => {
    throw new webpush.WebPushError('gone', 410, {}, '', subscription.endpoint)
  })
  push.add({ subscription, monitor })
  await push.scan()
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM subscriptions').get()!.n, 0)
  db.close()
})
