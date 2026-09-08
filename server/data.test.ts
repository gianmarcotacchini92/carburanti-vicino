import assert from 'node:assert/strict'
import { test } from 'node:test'
import { importSnapshot, parseCsv } from './data.ts'
import { openDatabase, searchStations, getMetadata } from './storage.ts'

const bytes = (text: string) => new TextEncoder().encode(text)
const registry = `01/09/2026
idImpianto;Gestore;Bandiera;Tipo Impianto;Nome Impianto;Indirizzo;Comune;Provincia;Latitudine;Longitudine
1;Gestore;Test;Stradale;"Stazione; Centrale";Via Roma;Roma;RM;41.9;12.5
2;Gestore;Test;Stradale;Non mappabile;Via test;Roma;RM;0;0
`
const prices = `01/09/2026
idImpianto;descCarburante;prezzo;isSelf;dtComu
1;Benzina;1.799;1;01/09/2025 08:00:00
1;Benzina;1.899;0;01/09/2025 08:00:00
1;Metano;1.299;0;01/09/2025 08:00:00
1;Gasolio Premium;2.299;1;01/09/2025 08:00:00
2;Benzina;1.500;1;01/09/2025 08:00:00
`

test('importa CSV MIMIT, gestisce delimitatori quotati, impianti non mappabili, modalita e unita', () => {
  const db = openDatabase(':memory:')
  importSnapshot(db, bytes(registry), bytes(prices), 1)
  const area = { lat: 41.9, lon: 12.5, radius: 5, fuel: 'benzina' as const, service: 'self' as const }
  const result = searchStations(db, area)
  assert.equal(result.total, 1)
  assert.equal(result.stations[0]!.name, 'Stazione; Centrale')
  assert.equal(result.stations[0]!.price, 1.799)
  assert.equal(searchStations(db, { ...area, service: 'all' }).total, 2)
  assert.equal(searchStations(db, { ...area, fuel: 'metano', service: 'servito' }).stations[0]!.unit, 'kg')
  assert.equal(searchStations(db, { ...area, fuel: 'gasolio' }).total, 0)
  assert.equal(searchStations(db, { ...area, lat: 45.4 }).total, 0)
  assert.equal(getMetadata(db, 'sourceDate'), '2026-09-01')
  db.close()
})

test('dataset non validi non sostituiscono la copia precedente', () => {
  const db = openDatabase(':memory:')
  importSnapshot(db, bytes(registry), bytes(prices), 1)
  assert.throws(() => importSnapshot(db, bytes(registry), bytes(prices.replace('01/09/2026', '02/09/2026')), 1), /date diverse/)
  assert.throws(() => importSnapshot(db, bytes(registry), bytes(prices), 1000), /incompleto/)
  assert.throws(() => importSnapshot(db, bytes(registry.replace('01/09/2026', '31/08/2026')), bytes(prices.replace('01/09/2026', '31/08/2026')), 1), /piu vecchio/)
  assert.throws(() => parseCsv(bytes('<html>Errore</html>'), ['idimpianto']), /incompleto/)
  assert.throws(() => parseCsv(bytes('01/09/2026\nwrong;header\n1;2'), ['idimpianto']), /mancante/)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM prices').get()!.n, 3)
  assert.equal(getMetadata(db, 'sourceDate'), '2026-09-01')
  db.close()
})

test('UTF-8 BOM e fallback Windows-1252 mantengono i nomi accentati', () => {
  const csv = '\uFEFF01/09/2026\r\nidImpianto;nome\r\n1;Citta\r\n'
  assert.equal(parseCsv(bytes(csv), ['idimpianto']).rows[0]!.nome, 'Citta')
  const latin = Buffer.from('01/09/2026\nidImpianto;nome\n1;Citt\xe0\n', 'latin1')
  assert.equal(parseCsv(latin, ['idimpianto']).rows[0]!.nome, 'Citt\u00e0')
  assert.equal(parseCsv(bytes('2026-09-01\nidImpianto;nome\n1;Test\n'), ['idimpianto']).sourceDate, '2026-09-01')
  assert.equal(parseCsv(bytes('2026-09-01\nidImpianto|nome\n1|Test\n'), ['idimpianto']).rows[0]!.nome, 'Test')
  assert.equal(parseCsv(bytes('2026-09-01\nidImpianto|nome\n1|"Test" SRL\n'), ['idimpianto']).rows[0]!.nome, '"Test" SRL')
  assert.equal(parseCsv(bytes('2026-09-01\nidImpianto|nome\n1|"Test|SRL"\n'), ['idimpianto']).rows[0]!.nome, 'Test|SRL')
})

test('non riallinea righe malformate; tollera solo meno dell uno per cento con conteggio esplicito', () => {
  const header = '2026-09-01\nidImpianto|nome\n'
  const valid = Array.from({ length: 100 }, (_, i) => `${i + 1}|Test`).join('\n')
  const malformed = '\n999|Nome|con separatore non protetto'
  const result = parseCsv(bytes(header + valid + malformed), ['idimpianto'])
  assert.equal(result.rows.length, 100)
  assert.equal(result.skippedRows, 1)
  assert.throws(() => parseCsv(bytes(header + '1|Test' + malformed), ['idimpianto']), /malformato/)
})
