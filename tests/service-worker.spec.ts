import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { expect, test } from '@playwright/test'

const workerSource = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8')

function workerHarness(base = '/') {
  const listeners = new Map<string, (event: unknown) => void>()
  const notifications: { title: string; options: { data: { url: string } } }[] = []
  const opened: string[] = []
  const context = {
    URL,
    self: {
      location: { origin: 'https://pieno.example.test' },
      addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener),
      registration: {
        scope: `https://pieno.example.test${base}`,
        showNotification: async (title: string, options: { data: { url: string } }) => { notifications.push({ title, options }) },
      },
      clients: {
        matchAll: async () => [],
        openWindow: async (url: string) => { opened.push(url) },
      },
    },
  }
  vm.runInNewContext(workerSource, context)
  return { listeners, notifications, opened }
}

test('worker accepts real payloads but restricts click URLs to safe same-origin paths', async () => {
  for (const [url, expected] of [
    ['/?lat=41.9&lon=12.4&station=101', '/?lat=41.9&lon=12.4&station=101'],
    ['https://other.example.test', '/'],
    ['//other.example.test', '/'],
    ['/\\other.example.test', '/'],
    ['javascript:alert(1)', '/'],
  ]) {
    const harness = workerHarness()
    const promises: Promise<unknown>[] = []
    harness.listeners.get('push')?.({
      data: { json: () => ({ title: 'Avviso fixture', body: 'Possibile anomalia fixture', tag: 'fixture', url }) },
      waitUntil: (promise: Promise<unknown>) => promises.push(promise),
    })
    await Promise.all(promises)
    expect(harness.notifications).toHaveLength(1)
    expect(harness.notifications[0].options.data.url).toBe(expected)
    harness.listeners.get('notificationclick')?.({
      notification: { data: { url }, close: () => {} },
      waitUntil: (promise: Promise<unknown>) => promises.push(promise),
    })
    await Promise.all(promises)
    expect(harness.opened).toEqual([`https://pieno.example.test${expected}`])
  }
})

test('worker ignores malformed payloads and does not cache API responses, tiles or prices', () => {
  const harness = workerHarness()
  harness.listeners.get('push')?.({ data: { json: () => { throw new Error('invalid fixture') } } })
  harness.listeners.get('push')?.({ data: { json: () => ({ invalid: true }) } })
  expect(harness.notifications).toHaveLength(0)
  expect(harness.listeners.has('fetch')).toBe(false)
})

test('Pages worker keeps icons and notification links inside the repository scope', async () => {
  const harness = workerHarness('/carburanti-vicino/')
  const promises: Promise<unknown>[] = []
  harness.listeners.get('push')?.({
    data: { json: () => ({ title: 'Fixture', body: 'Fixture', url: '/another-app/?station=1' }) },
    waitUntil: (promise: Promise<unknown>) => promises.push(promise),
  })
  await Promise.all(promises)
  expect(harness.notifications[0].options.data.url).toBe('/carburanti-vicino/')
})
