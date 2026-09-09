import { expect, test } from '@playwright/test'
import { mockBrowserPush, pushCalls, resultFixture, stationFixtures, statusFixture } from './fixtures'

test('Pages uses repository assets, current API prices without catalog tiles and scoped push registration', async ({ page, request }) => {
  await mockBrowserPush(page)
  await page.route('**://*.tile.openstreetmap.org/**', (route) => route.abort())
  await page.route('https://pieno-api.example.test/api/status', (route) => route.fulfill({
    json: { ...statusFixture, dataSource: 'live', sourceDate: null, lastRefreshAt: null },
  }))
  let catalogRequests = 0
  await page.route('**/api/catalog/**', (route) => {
    catalogRequests++
    return route.abort()
  })
  await page.route('https://pieno-api.example.test/api/stations?*', (route) => route.fulfill({
    json: resultFixture({
      dataSource: 'live', sourceDate: null, updatedAt: new Date().toISOString(),
      stations: [...stationFixtures].sort((a, b) => a.price - b.price),
    }),
  }))
  await page.route('https://pieno-api.example.test/api/stations/103?*', (route) => route.fulfill({
    json: {
      ...stationFixtures[2], updatedAt: new Date().toISOString(),
      prices: [{ fuel: 'benzina', self: true, price: 1.299, reportedAt: new Date().toISOString() }],
    },
  }))
  await page.route('https://pieno-api.example.test/api/push/public-key', (route) => route.fulfill({ json: { publicKey: 'AQIDBA' } }))
  await page.route('https://pieno-api.example.test/api/push/subscriptions', (route) => route.fulfill({
    status: 201, json: { id: 'fixture-monitor', token: 'fixture-token' },
  }))
  await page.goto('./')
  await expect(page.getByTestId('station-card')).toHaveCount(3)
  await expect(page.getByRole('link', { name: 'Pieno, pagina iniziale' })).toHaveAttribute('href', '/carburanti-vicino/')
  await expect(page.getByTestId('estimated-cost')).toHaveText('38,97\u00a0€')
  expect(catalogRequests).toBe(0)
  await expect(page.locator('.source-update')).toContainText('Consultazione MIMIT:')
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
