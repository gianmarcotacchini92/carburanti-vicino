import { parse } from 'csv-parse/sync'
import type { DatabaseSync } from 'node:sqlite'
import { config } from './config.ts'
import { italianTimestamp, normalizeFuel } from './domain.ts'
import { fetchBytes } from './http.ts'
import { dataWarning, getMetadata, setMetadata } from './storage.ts'
import type { Fuel, StatusResponse } from '../shared/types.ts'

export const sources = {
  stations: 'https://www.mimit.gov.it/images/exportCSV/anagrafica_impianti_attivi.csv',
  prices: 'https://www.mimit.gov.it/images/exportCSV/prezzo_alle_8.csv',
}

interface StationRow {
  id: number
  name: string
  brand: string
  address: string
  town: string
  province: string
  lat: number
  lon: number
}
interface PriceRow {
  id: number
  fuel: Fuel
  self: number
  price: number
  reportedAt: string
}

function decode(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch (error) {
    if (!(error instanceof TypeError)) throw error
    return new TextDecoder('windows-1252').decode(bytes)
  }
}

function normalizeHeader(header: string) {
  return header.trim().toLowerCase().replace(/[\s_]/g, '')
}

export function parseCsv(bytes: Uint8Array, required: string[]): { sourceDate: string; rows: Record<string, string>[]; skippedRows: number } {
  const text = decode(bytes).replace(/^\uFEFF/, '')
  const firstBreak = text.indexOf('\n')
  if (firstBreak < 0) throw new Error('Dataset MIMIT vuoto o incompleto.')
  const dateLine = text.slice(0, firstBreak)
  const european = /(\d{2})\/(\d{2})\/(\d{4})/.exec(dateLine)
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(dateLine)
  const sourceDate = european ? `${european[3]}-${european[2]}-${european[1]}` : iso?.[0]
  if (!sourceDate || !italianTimestamp(`${sourceDate} 08:00:00`)) throw new Error('Data di estrazione MIMIT non valida.')
  let headersChecked = false
  const body = text.slice(firstBreak + 1)
  const header = body.slice(0, body.indexOf('\n') === -1 ? body.length : body.indexOf('\n'))
  const delimiter = header.includes('|') ? '|' : ';'
  let skippedRows = 0
  const rows = parse(body, {
    // MIMIT mixes quoted fields with literal quotes inside operator/station names.
    delimiter, relax_quotes: delimiter === '|', bom: true, skip_empty_lines: true,
    skip_records_with_error: true,
    on_skip: (error: { code: string } | undefined) => {
      if (error?.code !== 'CSV_RECORD_INCONSISTENT_COLUMNS') throw error
      skippedRows++
      return undefined
    },
    columns: (headers: string[]) => {
      const normalized = headers.map(normalizeHeader)
      for (const column of required) {
        if (!normalized.includes(column)) throw new Error(`Colonna MIMIT mancante: ${column}. Intestazioni ricevute: ${normalized.join(', ').slice(0, 250)}`)
      }
      headersChecked = true
      return normalized
    },
    trim: delimiter === ';',
  }) as Record<string, string>[]
  if (!headersChecked || !rows.length) throw new Error('Dataset MIMIT senza righe.')
  if (skippedRows > (rows.length + skippedRows) * 0.01) {
    throw new Error(`Dataset MIMIT malformato: oltre l'1% delle righe ha colonne inconsistenti (${skippedRows}).`)
  }
  if (skippedRows) console.warn(`CSV MIMIT: escluse ${skippedRows} righe con numero di colonne errato; nessun riallineamento arbitrario dei campi.`)
  return { sourceDate, rows, skippedRows }
}

const numeric = (value: string | undefined) => value?.trim() ? Number(value.replace(',', '.')) : Number.NaN

