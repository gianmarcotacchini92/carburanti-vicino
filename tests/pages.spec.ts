import { expect, test } from '@playwright/test'
import { cellFor } from '../shared/catalog'
import { mockBrowserPush, pushCalls, stationFixtures, statusFixture } from './fixtures'

test('Pages uses repository assets, external catalog API and scoped push registration', async ({ page, request }) => {
  await mockBrowserPush(page)
  await page.route('**://*.tile.openstreetmap.org/**', (route) => route.abort())
  await page.route('https://pieno-api.example.test/api/status', (route) => route.fulfill({
    json: { ...statusFixture, catalogVersion: 'a'.repeat(32) },
  }))
  await page.route('https://pieno-api.example.test/api/catalog/**', (route) => {
    const cell = new URL(route.request().url()).pathname.split('/').at(-1)
    return route.fulfill({
      json: stationFixtures.filter((station) => cellFor(station.lat, station.lon) === cell).map((station) => ({
        ...station,
        prices: [{ fuel: 'benzina', self: station.self, price: station.price, reportedAt: station.reportedAt }],
      })),
    })
  })
  await page.route('https://pieno-api.example.test/api/push/public-key', (route) => route.fulfill({ json: { publicKey: 'AQIDBA' } }))
  await page.route('https://pieno-api.example.test/api/push/subscriptions', (route) => route.fulfill({
    status: 201, json: { id: 'fixture-monitor', token: 'fixture-token' },
  }))
  await page.goto('./')
  await expect(page.getByTestId('station-card')).toHaveCount(3)
  await expect(page.getByRole('link', { name: 'Pieno, pagina iniziale' })).toHaveAttribute('href', '/carburanti-vicino/')
  await expect(page.getByTestId('estimated-cost')).toHaveText('38,97\u00a0€')
  const stylesheet = page.locator('link[rel="stylesheet"]').first()
  await expect(stylesheet).toHaveAttribute('href', /^\/carburanti-vicino\/assets\//)
  expect((await request.get('/carburanti-vicino/fonts/dm-sans-latin.woff2')).status()).toBe(200)
  const manifest = await request.get('/carburanti-vicino/manifest.webmanifest').then((response) => response.json())
  expect(manifest.start_url).toBe('./')
  expect(manifest.scope).toBe('./')
  await page.getByRole('button', { name: /Attiva avvisi/ }).click()
  await expect(page.getByText('Avvisi attivi per la zona salvata', { exact: true })).toBeVisible()
  expect(await pushCalls(page)).toContain('register:/carburanti-vicino/sw.js')
})
