import { defineConfig, devices } from '@playwright/test'

const pages = process.env.PAGES_E2E === '1'

export default defineConfig({
  testDir: './tests',
  testMatch: pages ? '**/pages.spec.ts' : '**/{app,push,service-worker}.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : 1,
  reporter: 'list',
  use: {
    baseURL: pages ? 'http://localhost:5173/carburanti-vicino/' : 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
    // System proxy auto-discovery can stall localhost requests in Windows Edge.
    launchOptions: { args: ['--no-proxy-server'] },
  },
  webServer: {
    command: pages ? 'npm run preview -- --host 127.0.0.1 --port 5173 --strictPort' : 'npm run dev:client -- --port 5173',
    url: pages ? 'http://localhost:5173/carburanti-vicino/' : 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
