import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildCatalog } from '../jobs/catalog-builder.ts'
import { cellsFor, searchCatalog } from '../shared/catalog.ts'
import { openDatabase, searchStations, setMetadata } from './storage.ts'

test('catalogo cloud e SQLite producono gli stessi prezzi, anomalie e unita', () => {
  const db = openDatabase(':memory:')
  try {
    for (let id = 1; id <= 7; id++) {
      db.prepare('INSERT INTO stations VALUES(?,?,?,?,?,?,?,?)')
        .run(id, `Fixture ${id}`, 'Fixture', 'Via test', 'Roma', 'RM', 41.9 + id * 0.001, 12.5)
      for (const fuel of ['benzina', 'metano']) {
        for (const self of [0, 1]) {
          db.prepare('INSERT INTO prices VALUES(?,?,?,?,?)')
            .run(id, fuel, self, id === 1 ? 0.5 : 2 + (self ? 0 : 0.2), new Date().toISOString())
        }
      }
    }
    setMetadata(db, 'lastRefreshAt', new Date().toISOString())
    setMetadata(db, 'sourceDate', new Date().toISOString().slice(0, 10))
    const tiles = buildCatalog(db)
    for (const fuel of ['benzina', 'metano'] as const) {
      for (const service of ['self', 'servito', 'all'] as const) {
        const area = { lat: 41.9, lon: 12.5, radius: 5, fuel, service }
        const expected = searchStations(db, area)
        const status = {
          ready: true, refreshing: false, lastRefreshAt: expected.updatedAt, sourceDate: expected.sourceDate,
          stationCount: 7, priceCount: 28, warning: expected.warning,
        }
        const actual = searchCatalog(cellsFor(area).flatMap((cell) => tiles.get(cell) ?? []), area, status)
        assert.deepEqual(actual, expected)
        assert.ok(actual.stations.some((station) => station.isAnomaly))
      }
    }
    assert.ok(cellsFor({ lat: 47, lon: 12, radius: 30, fuel: 'benzina', service: 'all' }).length <= 36)
  } finally { db.close() }
})
