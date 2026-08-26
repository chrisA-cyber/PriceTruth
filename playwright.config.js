import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.PLAYWRIGHT_PORT || 4781);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './test/e2e',
  timeout: 30_000,
  expect: { timeout: 7_500 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  // Keep the shared local server deterministic and below public burst limits.
  // A developer workstation may expose many logical CPUs, which otherwise
  // turns two projects into a noisy 10+ worker fan-out.
  workers: 2,
  reporter: process.env.CI
    ? [['line'], ['html', { outputFolder: 'playwright-report', open: 'never' }]]
    : 'list',
  outputDir: 'test-results',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    reducedMotion: 'reduce',
  },
  projects: [
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'chromium-mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'node src/server.js',
    url: `${baseURL}/api/health`,
    timeout: 30_000,
    // Browser gates must exercise the current checkout/auth/data contracts,
    // never a stale developer process left on this port. Owning the test
    // server also gives Playwright a deterministic teardown path locally.
    reuseExistingServer: false,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      PRICETRUTH_DB: ':memory:',
      EMAIL_TRANSPORT: 'memory',
      DISABLE_WORKER: '1',
      EXIT_WITH_PARENT: '1',
      TEST_SERVER_IDLE_EXIT_MS: '20000',
    },
  },
});
