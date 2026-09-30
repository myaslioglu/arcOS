import { defineConfig, devices } from "@playwright/test";

// The end-to-end smoke suite (e2e/). It runs against a production build served by `next start`, never `next dev`:
// build first (`npm run build`), then `npm run test:e2e` starts the server below and stops it afterwards.
const PORT = 3100;

export default defineConfig({
  testDir: "e2e",
  // Every wait is bounded: a test, an assertion, and the server's start.
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["github"], ["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    // The windows and the launcher animate with framer-motion, which follows this setting.
    contextOptions: { reducedMotion: "reduce" },
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // CI installs the browser this Playwright version expects (`npx playwright install --with-deps chromium`).
        // Locally, E2E_CHROMIUM_PATH can point at a Chromium that is already installed instead.
        launchOptions: process.env.E2E_CHROMIUM_PATH ? { executablePath: process.env.E2E_CHROMIUM_PATH } : {},
      },
    },
  ],
  webServer: {
    command: `npm run start -w @arcos/web -- --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
    stderr: "pipe",
  },
});
