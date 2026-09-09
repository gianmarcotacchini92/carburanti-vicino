import 'dotenv/config'
import webpush from 'web-push'
import { z } from 'zod'
import { monitorSchema, subscriptionSchema } from '../server/validation.ts'
import { priceFingerprint, pushMessage } from '../shared/push-message.ts'
import type { CloudMonitor, LiveStationDetail, StationsResponse } from '../shared/types.ts'
import { unseenLiveAnomalies } from './live-monitor.ts'

const env = z.object({
  API_URL: z.url(),
  JOB_TOKEN: z.string().min(32),
  VAPID_PUBLIC_KEY: z.string().min(40),
  VAPID_PRIVATE_KEY: z.string().min(20),
  APP_URL: z.url(),
}).parse(process.env)
const origin = new URL(env.API_URL)
if (origin.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(origin.hostname)) {
  throw new Error('Il backend remoto deve usare HTTPS.')
}

class RemoteError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(new URL(path, origin), {
    method, signal: AbortSignal.timeout(60_000),
    headers: {
      Authorization: `Bearer ${env.JOB_TOKEN}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  if (!response.ok) throw new RemoteError(response.status, `Backend HTTP ${response.status} su ${path.split('?')[0]}`)
  if (response.status === 204) return undefined as T
  return await response.json() as T
}

async function main() {
  await request('/internal/cleanup', 'POST', {})
  webpush.setVapidDetails(env.APP_URL, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY)
  let cursor: string | null = null
  let sentCount = 0
  do {
    const page: { monitors: CloudMonitor[]; nextCursor: string | null } = await request(
      `/internal/monitors?limit=25${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`,
    )
    for (const row of page.monitors) {
      const monitor = monitorSchema.parse(JSON.parse(row.monitor))
      const subscription = subscriptionSchema.parse(JSON.parse(row.subscription))
      const seen = new Set(z.array(z.string()).parse(JSON.parse(row.sent)))
      const query = new URLSearchParams({
        lat: String(monitor.lat), lon: String(monitor.lon), radius: String(monitor.radius),
        fuel: monitor.fuel, service: monitor.service,
      })
      let stations
      try {
        const result = await request<StationsResponse>(`/api/stations?${query}`)
        stations = await unseenLiveAnomalies(result, monitor, seen,
          (id) => request<LiveStationDetail>(`/api/stations/${id}?refresh=1`))
      } catch (error) {
        console.error(`Monitoraggio ${row.id} sospeso: ${error instanceof Error ? error.message : 'fonte non disponibile'}. Nessun avviso basato su prezzi vecchi.`)
        process.exitCode = 1
        continue
      }
      if (!stations.length) continue
      try {
        await webpush.sendNotification(subscription, JSON.stringify(pushMessage(row.id, monitor, stations, new URL(env.APP_URL).pathname)), {
          TTL: 21_600, urgency: 'normal', timeout: 10_000,
        })
      } catch (error) {
        if (error instanceof webpush.WebPushError && [404, 410].includes(error.statusCode)) {
          await request(`/internal/monitors/${row.id}`, 'DELETE')
          console.info(`Monitoraggio scaduto rimosso: ${row.id}`)
        } else {
          console.error(`Invio non riuscito per ${row.id}: ${error instanceof webpush.WebPushError ? `HTTP ${error.statusCode}` : 'errore di trasporto'}. Sarà ritentato.`)
          process.exitCode = 1
        }
        continue
      }
      try {
        await request(`/internal/monitors/${row.id}/ack`, 'POST', {
          monitor: row.monitor, fingerprints: stations.map((station) => priceFingerprint(station, monitor)),
        })
        sentCount++
      } catch (error) {
        if (error instanceof RemoteError && [404, 409].includes(error.status)) {
          console.info(`Monitoraggio ${row.id} modificato durante l'invio; storico non aggiornato.`)
        } else { throw error }
      }
    }
    cursor = page.nextCursor
  } while (cursor)
  console.info(`Controllo completato: ${sentCount} notifiche inviate.`)
}

await main()
