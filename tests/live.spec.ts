import { expect, test } from '@playwright/test'
import { resultFixture, stationFixtures, statusFixture } from './fixtures'
import { applyLiveDetail } from '../shared/live-details'

test.beforeEach(async ({ page }) => {
  await page.route('**://*.tile.openstreetmap.org/**', (route) => route.abort())
  await page.route('**/api/status', (route) => route.fulfill({
    json: { ...statusFixture, dataSource: 'live', sourceDate: null, lastRefreshAt: null },
  }))
  await page.route('**/api/stations?*', (route) => route.fulfill({
    json: resultFixture({
      dataSource: 'live', sourceDate: null, updatedAt: new Date().toISOString(), cacheMaxAgeSeconds: 120,
      stations: stationFixtures.map((station) => ({ ...station, reportedAtScope: 'station' })),
    }),
  }))
  await page.route(/\/api\/stations\/\d+\?/, (route) => {
    const id = Number(new URL(route.request().url()).pathname.split('/').at(-1))
    const station = stationFixtures.find((item) => item.id === id)!
    return route.fulfill({
      json: {
        id, name: station.name, address: station.address, brand: station.brand, updatedAt: new Date().toISOString(),
        prices: [{ fuel: 'benzina', price: 1.999, self: true, reportedAt: new Date().toISOString() }],
      },
    })
  })
})

test('selected current detail replaces the search price in map, list and 30 litre calculator', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('estimated-cost')).toHaveText('59,97\u00a0€')
  await expect(page.locator('.price-marker.is-selected')).toHaveText('1,999')
  await expect(page.locator('#station-101-1')).toContainText('Comunicazione prezzo')
  await expect(page.locator('#station-102-1')).toContainText('Ultima comunicazione impianto')
  await expect(page.locator('.source-update')).toContainText('Consultazione MIMIT:')
  await expect(page.locator('body')).not.toContainText('Dati riferiti alle 08:00')
})

test('manual refresh bypasses the short server cache and does not retain prices after an upstream failure', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('estimated-cost')).toHaveText('59,97\u00a0€')
  let refreshed = false
  await page.route('**/api/stations?*', (route) => {
    refreshed = new URL(route.request().url()).searchParams.get('refresh') === '1'
    return route.fulfill({ status: 502, json: { error: 'MIMIT corrente non disponibile' } })
  })
  await page.getByRole('button', { name: 'Aggiorna prezzi', exact: true }).click()
  await expect(page.getByTestId('station-card')).toHaveCount(0)
  await expect(page.getByTestId('estimated-cost')).toHaveText('—')
  await expect(page.locator('.error-state')).toContainText('MIMIT corrente non disponibile')
  expect(refreshed).toBe(true)
})

test('a vanished price is removed instead of retaining the previous amount', async ({ page }) => {
  await page.route('**/api/stations/101?*', (route) => route.fulfill({
    json: { id: 101, name: 'Fixture', address: 'Via test', brand: 'Fixture', updatedAt: new Date().toISOString(), prices: [] },
  }))
  await page.goto('/')
  await expect(page.getByTestId('station-card')).toHaveCount(2)
  await expect(page.getByTestId('estimated-cost')).toHaveText('—')
  await expect(page.getByText('Il prezzo selezionato non è più presente', { exact: false })).toBeVisible()
})

test('failed detail lookup is explicit and suspends the calculator', async ({ page }) => {
  await page.route('**/api/stations/101?*', (route) => route.fulfill({
    status: 502, json: { error: 'Scheda remota non disponibile' },
  }))
  await page.goto('/')
  await expect(page.getByRole('alert')).toContainText('Dettaglio MIMIT non disponibile')
  await expect(page.getByTestId('estimated-cost')).toHaveText('—')
  await expect(page.getByTestId('station-card')).toHaveCount(3)
})

test('detail responses for a previous selection cannot overwrite the current selection', async ({ page }) => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/api/stations/101?*', async (route) => {
    await gate
    await route.fulfill({ json: {
      id: 101, name: 'Obsolete request fixture', address: '', brand: '', updatedAt: new Date().toISOString(),
      prices: [{ fuel: 'benzina', self: true, price: 0.111, reportedAt: new Date().toISOString() }],
    } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: /Seleziona Fixture Roma Centro/ }).click()
  await expect(page.getByTestId('estimated-cost')).toHaveText('59,97\u00a0€')
  release()
  await expect(page.locator('.price-marker.is-selected')).toHaveText('1,999')
  await expect(page.locator('.calculator-copy')).toContainText('Fixture Roma Centro')
  await expect(page.locator('.calculator-copy')).not.toContainText('Obsolete')
})

test('merging details keeps service modes, units and current date distinct', () => {
  const station = stationFixtures[0]!
  const result = resultFixture({
    stations: [station, { ...station, self: false, price: 2.3 }],
  })
  const updated = applyLiveDetail(result, {
    id: station.id, name: station.name, brand: station.brand, address: station.address, updatedAt: new Date().toISOString(),
    prices: [
      { fuel: 'benzina', self: true, price: 1.95, reportedAt: new Date().toISOString() },
      { fuel: 'benzina', self: false, price: 2.15, reportedAt: new Date().toISOString() },
      { fuel: 'metano', self: false, price: 1.2, reportedAt: new Date().toISOString() },
    ],
  }, 'benzina')
  expect(updated.stations.map((item) => item.price)).toEqual([1.95, 2.15])
  expect(updated.stations.every((item) => item.reportedAtScope === 'price' && item.unit === 'L')).toBe(true)
  expect(updated.cheapestPrice).toBe(1.95)
})
