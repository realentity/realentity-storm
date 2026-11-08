import { defineConfig, devices } from "@playwright/test";
import { STORAGE_STATE, WEB_PORT, WEB_URL, API_PORT } from "./src/stack";

/**
 * Browser tests against the composed stack (README test strategy: PRs to main). Global setup starts PostgreSQL, the
 * api and the worker; the web app runs on Vite's dev server, proxying /api (and the events socket) to that api.
 * One worker: the tests share one database and the kill switch is global.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  globalSetup: "./src/global-setup.ts",
  use: {
    baseURL: WEB_URL,
    storageState: STORAGE_STATE,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: `pnpm --filter @realentity/storm-web exec vite --port ${WEB_PORT} --strictPort`,
    url: WEB_URL,
    env: { API_HOST: "127.0.0.1", API_PORT: String(API_PORT) },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
