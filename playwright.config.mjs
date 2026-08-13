import { defineConfig } from '@playwright/test'

/**
 * Sign-in end-to-end tests (npm run test:e2e). Prerequisites, as for any
 * local run of the journey:
 *   forms-identity-api:  npm run dev  (:3010, with its docker mongo)
 *   forms-identity-ui:   npm run dev  (:3011)
 * The relying party on :3901 is started below if it is not already running,
 * so `npm run dev` covers it either way.
 * The journey is stateful, so the spec runs serially in one worker.
 */
export default defineConfig({
  testDir: './e2e',
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3011'
  },
  webServer: {
    command: 'node example/rp/index.mjs',
    url: 'http://localhost:3901',
    reuseExistingServer: true,
    timeout: 30_000
  }
})