export function importSnapshot(db: DatabaseSync, stationBytes: Uint8Array, priceBytes: Uint8Array, minimumRows = 1000) {
  const stationData = parseCsv(stationBytes, ['idimpianto', 'bandiera', 'nomeimpianto', 'indirizzo', 'comune', 'provincia', 'latitudine', 'longitudine'])
  const priceData = parseCsv(priceBytes, ['idimpianto', 'desccarburante', 'prezzo', 'isself', 'dtcomu'])
  if (stationData.sourceDate !== priceData.sourceDate) {
    throw new Error('I due dataset MIMIT hanno date diverse. Mantengo la precedente copia completa e riprovo piu tardi.')
  }
  const previousDate = getMetadata(db, 'sourceDate')
  if (previousDate && stationData.sourceDate < previousDate) {
    throw new Error('Il MIMIT ha restituito un dataset piu vecchio della copia locale. Copia precedente conservata.')
  }
  const stations = new Map<number, StationRow>()
  let invalidStations = stationData.skippedRows
  for (const row of stationData.rows) {
    const id = numeric(row.idimpianto)
    const lat = numeric(row.latitudine)
    const lon = numeric(row.longitudine)
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isFinite(lat) || !Number.isFinite(lon) ||
      lat < 35 || lat > 48 || lon < 6 || lon > 19) { invalidStations++; continue }
    stations.set(id, {
      id, lat, lon, name: row.nomeimpianto?.trim() || row.bandiera?.trim() || `Impianto ${id}`,
      brand: row.bandiera?.trim() || 'Pompa indipendente', address: row.indirizzo?.trim() || '',
      town: row.comune?.trim() || '', province: row.provincia?.trim() || '',
    })
  }
  const prices = new Map<string, PriceRow>()
  let invalidPrices = priceData.skippedRows
  let excludedFuels = 0
  for (const row of priceData.rows) {
    const fuel = normalizeFuel(row.desccarburante || '')
    if (!fuel) { excludedFuels++; continue }
    const id = numeric(row.idimpianto)
    const price = numeric(row.prezzo)
    const self = numeric(row.isself)
    const reportedAt = italianTimestamp(row.dtcomu || '')
    if (!stations.has(id) || !Number.isFinite(price) || price <= 0 || price > 100 ||
      ![0, 1].includes(self) || !reportedAt || Date.parse(reportedAt) > Date.now() + 86_400_000) {
      invalidPrices++
      continue
    }
    const key = `${id}:${fuel}:${self}`
    const previous = prices.get(key)
    if (!previous || previous.reportedAt < reportedAt) prices.set(key, { id, fuel, self, price, reportedAt })
  }
  if (stations.size < minimumRows || prices.size < minimumRows) {
    throw new Error(`Dataset MIMIT incompleto: ${stations.size} impianti e ${prices.size} prezzi validi. Copia precedente conservata.`)
  }
  const oldStationCount = Number(db.prepare('SELECT COUNT(*) AS total FROM stations').get()!.total)
  const oldPriceCount = Number(db.prepare('SELECT COUNT(*) AS total FROM prices').get()!.total)
  if (stations.size < oldStationCount * 0.8 || prices.size < oldPriceCount * 0.8) {
    throw new Error('Il dataset MIMIT ha perso oltre il 20% delle righe. Importazione sospesa per evitare dati incompleti.')
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec('DELETE FROM prices; DELETE FROM stations;')
    const insertStation = db.prepare('INSERT INTO stations(id,name,brand,address,town,province,lat,lon) VALUES(?,?,?,?,?,?,?,?)')
    for (const station of stations.values()) {
      insertStation.run(station.id, station.name, station.brand, station.address, station.town, station.province, station.lat, station.lon)
    }
    const insertPrice = db.prepare('INSERT INTO prices(station_id,fuel,self,price,reported_at) VALUES(?,?,?,?,?)')
    for (const price of prices.values()) insertPrice.run(price.id, price.fuel, price.self, price.price, price.reportedAt)
    setMetadata(db, 'lastRefreshAt', new Date().toISOString())
    setMetadata(db, 'sourceDate', stationData.sourceDate)
    setMetadata(db, 'refreshError', '')
    setMetadata(db, 'importStats', JSON.stringify({ invalidStations, invalidPrices, excludedFuels }))
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
  console.info(`Dati MIMIT ${stationData.sourceDate}: ${stations.size} impianti, ${prices.size} prezzi; esclusi ${invalidStations} impianti non mappabili, ${invalidPrices} prezzi invalidi/non associati, ${excludedFuels} carburanti speciali.`)
}

export function createDataService(db: DatabaseSync) {
  let refreshing = false
  function status(): StatusResponse {
    const lastRefreshAt = getMetadata(db, 'lastRefreshAt')
    const sourceDate = getMetadata(db, 'sourceDate')
    return {
      ready: !!lastRefreshAt, refreshing, lastRefreshAt, sourceDate,
      stationCount: Number(db.prepare('SELECT COUNT(*) AS total FROM stations').get()!.total),
      priceCount: Number(db.prepare('SELECT COUNT(*) AS total FROM prices').get()!.total),
      warning: dataWarning(db),
    }
  }
  async function refresh() {
    if (refreshing) return
    refreshing = true
    try {
      const stationBytes = await fetchBytes(sources.stations, 30_000_000, 90_000)
      const priceBytes = await fetchBytes(sources.prices, 40_000_000, 90_000)
      importSnapshot(db, stationBytes, priceBytes)
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'errore sconosciuto'
      console.error('Aggiornamento MIMIT fallito:', detail)
      setMetadata(db, 'refreshError', 'Aggiornamento MIMIT non riuscito. Gli eventuali dati mostrati provengono dall\'ultima importazione; nuovo tentativo entro 15 minuti.')
    } finally { refreshing = false }
  }
  async function refreshIfDue() {
    const last = getMetadata(db, 'lastRefreshAt')
    if (!last || getMetadata(db, 'refreshError') || Date.now() - Date.parse(last) >= config.DATA_REFRESH_HOURS * 3_600_000) {
      await refresh()
    }
  }
  return { status, refresh, refreshIfDue }
}
