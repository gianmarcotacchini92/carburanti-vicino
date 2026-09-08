import type { DatabaseSync } from 'node:sqlite'
import { cellFor } from '../shared/catalog.ts'
import type { CatalogStation, Fuel } from '../shared/types.ts'

export function buildCatalog(db: DatabaseSync): Map<string, CatalogStation[]> {
  const stations = new Map<number, CatalogStation>()
  for (const row of db.prepare('SELECT * FROM stations').all()) {
    const id = Number(row.id)
    stations.set(id, {
      id, name: String(row.name), brand: String(row.brand), address: String(row.address),
      town: String(row.town), province: String(row.province), lat: Number(row.lat), lon: Number(row.lon), prices: [],
    })
  }
  for (const row of db.prepare('SELECT * FROM prices').all()) {
    const station = stations.get(Number(row.station_id))
    if (!station) throw new Error('Prezzo privo di impianto durante la creazione del catalogo.')
    station.prices.push({
      fuel: String(row.fuel) as Fuel, self: row.self === 1,
      price: Number(row.price), reportedAt: String(row.reported_at),
    })
  }
  const tiles = new Map<string, CatalogStation[]>()
  for (const station of stations.values()) {
    const cell = cellFor(station.lat, station.lon)
    const tile = tiles.get(cell) ?? []
    tile.push(station)
    tiles.set(cell, tile)
  }
  for (const [cell, tile] of tiles) {
    if (Buffer.byteLength(JSON.stringify(tile)) > 1_500_000) throw new Error(`La cella ${cell} supera il limite D1: aggiornamento annullato.`)
  }
  return tiles
}
