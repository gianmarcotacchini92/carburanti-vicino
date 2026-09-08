import 'dotenv/config'
import { randomBytes } from 'node:crypto'
import webpush from 'web-push'
import { z } from 'zod'
import { createDataService } from '../server/data.ts'
import { getMetadata, openDatabase } from '../server/storage.ts'
import { monitorSchema, subscriptionSchema } from '../server/validation.ts'
import { cellsFor, searchCatalog } from '../shared/catalog.ts'
import { priceFingerprint, pushMessage } from '../shared/push-message.ts'
import type { CatalogSnapshot, CatalogStation, CloudMonitor } from '../shared/types.ts'
import { buildCatalog } from './catalog-builder.ts'

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

async function currentSnapshot() {
  try { return await request<CatalogSnapshot>('/internal/snapshot') }
  catch (error) {
    if (error instanceof RemoteError && error.status === 404) return null
    throw error
  }
}

async function main() {
  await request('/internal/cleanup', 'POST', {})
  let snapshot = await currentSnapshot()
  const catalog = new Map<string, CatalogStation[]>()
  if (!snapshot?.lastRefreshAt || Date.now() - Date.parse(snapshot.lastRefreshAt) > 6 * 3_600_000) {
    const db = openDatabase(':memory:')
    try {
      const data = createDataService(db)
      await data.refresh()
      if (!data.status().ready) throw new Error(getMetadata(db, 'refreshError') || 'Importazione MIMIT non completata.')
      const status = data.status()
      if (snapshot && (status.stationCount < snapshot.stationCount * 0.8 || status.priceCount < snapshot.priceCount * 0.8)) {
        throw new Error('Il nuovo catalogo ha perso oltre il 20% delle righe: copia precedente conservata.')
      }
      const tiles = buildCatalog(db)
      const next: CatalogSnapshot = {
        ...status, catalogVersion: randomBytes(16).toString('hex'), cells: [...tiles.keys()].sort(),
      }
      await request('/internal/snapshot/begin', 'POST', { snapshot: next })
      for (const [cell, tile] of tiles) {
        await request(`/internal/snapshot/${next.catalogVersion}/tiles/${cell}`, 'PUT', tile)
      }
      await request(`/internal/snapshot/${next.catalogVersion}/commit`, 'POST', {})
      snapshot = next
      for (const [cell, tile] of tiles) catalog.set(cell, tile)
      console.info(`Catalogo pubblicato: ${next.sourceDate}, ${next.stationCount} impianti, ${next.priceCount} prezzi, ${next.cells.length} celle.`)
    } catch (error) {
      console.error('Aggiornamento cloud fallito:', error instanceof Error ? error.message : 'errore sconosciuto')
      process.exitCode = 1
      await request('/internal/snapshot/failure', 'POST', { error: 'Aggiornamento MIMIT non riuscito. Manteniamo la copia precedente e riproviamo al prossimo job.' })
      snapshot = await currentSnapshot()
    } finally { db.close() }
  }
  if (!snapshot?.lastRefreshAt) throw new Error('Nessun catalogo disponibile per il monitoraggio.')
  if (Date.now() - Date.parse(snapshot.lastRefreshAt) > 36 * 3_600_000) {
    console.warn('Invii push sospesi: copia locale vecchia di oltre 36 ore.')
    return
  }
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
      const cells = cellsFor(monitor)
      for (const cell of cells) {
        if (!catalog.has(cell)) {
          catalog.set(cell, await request<CatalogStation[]>(`/api/catalog/${snapshot.catalogVersion}/${cell}`))
        }
      }
      const stations = searchCatalog(cells.flatMap((cell) => catalog.get(cell)!), monitor, snapshot).stations
        .filter((station) => station.isAnomaly && !seen.has(priceFingerprint(station, monitor)))
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
