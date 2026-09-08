import type { Page } from '@playwright/test'
import type { Monitor, StationResult, StationsResponse, StatusResponse } from '../shared/types'

// Deliberately synthetic route fixtures: these never enter the application bundle.
export const stationFixtures: StationResult[] = [
  {
    id: 101, name: 'Fixture Roma Nord', brand: 'Marchio fixture', address: 'Via di prova 1', town: 'Roma',
    province: 'RM', lat: 41.908, lon: 12.491, distanceKm: 1.2, price: 1.799,
    self: true, unit: 'L', reportedAt: '2026-09-07T10:00:00+02:00', isStale: false,
    isAnomaly: false, discountPercent: 0, peerMedian: 1.829,
  },
  {
    id: 102, name: 'Fixture Roma Centro', brand: 'Marchio fixture', address: 'Via di prova 2', town: 'Roma',
    province: 'RM', lat: 41.9, lon: 12.497, distanceKm: 0.5, price: 1.849,
    self: true, unit: 'L', reportedAt: '2026-08-18T10:00:00+02:00', isStale: true,
    isAnomaly: false, discountPercent: 0, peerMedian: null,
  },
  {
    id: 103, name: 'Fixture prezzo insolito', brand: 'Marchio fixture', address: 'Via di prova 3', town: 'Roma',
    province: 'RM', lat: 41.91, lon: 12.516, distanceKm: 2.4, price: 1.299,
    self: true, unit: 'L', reportedAt: '2026-09-07T10:00:00+02:00', isStale: false,
    isAnomaly: true, discountPercent: 29, peerMedian: 1.829,
  },
]

export const statusFixture: StatusResponse = {
  ready: true, refreshing: false, lastRefreshAt: '2026-09-07T11:00:00+02:00',
  sourceDate: '2026-09-07', stationCount: 3, priceCount: 3, warning: null,
}

export const monitorFixture: Monitor = {
  lat: 45.4642, lon: 9.19, radius: 3, fuel: 'gasolio', service: 'servito', label: 'Milano · zona salvata fixture',
}

export function resultFixture(overrides: Partial<StationsResponse> = {}): StationsResponse {
  return {
    stations: stationFixtures, total: stationFixtures.length, medianPrice: 1.829, cheapestPrice: 1.299,
    updatedAt: statusFixture.lastRefreshAt, sourceDate: statusFixture.sourceDate, warning: null,
    analysis: { minimumPeers: 5, thresholdPercent: 25, freshnessDays: 7 }, ...overrides,
  }
}

export async function mockData(page: Page) {
  await page.route('**://*.tile.openstreetmap.org/**', (route) => route.abort())
  await page.route('**/api/status', (route) => route.fulfill({ json: statusFixture }))
  await page.route('**/api/stations?*', (route) => {
    const url = new URL(route.request().url())
    const metano = url.searchParams.get('fuel') === 'metano'
    const servito = url.searchParams.get('service') === 'servito'
    return route.fulfill({
      json: resultFixture({
        stations: stationFixtures.map((station) => ({
          ...station, unit: metano ? 'kg' : 'L', self: !servito,
        })),
      }),
    })
  })
}

export async function mockBrowserPush(page: Page, existingSubscription = false) {
  await page.addInitScript(({ existing }) => {
    const calls: string[] = []
    Object.defineProperty(window, '__pushCalls', { value: calls })
    Object.defineProperty(window, 'Notification', { configurable: true, value: class {
      static permission = 'default'
      static async requestPermission() {
        calls.push('permission')
        this.permission = 'granted'
        return 'granted'
      }
    } })
    Object.defineProperty(window, 'PushManager', { configurable: true, value: class {} })
    let subscribed = existing
    const subscription = {
      endpoint: 'https://push.example.test/fixture',
      toJSON: () => ({ endpoint: 'https://push.example.test/fixture', keys: { p256dh: 'fixture-key', auth: 'fixture-auth' } }),
      unsubscribe: async () => { calls.push('unsubscribe'); subscribed = false; return true },
    }
    const registration = {
      pushManager: {
        getSubscription: async () => subscribed ? subscription : null,
        subscribe: async (options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => {
          if (!options.userVisibleOnly || !(options.applicationServerKey instanceof Uint8Array)) throw new Error('Invalid push options')
          calls.push('subscribe')
          subscribed = true
          return subscription
        },
      },
    }
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        ready: Promise.resolve(registration),
        register: async (url: string) => { calls.push(`register:${url}`); return registration },
        getRegistration: async () => registration,
      },
    })
  }, { existing: existingSubscription })
}

export const pushCalls = (page: Page) => page.evaluate(() => (window as unknown as { __pushCalls: string[] }).__pushCalls)
