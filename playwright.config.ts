import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:4321';

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: '.data/playwright',
  reporter: 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: process.env.PLAYWRIGHT_USE_EXISTING_SERVER === '1'
    ? undefined
    : {
        command: 'npm run dev -- --host 127.0.0.1',
        env: { ...process.env, ASTRO_DEV_BACKGROUND: '0' },
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
