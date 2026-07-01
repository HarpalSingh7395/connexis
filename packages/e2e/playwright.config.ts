import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './src',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1, // Sequential execution prevents cross-test BroadcastChannel pollution
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5175',
    trace: 'on-first-retry',
    headless: true
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ],
  webServer: {
    command: 'npm run dev -- --port 5175 --force',
    url: 'http://localhost:5175',
    reuseExistingServer: true,
    cwd: '/home/harpal/Documents/personal/connexis-demo',
    timeout: 10000
  }
});
