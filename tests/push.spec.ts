import { expect, test } from '@playwright/test'
import { mockBrowserPush, mockData, monitorFixture, pushCalls } from './fixtures'

test.beforeEach(async ({ page }) => {
  await mockData(page)
  await page.route('**/api/push/public-key', (route) => route.fulfill({ json: { publicKey: 'AQID' } }))
})

test('push asks permission only on gesture, persists only server-issued credentials and updates explicitly', async ({ page }) => {
  await mockBrowserPush(page)
  let postedMonitor: unknown
  let updated = 0
  await page.route('**/api/push/subscriptions', async (route) => {
    postedMonitor = route.request().postDataJSON().monitor
    expect(await page.evaluate(() => localStorage.getItem('pieno.push.v1'))).toBeNull()
    await route.fulfill({ status: 201, json: { id: 'fixture-id', token: 'fixture-token' } })
  })
  await page.route('**/api/push/subscriptions/fixture-id', (route) => {
    expect(route.request().headers().authorization).toBe('Bearer fixture-token')
    if (route.request().method() === 'PUT') {
      updated++
      expect(route.request().postDataJSON().monitor.fuel).toBe('gasolio')
    }
    return route.fulfill({ json: { monitor: route.request().postDataJSON()?.monitor ?? monitorFixture } })
  })
  await page.goto('/')
  expect(await pushCalls(page)).toEqual([])
  await page.getByRole('button', { name: 'Attiva avvisi', exact: true }).click()
  await expect(page.getByText('Avvisi attivati per questa zona.', { exact: false })).toBeVisible()
  expect(postedMonitor).toMatchObject({ label: 'Roma · zona iniziale', fuel: 'benzina', radius: 5 })
  expect(await pushCalls(page)).toEqual(['permission', 'register:/sw.js', 'subscribe'])
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pieno.push.v1') ?? 'null'))).toEqual({ id: 'fixture-id', token: 'fixture-token' })
  await page.getByRole('button', { name: 'Gasolio', exact: true }).click()
  await expect(page.getByTestId('saved-monitor')).toContainText('Benzina')
  expect(updated).toBe(0)
  await page.getByRole('button', { name: 'Aggiorna zona monitorata' }).click()
  await expect(page.getByTestId('saved-monitor')).toContainText('Gasolio')
  expect(updated).toBe(1)
})

