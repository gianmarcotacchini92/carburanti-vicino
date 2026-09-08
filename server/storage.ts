import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { config } from './config.ts'
import { analysis, annotateAnomalies, areaBounds, distanceKm, italianTimestamp, median, stalePrice } from './domain.ts'
import type { SearchArea, StationResult, StationsResponse } from '../shared/types.ts'

export function openDatabase(filename: string): DatabaseSync {
  const db = new DatabaseSync(filename)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS stations (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, brand TEXT NOT NULL, address TEXT NOT NULL,
      town TEXT NOT NULL, province TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS stations_geo ON stations(lat, lon);
    CREATE TABLE IF NOT EXISTS prices (
      station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
      fuel TEXT NOT NULL, self INTEGER NOT NULL, price REAL NOT NULL, reported_at TEXT NOT NULL,
      PRIMARY KEY(station_id, fuel, self)
    );
    CREATE INDEX IF NOT EXISTS prices_fuel ON prices(fuel, station_id);
    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, endpoint TEXT UNIQUE NOT NULL,
      subscription TEXT NOT NULL, monitor TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS push_sent (
      subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL, sent_at TEXT NOT NULL,
      PRIMARY KEY(subscription_id, fingerprint)
    );
    CREATE TABLE IF NOT EXISTS geocode_cache (
      query TEXT PRIMARY KEY, response TEXT NOT NULL, created_at INTEGER NOT NULL
    );
  `)
  return db
}

let instance: DatabaseSync | undefined
export function database(): DatabaseSync {
  if (!instance) {
    mkdirSync(config.dataDir, { recursive: true })
    instance = openDatabase(path.join(config.dataDir, 'pieno.sqlite'))
  }
  return instance
}

export function getMetadata(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(key)
  return row ? String(row.value) : null
}

export function setMetadata(db: DatabaseSync, key: string, value: string) {
  db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, value)
}

export function dataWarning(db: DatabaseSync): string | null {
  const updatedAt = getMetadata(db, 'lastRefreshAt')
  const sourceDate = getMetadata(db, 'sourceDate')
  const sourceInstant = sourceDate ? italianTimestamp(`${sourceDate} 08:00:00`) : null
  return getMetadata(db, 'refreshError') ||
    (updatedAt && Date.now() - Date.parse(updatedAt) > 36 * 3_600_000
      ? 'La copia locale dei dati non viene aggiornata da oltre 36 ore.'
      : sourceInstant && Date.now() - Date.parse(sourceInstant) > 72 * 3_600_000
        ? 'Il dataset pubblicato dal MIMIT risale a oltre 72 ore fa: verifica la data dei prezzi.' : null)
}

export function searchStations(db: DatabaseSync, area: SearchArea): StationsResponse {
  const bounds = areaBounds(area)
  const rows = db.prepare(`
    SELECT s.*, p.price, p.self, p.reported_at FROM stations s
    JOIN prices p ON p.station_id = s.id
    WHERE p.fuel = ? AND s.lat BETWEEN ? AND ? AND s.lon BETWEEN ? AND ?
      AND (? = 'all' OR p.self = ?)
  `).all(area.fuel, bounds.south, bounds.north, bounds.west, bounds.east, area.service, area.service === 'self' ? 1 : 0)
  const now = Date.now()
  const nearby: StationResult[] = rows.map((row) => ({
    id: Number(row.id), name: String(row.name), brand: String(row.brand),
    address: String(row.address), town: String(row.town), province: String(row.province),
    lat: Number(row.lat), lon: Number(row.lon),
    price: Number(row.price), self: row.self === 1,
    unit: area.fuel === 'metano' ? 'kg' as const : 'L' as const,
    reportedAt: String(row.reported_at), isStale: stalePrice(String(row.reported_at), now),
    distanceKm: distanceKm(area.lat, area.lon, Number(row.lat), Number(row.lon)),
    isAnomaly: false, discountPercent: 0, peerMedian: null,
  })).filter((station) => station.distanceKm <= area.radius)
  // In "all" mode, comparisons still keep self-service and attended prices separate.
  const stations = annotateAnomalies(nearby).sort((a, b) => a.price - b.price || a.distanceKm - b.distanceKm)
  const freshPrices = stations.filter((station) => !station.isStale).map((station) => station.price)
  const updatedAt = getMetadata(db, 'lastRefreshAt')
  return {
    stations, total: stations.length,
    medianPrice: median(freshPrices),
    cheapestPrice: freshPrices.length ? Math.min(...freshPrices) : null,
    updatedAt, sourceDate: getMetadata(db, 'sourceDate'), warning: dataWarning(db), analysis,
  }
}
