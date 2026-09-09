import { expect, test } from '@playwright/test'
import { mockData, resultFixture, stationFixtures, statusFixture } from './fixtures'

test.beforeEach(async ({ page }) => { await mockData(page) })

test('shows a clearly named initial area, sorted official prices and synchronized selection', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Roma · zona iniziale' })).toBeVisible()
  await expect(page.getByTestId('station-card')).toHaveCount(3)
  await expect(page.getByTestId('station-card').first()).toContainText('Fixture prezzo insolito')
  await expect(page.getByTestId('estimated-cost')).toHaveText('53,97 €')
  await page.getByRole('button', { name: /Seleziona Fixture Roma Centro/ }).click()
  await expect(page.locator('.price-marker.is-selected')).toHaveText('1,849')
  await expect(page.getByTestId('estimated-cost')).toHaveText('55,47 €')
  await page.locator('.price-marker').filter({ hasText: '1,299' }).click()
  await expect(page.getByRole('button', { name: /Seleziona Fixture prezzo insolito/ })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('estimated-cost')).toHaveText('38,97 €')
  await page.getByLabel('Ordina distributori').selectOption('distance')
  await expect(page.getByTestId('station-card').first()).toContainText('Fixture Roma Centro')
  await expect(page.locator('.leaflet-control-attribution')).toContainText('OpenStreetMap')
})

test('address geocoding runs only on submit, then asks the user to choose a result', async ({ page }) => {
  let count = 0
  await page.route('**/api/geocode?*', (route) => {
    count++
    return route.fulfill({ json: { results: [
      { lat: 45.4642, lon: 9.19, label: 'Milano, Lombardia, Italia' },
      { lat: 45.47, lon: 9.2, label: 'Via Milano, Monza, Italia' },
    ] } })
  })
  await page.goto('/')
  await page.getByLabel('Indirizzo o città').fill('Milano')
  await page.waitForTimeout(150)
  expect(count).toBe(0)
  await page.getByRole('button', { name: 'Cerca', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Milano, Lombardia, Italia', exact: true })).toBeVisible()
  expect(count).toBe(1)
  const request = page.waitForRequest((req) => req.url().includes('/api/stations?lat=45.4642&lon=9.19'))
  await page.getByRole('button', { name: 'Milano, Lombardia, Italia', exact: true }).click()
  await request
  await expect(page.getByRole('heading', { name: 'Milano, Lombardia, Italia' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Via Milano, Monza, Italia' })).toHaveCount(0)
})

test('address empty results and geolocation denial are explained without claiming GPS', async ({ page }) => {
  await page.route('**/api/geocode?*', (route) => route.fulfill({ json: { results: [] } }))
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition: (_success: unknown, error: (value: { code: number }) => void) => error({ code: 1 }) },
    })
  })
  await page.goto('/')
  await page.getByLabel('Indirizzo o città').fill('Non esiste')
  await page.getByLabel('Indirizzo o città').press('Enter')
  await expect(page.getByText('Nessun indirizzo trovato.', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Usa la mia posizione' }).click()
  await expect(page.getByRole('alert')).toContainText('Accesso alla posizione negato')
  await expect(page.getByRole('heading', { name: 'Roma · zona iniziale' })).toBeVisible()
})

test('filter changes immediately clear mismatched data and errors can be retried', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('station-card')).toHaveCount(3)
  let fail = true
  await page.route('**/api/stations?*', async (route) => {
    if (fail) await route.fulfill({ status: 503, json: { error: 'Fonte fixture non disponibile' } })
    else await route.fulfill({ json: resultFixture() })
  })
  await page.getByRole('button', { name: 'Gasolio', exact: true }).click()
  await expect(page.getByTestId('station-card')).toHaveCount(0)
  await expect(page.locator('.price-marker')).toHaveCount(0)
  await expect(page.getByRole('alert')).toContainText('Fonte fixture non disponibile')
  await expect(page.getByTestId('estimated-cost')).toHaveText('—')
  fail = false
  await page.getByRole('button', { name: 'Riprova', exact: true }).click()
  await expect(page.getByTestId('station-card')).toHaveCount(3)
  const request = page.waitForRequest((req) => req.url().includes('/api/stations?') && req.url().includes('radius=10'))
  await page.getByLabel('Raggio di ricerca').selectOption('10')
  await request
})

test('calculator rejects empty, negative and zero quantities; methane always uses kilograms', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('estimated-cost')).toHaveText('53,97 €')
  const quantity = page.getByLabel('Quantità in litri')
  for (const input of ['', '0', '-2']) {
    await quantity.fill(input)
    await expect(page.getByTestId('estimated-cost')).toHaveText('—')
    await expect(page.getByRole('alert')).toContainText('quantità valida')
  }
  await quantity.fill('40')
  await expect(page.getByTestId('estimated-cost')).toHaveText('71,96 €')
  await page.getByRole('button', { name: 'Metano', exact: true }).click()
  await expect(page.getByLabel('Quantità in kg')).toHaveValue('40')
  await expect(page.getByText('Il metano si vende a kg, non a litri.')).toBeVisible()
  await expect(page.getByTestId('station-card').first()).toContainText('€/kg')
  await expect(page.locator('body')).not.toContainText('€/L')
  await expect(page.getByTestId('estimated-cost')).toHaveText('71,96 €')
})

