import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import webpush from 'web-push'
import { z } from 'zod'
import { config } from './config.ts'
import { getMetadata, setMetadata } from './storage.ts'
import { createSubscriptionSchema, HttpError, monitorSchema, subscriptionSchema } from './validation.ts'
import type { LiveStationDetail, Monitor, PushCredentials, SearchArea, StationsResponse } from '../shared/types.ts'
import { confirmLiveAnomalies, fetchLiveStation, fetchLiveStations } from '../shared/mimit-live.ts'
import { priceFingerprint, pushMessage } from '../shared/push-message.ts'

type Sender = typeof webpush.sendNotification
type LiveClient = {
  fetchStations(area: SearchArea): Promise<StationsResponse>
  fetchStation(id: number, options?: { refresh?: boolean }): Promise<LiveStationDetail>
}
const hash = (token: string) => createHash('sha256').update(token).digest('hex')
const keysSchema = z.object({ publicKey: z.string(), privateKey: z.string() })
const defaultLiveClient: LiveClient = { fetchStations: fetchLiveStations, fetchStation: fetchLiveStation }

export function createPushService(db: DatabaseSync, sender: Sender = webpush.sendNotification, liveClient: LiveClient = defaultLiveClient) {
  const storedKeys = getMetadata(db, 'vapidKeys')
  const keys = storedKeys ? keysSchema.parse(JSON.parse(storedKeys)) : webpush.generateVAPIDKeys()
  if (!storedKeys) setMetadata(db, 'vapidKeys', JSON.stringify(keys))
  webpush.setVapidDetails(config.VAPID_SUBJECT, keys.publicKey, keys.privateKey)
  let scanning = false

  function authorize(id: string, authorization: string | undefined) {
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : ''
    if (!/^[a-f0-9]{64}$/.test(token)) throw new HttpError(401, 'Autorizzazione notifiche non valida.')
    const row = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id)
    if (!row) throw new HttpError(404, 'Monitoraggio non trovato. Attiva nuovamente le notifiche.')
    if (!timingSafeEqual(Buffer.from(hash(token), 'hex'), Buffer.from(String(row.token_hash), 'hex'))) {
      throw new HttpError(403, 'Non puoi modificare questo monitoraggio.')
    }
    return row
  }

  function add(input: unknown): PushCredentials {
    const { subscription, monitor } = createSubscriptionSchema.parse(input)
    if (db.prepare('SELECT id FROM subscriptions WHERE endpoint = ?').get(subscription.endpoint)) {
      throw new HttpError(409, 'Questo browser ha gia un monitoraggio. Ripristina la sottoscrizione per attivarlo nuovamente.')
    }
    if (Number(db.prepare('SELECT COUNT(*) AS total FROM subscriptions').get()!.total) >= 1000) {
      throw new HttpError(503, 'Limite monitoraggi raggiunto. Contatta il gestore del servizio.')
    }
    const id = randomUUID()
    const token = randomBytes(32).toString('hex')
    db.prepare('INSERT INTO subscriptions(id,token_hash,endpoint,subscription,monitor,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, hash(token), subscription.endpoint, JSON.stringify(subscription), JSON.stringify(monitor), new Date().toISOString())
    return { id, token }
  }

  function get(id: string, authorization: string | undefined): { monitor: Monitor } {
    const row = authorize(id, authorization)
    return { monitor: monitorSchema.parse(JSON.parse(String(row.monitor))) }
  }

  function update(id: string, authorization: string | undefined, input: unknown) {
    const row = authorize(id, authorization)
    const { monitor } = z.object({ monitor: monitorSchema }).parse(input)
    const serialized = JSON.stringify(monitor)
    if (String(row.monitor) !== serialized) {
      db.exec('BEGIN')
      try {
        db.prepare('UPDATE subscriptions SET monitor = ? WHERE id = ?').run(serialized, id)
        db.prepare('DELETE FROM push_sent WHERE subscription_id = ?').run(id)
        db.exec('COMMIT')
      } catch (error) { db.exec('ROLLBACK'); throw error }
    }
  }

  function remove(id: string, authorization: string | undefined) {
    // A missing record is already disabled; knowledge of the id exposes no subscription data.
    if (!db.prepare('SELECT id FROM subscriptions WHERE id = ?').get(id)) return
    authorize(id, authorization)
    db.prepare('DELETE FROM subscriptions WHERE id = ?').run(id)
  }

  async function scan() {
    if (scanning) return
    scanning = true
    try {
      db.prepare('DELETE FROM push_sent WHERE sent_at < ?').run(new Date(Date.now() - 90 * 86_400_000).toISOString())
      for (const row of db.prepare('SELECT * FROM subscriptions').all()) {
        const id = String(row.id)
        const monitor = monitorSchema.parse(JSON.parse(String(row.monitor)))
        const subscription = subscriptionSchema.parse(JSON.parse(String(row.subscription)))
        let anomalies
        try {
          const result = await liveClient.fetchStations(monitor)
          const candidates = result.stations.map((station) => ({
            station,
            fingerprint: priceFingerprint(station, monitor),
          }))
          if (!candidates.some(({ station, fingerprint }) =>
            station.isAnomaly && !db.prepare('SELECT 1 FROM push_sent WHERE subscription_id = ? AND fingerprint = ?').get(id, fingerprint))) continue
          const confirmable = {
            ...result,
            stations: result.stations.map((station) =>
              db.prepare('SELECT 1 FROM push_sent WHERE subscription_id = ? AND fingerprint = ?')
                .get(id, priceFingerprint(station, monitor)) ? { ...station, isAnomaly: false } : station),
          }
          anomalies = await confirmLiveAnomalies(confirmable, monitor, (stationId) => liveClient.fetchStation(stationId, { refresh: true }))
        } catch (error) {
          console.error(`Monitoraggio push ${id} sospeso: ${error instanceof Error ? error.message : 'fonte live non disponibile'}.`)
          continue
        }
        const unseen = anomalies.map((station) => ({
          station,
          fingerprint: priceFingerprint(station, monitor),
        })).filter(({ fingerprint }) =>
          !db.prepare('SELECT 1 FROM push_sent WHERE subscription_id = ? AND fingerprint = ?').get(id, fingerprint))
        if (!unseen.length) continue
        const payload = JSON.stringify(pushMessage(id, monitor, unseen.map(({ station }) => station)))
        try {
          await sender(subscription, payload, { TTL: 21_600, urgency: 'normal', timeout: 10_000 })
          // A subscription can be deleted/changed while the gateway request is in flight.
          const current = db.prepare('SELECT monitor FROM subscriptions WHERE id = ?').get(id)
          if (current?.monitor !== row.monitor) continue
          const insert = db.prepare('INSERT OR IGNORE INTO push_sent(subscription_id,fingerprint,sent_at) VALUES(?,?,?)')
          for (const { fingerprint } of unseen) insert.run(id, fingerprint, new Date().toISOString())
        } catch (error) {
          if (error instanceof webpush.WebPushError && [404, 410].includes(error.statusCode)) {
            db.prepare('DELETE FROM subscriptions WHERE id = ?').run(id)
            console.info(`Sottoscrizione push scaduta rimossa: ${id}`)
          } else {
            // Do not log endpoint/key material; unsuccessful deliveries remain eligible for retry.
            console.error(`Invio push fallito per ${id}; nuovo tentativo al prossimo ciclo.`,
              error instanceof webpush.WebPushError ? `HTTP ${error.statusCode}` : 'Errore di trasporto')
          }
        }
      }
    } finally { scanning = false }
  }

  return { publicKey: keys.publicKey, add, get, update, remove, scan }
}
