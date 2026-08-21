// @ts-check
import { defineConfig, devices } from '@playwright/test';

/**
 * Configuration Playwright E2E - P2P Mesh Workspace (2025/2026)
 * Persona 7.2 : Multi-Contextes Isolés, Injection Média Synthétique & Zero-Server P2P
 */
export default defineConfig({
  testDir: './test/e2e',
  timeout: 45000,
  expect: {
    timeout: 10000
  },
  fullyParallel: false,
  retries: 1,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:8080',
    trace: 'on-first-retry',
    video: 'on-first-retry',
    headless: true,
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        '--allow-loopback-in-peer-connection',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding'
      ]
    }
  },
  webServer: {
    command: 'npx http-server ./WebApp -p 8080 -c-1',
    port: 8080,
    reuseExistingServer: !process.env.CI,
    timeout: 15000
  }
});