test('stale and anomaly labels are cautious and methodology explains the other-station threshold', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('Dato oltre 7 giorni', { exact: true })).toBeVisible()
  await expect(page.getByText('Possibile anomalia', { exact: true }).last()).toBeVisible()
  await page.getByRole('button', { name: /Seleziona Fixture prezzo insolito/ }).click()
  await expect(page.getByText('Prezzo insolitamente basso, possibile errore di comunicazione. Verifica alla pompa.')).toBeVisible()
  await page.getByRole('button', { name: /Buono a sapersi/ }).click()
  await expect(page.locator('#info-content')).toContainText('almeno il 25%')
  await expect(page.locator('#info-content')).toContainText('almeno 5 altri')
  await expect(page.locator('#info-content')).toContainText('più vecchi di 7 giorni')
  await expect(page.locator('#info-content')).toContainText('né un risparmio garantito')
})

test('deep links restore the area, fuel, service, radius and selected station', async ({ page }) => {
  await page.goto('/?lat=45.4642&lon=9.19&radius=10&fuel=metano&service=servito&station=103')
  await expect(page.getByRole('heading', { name: 'Zona dal link condiviso' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Metano', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: 'Servito', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByLabel('Raggio di ricerca')).toHaveValue('10')
  await expect(page.getByRole('button', { name: /Seleziona Fixture prezzo insolito/ })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByLabel('Quantità in kg')).toHaveValue('30')
})

test('self and attended prices at the same station have independent selection, totals and deep links', async ({ page }) => {
  const station = stationFixtures[0]!
  await page.route('**/api/stations?*', (route) => route.fulfill({
    json: resultFixture({
      stations: [station, { ...station, self: false, price: 2.099 }],
      total: 2,
    }),
  }))
  await page.goto('/?service=all')
  await expect(page.getByTestId('station-card')).toHaveCount(2)
  const attended = page.getByRole('button', { name: /Seleziona Fixture Roma Nord, 2,099/ })
  const self = page.getByRole('button', { name: /Seleziona Fixture Roma Nord, 1,799/ })
  await attended.click()
  await expect(attended).toHaveAttribute('aria-pressed', 'true')
  await expect(self).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByTestId('estimated-cost')).toHaveText('62,97\u00a0€')
  await expect(page.locator('.price-marker.is-selected')).toHaveCount(1)
  await expect(page.locator('.price-marker.is-selected')).toHaveText('2,099')
  await expect(page).toHaveURL(/station=101&stationSelf=0/)
  await page.reload()
  await expect(attended).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('estimated-cost')).toHaveText('62,97\u00a0€')
  await self.click()
  await expect(page.getByTestId('estimated-cost')).toHaveText('53,97\u00a0€')
})

test('first official download is not replaced with fabricated stations and polls until ready', async ({ page }) => {
  let ready = false
  await page.route('**/api/status', (route) => route.fulfill({ json: { ...statusFixture, ready, refreshing: !ready } }))
  await page.clock.install()
  await page.goto('/')
  await expect(page.getByText('Prepariamo il primo viaggio.')).toBeVisible()
  await expect(page.getByTestId('station-card')).toHaveCount(0)
  ready = true
  await page.clock.fastForward(16000)
  await expect(page.getByTestId('station-card')).toHaveCount(3)
})

test('empty data remains empty, with an explicit radius expansion action', async ({ page }) => {
  await page.route('**/api/stations?*', (route) => route.fulfill({
    json: resultFixture({ stations: [], total: 0, medianPrice: null, cheapestPrice: null }),
  }))
  await page.goto('/')
  await expect(page.getByText('Qui non abbiamo trovato prezzi.')).toBeVisible()
  await expect(page.getByTestId('station-card')).toHaveCount(0)
  await page.getByRole('button', { name: 'Amplia il raggio' }).click()
  await expect(page.getByLabel('Raggio di ricerca')).toHaveValue('10')
})

test('small-screen map/list views do not overflow and preserve selection', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.locator('.price-marker')).toHaveCount(stationFixtures.length)
  await expect(page.getByRole('region', { name: 'Mappa dei distributori' })).toBeVisible()
  await page.getByRole('button', { name: 'Elenco (3)' }).click()
  await expect(page.getByTestId('station-card')).toHaveCount(3)
  await page.getByRole('button', { name: /Seleziona Fixture Roma Centro/ }).click()
  await page.getByRole('button', { name: 'Mappa', exact: true }).click()
  await expect(page.locator('.price-marker.is-selected')).toHaveText('1,849')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('prices refresh every minute only while visible, then refresh on return', async ({ page }) => {
  let requests = 0
  await page.clock.install()
  await page.route('**/api/stations?*', (route) => {
    requests++
    return route.fulfill({ json: resultFixture() })
  })
  await page.goto('/')
  await expect(page.getByTestId('station-card')).toHaveCount(3)
  const firstCount = requests
  await page.clock.fastForward(60 * 1000)
  await expect.poll(() => requests).toBe(firstCount + 1)
  await expect(page.getByTestId('station-card')).toHaveCount(3)
  await page.evaluate(() => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }))
  await page.clock.fastForward(10 * 60 * 1000)
  expect(requests).toBe(firstCount + 1)
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect.poll(() => requests).toBe(firstCount + 2)
})

