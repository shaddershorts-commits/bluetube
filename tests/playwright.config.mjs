// tests/playwright.config.mjs
import { defineConfig, devices } from '@playwright/test';

const BASE = process.env.BASE_URL || 'http://localhost:8787';
const isRemote = !!process.env.BASE_URL;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 1,
  reporter: [['list']],
  use: {
    baseURL: BASE,
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, grepInvert: /@mobile/ },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'] },
      grep: /@mobile/,
    },
  ],
  webServer: isRemote ? undefined : {
    command: 'node e2e/static-server.mjs',
    url: BASE,
    reuseExistingServer: true,
    timeout: 15_000,
  },
});