test('failed POST rolls back a newly created subscription and never claims success', async ({ page }) => {
  await mockBrowserPush(page)
  await page.route('**/api/push/subscriptions', (route) => route.fulfill({ status: 503, json: { error: 'Push fixture non disponibile' } }))
  await page.goto('/')
  await page.getByRole('button', { name: 'Attiva avvisi', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Push fixture non disponibile')
  expect(await pushCalls(page)).toContain('unsubscribe')
  expect(await page.evaluate(() => localStorage.getItem('pieno.push.v1'))).toBeNull()
  await expect(page.getByText('Avvisi attivi per la zona salvata')).toHaveCount(0)
})

test('endpoint conflict removes the orphaned browser subscription and needs a fresh enable gesture', async ({ page }) => {
  await mockBrowserPush(page, true)
  let posts = 0
  await page.route('**/api/push/subscriptions', (route) => {
    posts++
    return posts === 1
      ? route.fulfill({ status: 409, json: { error: 'Endpoint già esistente' } })
      : route.fulfill({ status: 201, json: { id: 'new-fixture-id', token: 'new-fixture-token' } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Attiva avvisi', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Premi di nuovo')
  expect(posts).toBe(1)
  expect(await pushCalls(page)).toContain('unsubscribe')
  await page.getByRole('button', { name: 'Attiva avvisi', exact: true }).click()
  await expect(page.getByText('Avvisi attivi per la zona salvata')).toBeVisible()
  expect(posts).toBe(2)
  expect((await pushCalls(page)).filter((call) => call === 'subscribe')).toHaveLength(1)
})

test('restores the server monitor separately from search and deletes server before browser unsubscribe', async ({ page }) => {
  await mockBrowserPush(page, true)
  await page.addInitScript(() => localStorage.setItem('pieno.push.v1', JSON.stringify({ id: 'stored-id', token: 'stored-token' })))
  let failDelete = true
  await page.route('**/api/push/subscriptions/stored-id', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer stored-token')
    if (route.request().method() === 'DELETE') {
      expect(await pushCalls(page)).not.toContain('unsubscribe')
      await route.fulfill(failDelete ? { status: 503, json: { error: 'Delete fixture non disponibile' } } : { status: 204 })
    } else await route.fulfill({ json: { monitor: monitorFixture } })
  })
  await page.goto('/')
  await expect(page.getByTestId('saved-monitor')).toContainText('Milano · zona salvata fixture')
  await expect(page.getByRole('heading', { name: 'Roma · zona iniziale' })).toBeVisible()
  expect(await pushCalls(page)).toEqual([])
  await page.getByRole('button', { name: 'Disattiva avvisi' }).click()
  await expect(page.getByRole('alert')).toContainText('Avvisi non disattivati')
  await expect(page.getByTestId('saved-monitor')).toBeVisible()
  expect(await pushCalls(page)).toEqual([])
  failDelete = false
  await page.getByRole('button', { name: 'Disattiva avvisi' }).click()
  await expect(page.getByText('Avvisi disattivati.', { exact: false })).toBeVisible()
  expect(await pushCalls(page)).toEqual(['unsubscribe'])
  expect(await page.evaluate(() => localStorage.getItem('pieno.push.v1'))).toBeNull()
})

test('expired stored credentials are removed without requesting notification permission', async ({ page }) => {
  await mockBrowserPush(page)
  await page.addInitScript(() => localStorage.setItem('pieno.push.v1', JSON.stringify({ id: 'expired-id', token: 'expired-token' })))
  await page.route('**/api/push/subscriptions/expired-id', (route) => route.fulfill({ status: 404, json: { error: 'Non trovato' } }))
  await page.goto('/')
  await expect(page.getByText('Il monitoraggio salvato è scaduto', { exact: false })).toBeVisible()
  expect(await pushCalls(page)).toEqual([])
  expect(await page.evaluate(() => localStorage.getItem('pieno.push.v1'))).toBeNull()
})

test('server-side push unavailability is shown as an error without a browser subscription', async ({ page }) => {
  await mockBrowserPush(page)
  await page.route('**/api/push/public-key', (route) => route.fulfill({ status: 503, json: { error: 'Servizio push fixture non configurato' } }))
  await page.goto('/')
  await page.getByRole('button', { name: 'Attiva avvisi', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Servizio push fixture non configurato')
  expect(await pushCalls(page)).toEqual(['permission'])
  await expect(page.getByTestId('saved-monitor')).toHaveCount(0)
})

test('a partial browser unsubscribe failure clearly reports that the server monitor is already deleted', async ({ page }) => {
  await mockBrowserPush(page, true)
  await page.addInitScript(() => localStorage.setItem('pieno.push.v1', JSON.stringify({ id: 'partial-id', token: 'partial-token' })))
  await page.route('**/api/push/subscriptions/partial-id', (route) => route.fulfill(
    route.request().method() === 'DELETE' ? { status: 204 } : { json: { monitor: monitorFixture } },
  ))
  await page.goto('/')
  await expect(page.getByTestId('saved-monitor')).toBeVisible()
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration()
    const subscription = await registration?.pushManager.getSubscription()
    if (subscription) subscription.unsubscribe = async () => { throw new Error('Browser fixture offline') }
  })
  await page.getByRole('button', { name: 'Disattiva avvisi' }).click()
  await expect(page.getByRole('alert')).toContainText('Monitoraggio eliminato dal server, ma iscrizione browser non rimossa')
  await expect(page.getByTestId('saved-monitor')).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('pieno.push.v1'))).toBeNull()
  await expect(page.getByRole('button', { name: 'Rimuovi iscrizione browser' })).toBeVisible()
})