test('in-flight filter loading never displays the preceding fuel prices', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('station-card')).toHaveCount(3)
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/api/stations?*', async (route) => {
    await gate
    await route.fulfill({ json: resultFixture() })
  })
  await page.getByRole('button', { name: 'GPL', exact: true }).click()
  await expect(page.getByTestId('station-card')).toHaveCount(0)
  await expect(page.locator('.price-marker')).toHaveCount(0)
  await expect(page.getByTestId('estimated-cost')).toHaveText('—')
  await expect(page.getByText('Un attimo, cerchiamo i prezzi.')).toBeVisible()
  release()
  await expect(page.getByTestId('station-card')).toHaveCount(3)
})

test('source names render as text, not marker HTML', async ({ page }) => {
  await page.route('**/api/stations?*', (route) => route.fulfill({
    json: resultFixture({
      stations: [{ ...stationFixtures[0], name: '<img src=x onerror=alert(1)>' }], total: 1,
    }),
  }))
  await page.goto('/')
  await expect(page.getByTestId('station-card')).toContainText('<img src=x onerror=alert(1)>')
  await expect(page.getByTestId('station-card').locator('img')).toHaveCount(0)
  await expect(page.locator('.price-marker')).toHaveText('1,799')
  await expect(page.locator('.price-marker img')).toHaveCount(0)
})

test('dense areas declutter price labels without removing stations and keep the selected price visible', async ({ page }) => {
  const denseStations = Array.from({ length: 20 }, (_, index) => ({
    ...stationFixtures[0], id: 200 + index, name: `Fixture densa ${index}`,
    lat: 41.902 + index * 0.0004, lon: 12.492 + index * 0.0004, price: 1.7 + index * 0.001,
  }))
  await page.route('**/api/stations?*', (route) => route.fulfill({
    json: resultFixture({ stations: denseStations, total: denseStations.length }),
  }))
  await page.goto('/')
  await expect(page.getByTestId('station-card')).toHaveCount(20)
  await expect(page.getByText('Ingrandisci per vedere altri prezzi')).toBeVisible()
  expect(await page.locator('.price-marker').count()).toBeLessThan(20)
  await page.getByRole('button', { name: /Seleziona Fixture densa 19,/ }).click()
  await expect(page.locator('.price-marker.is-selected')).toHaveText('1,719')
  await page.getByRole('button', { name: 'Ingrandisci la mappa' }).click()
  await expect(page.locator('.price-marker.is-selected')).toHaveText('1,719')
})

test.describe('official source attribution', () => {
  test.use({ timezoneId: 'America/Los_Angeles' })

  test('attributes the portal and clearly distinguishes legacy snapshot dates from current queries', async ({ page }) => {
    await page.route('**/api/status', (route) => route.fulfill({
      json: { ...statusFixture, sourceDate: '2026-09-06', lastRefreshAt: '2026-09-07T11:00:00+02:00' },
    }))
    await page.route('**/api/stations?*', (route) => route.fulfill({ json: resultFixture({ sourceDate: '2026-09-06' }) }))
    await page.goto('/')
    await expect(page.locator('.source-update')).toContainText('Dati riferiti alle 08:00 del 06 set 2026')
    const footer = page.getByRole('contentinfo')
    await expect(footer).toContainText('Fonte: Ministero delle Imprese e del Made in Italy — Osservaprezzi Carburanti · Servizio non ufficiale')
    await expect(footer.getByRole('link', { name: /Ministero delle Imprese/ })).toHaveAttribute('href', 'https://carburanti.mise.gov.it/ospzSearch/')
    await page.getByRole('button', { name: /Buono a sapersi/ }).click()
    await expect(page.locator('#info-content')).toContainText('non i CSV che fotografano il giorno precedente')
    await expect(page.locator('#info-content')).toContainText('Una cache di massimo 2 minuti')
    await expect(page.locator('#info-content')).toContainText('Dati riferiti alle 08:00 del 06 set 2026')
    await expect(page.locator('#info-content').getByRole('link', { name: /Apri Osservaprezzi MIMIT/ })).toBeVisible()
  })
})
